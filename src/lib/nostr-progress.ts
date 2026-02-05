import type { Identity } from './identity.js';
import type { ProgressUpdate } from './types.js';
import type { Event as NostrEvent } from 'nostr-tools';
import type { Subscription } from 'nostr-tools/relay';
import { finalizeEvent, verifyEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

const PROGRESS_KIND = 21079;
const CONNECT_TIMEOUT = 5000;

interface StateChangeData {
	state: string;
	raceId?: string;
	startTime?: number;
	countdownStart?: number;
	text?: string;
	results?: Record<string, unknown>;
}

export class NostrProgressSync {
	roomCode: string;
	identity: Identity;
	relayUrls: string[];

	relays: Relay[];
	subscriptions: Subscription[];
	connected: boolean;
	destroyed: boolean;

	onProgress: ((progress: ProgressUpdate) => void) | null;
	onStateChange: ((state: StateChangeData) => void) | null;

	seenEvents: Set<string>;
	trustedPubkeys: Set<string>;
	lastPublish: number;
	minPublishInterval: number;

	constructor(roomCode: string, identity: Identity, relayUrls: string[]) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.relayUrls = relayUrls;

		this.relays = [];
		this.subscriptions = [];
		this.connected = false;
		this.destroyed = false;

		this.onProgress = null;
		this.onStateChange = null;

		this.seenEvents = new Set();
		this.trustedPubkeys = new Set();
		this.lastPublish = 0;
		this.minPublishInterval = 400;
	}

	setTrustedPubkeys(pubkeys: string[]): void {
		this.trustedPubkeys = new Set(pubkeys.filter(Boolean));
	}

	isValidPubkeyHex(hex: string): boolean {
		return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex);
	}

	async connect(): Promise<boolean> {
		if (this.destroyed) return false;

		const connectPromises = this.relayUrls.map(async (url) => {
			try {
				const relay = await Promise.race([
					Relay.connect(url),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('Timeout')), CONNECT_TIMEOUT)
					)
				]);
				return relay;
			} catch {
				return null;
			}
		});

		const results = await Promise.all(connectPromises);
		this.relays = results.filter((r): r is Relay => r !== null);

		if (this.relays.length === 0) {
			return false;
		}

		this.connected = true;
		this.subscribe();
		return true;
	}

	subscribe(): void {
		const filter = {
			kinds: [PROGRESS_KIND],
			'#room': [this.roomCode],
			since: Math.floor(Date.now() / 1000) - 30
		};

		for (const relay of this.relays) {
			try {
				const sub = relay.subscribe([filter], {
					onevent: (event: NostrEvent) => this.handleEvent(event),
					oneose: () => {}
				});
				this.subscriptions.push(sub);
			} catch {}
		}
	}

	handleEvent(event: NostrEvent): void {
		if (this.seenEvents.has(event.id)) return;
		this.seenEvents.add(event.id);

		if (event.pubkey === this.identity.pubkeyHex) return;

		try {
			if (!verifyEvent(event)) return;

			const progress: ProgressUpdate = JSON.parse(event.content);
			if (progress.room !== this.roomCode) return;
			if (progress.pubkeyHex !== event.pubkey) return;
			if (!this.isValidPubkeyHex(progress.pubkeyHex)) return;
			if (this.trustedPubkeys.size > 0 && !this.trustedPubkeys.has(progress.pubkeyHex)) return;

			const age = Date.now() - progress.timestamp;
			if (age > 5000) return;

			if (this.onProgress) {
				this.onProgress(progress);
			}

			if (progress.state && this.onStateChange) {
				this.onStateChange({
					state: progress.state,
					raceId: progress.raceId,
					startTime: progress.startTime,
					countdownStart: progress.countdownStart,
					text: progress.text,
					results: progress.results
				});
			}
		} catch {}
	}

	async publish(data: Partial<ProgressUpdate> & { state?: string }, force = false): Promise<void> {
		if (this.destroyed || !this.connected) return;

		const now = Date.now();
		if (!force && now - this.lastPublish < this.minPublishInterval) return;
		this.lastPublish = now;

		const progress: Record<string, unknown> = {
			odyseeId: this.identity.odyseeId,
			pubkeyHex: this.identity.pubkeyHex,
			name: this.identity.name,
			color: this.identity.color,
			progress: data.progress || 0,
			wpm: data.wpm || 0,
			accuracy: data.accuracy || 100,
			finished: data.finished || false,
			room: this.roomCode,
			timestamp: now
		};

		if (data.state) {
			progress.state = data.state;
			progress.raceId = data.raceId;
			progress.startTime = data.startTime;
			progress.countdownStart = data.countdownStart;
			if (data.text) progress.text = data.text;
			if (data.results) progress.results = data.results;
		}

		const event = {
			kind: PROGRESS_KIND,
			created_at: Math.floor(now / 1000),
			tags: [['room', this.roomCode]],
			content: JSON.stringify(progress)
		};

		const signedEvent = finalizeEvent(event, this.identity.secretKey);

		for (const relay of this.relays) {
			try {
				await relay.publish(signedEvent);
				break;
			} catch {}
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.connected = false;

		for (const sub of this.subscriptions) {
			try { sub.close(); } catch {}
		}
		this.subscriptions = [];

		for (const relay of this.relays) {
			try { relay.close(); } catch {}
		}
		this.relays = [];

		this.seenEvents.clear();
	}
}
