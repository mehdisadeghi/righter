import type { Identity } from './identity.js';
import type { SignalMessage } from './types.js';
import type { Event as NostrEvent } from 'nostr-tools';
import type { Subscription } from 'nostr-tools/relay';
import { finalizeEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import * as nip44 from 'nostr-tools/nip44';

const SIGNALING_KIND = 21078;
const CONNECT_TIMEOUT = 5000;
const SIGNAL_TIMEOUT = 60000;

export class NostrSignaling {
	roomCode: string;
	identity: Identity;
	relayUrls: string[];

	relays: Relay[];
	subscriptions: Subscription[];
	connected: boolean;
	destroyed: boolean;

	onOffer: ((peerPubkey: string, sdp: RTCSessionDescriptionInit | undefined) => void) | null;
	onAnswer: ((peerPubkey: string, sdp: RTCSessionDescriptionInit | undefined) => void) | null;
	onCandidate: ((peerPubkey: string, candidate: RTCIceCandidateInit | undefined) => void) | null;
	onPeerJoined: ((peerPubkey: string) => void) | null;

	conversationKeys: Map<string, Uint8Array>;
	seenMessages: Set<string>;
	pendingCandidates: Map<string, RTCIceCandidateInit[]>;
	candidateFlushTimeout: ReturnType<typeof setTimeout> | null;

	constructor(roomCode: string, identity: Identity, relayUrls: string[]) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.relayUrls = relayUrls;

		this.relays = [];
		this.subscriptions = [];
		this.connected = false;
		this.destroyed = false;

		this.onOffer = null;
		this.onAnswer = null;
		this.onCandidate = null;
		this.onPeerJoined = null;

		this.conversationKeys = new Map();
		this.seenMessages = new Set();
		this.pendingCandidates = new Map();
		this.candidateFlushTimeout = null;
	}

	getConversationKey(peerPubkeyHex: string): Uint8Array {
		if (!this.conversationKeys.has(peerPubkeyHex)) {
			const key = nip44.v2.utils.getConversationKey(
				this.identity.secretKey,
				peerPubkeyHex
			);
			this.conversationKeys.set(peerPubkeyHex, key);
		}
		return this.conversationKeys.get(peerPubkeyHex)!;
	}

	encrypt(message: SignalMessage, peerPubkeyHex: string): string {
		const conversationKey = this.getConversationKey(peerPubkeyHex);
		return nip44.v2.encrypt(JSON.stringify(message), conversationKey);
	}

	decrypt(ciphertext: string, peerPubkeyHex: string): SignalMessage | null {
		try {
			const conversationKey = this.getConversationKey(peerPubkeyHex);
			const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
			return JSON.parse(plaintext);
		} catch (err) {
			console.warn('Failed to decrypt signaling message:', (err as Error).message);
			return null;
		}
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
			} catch (err) {
				console.warn(`Failed to connect to ${url}:`, (err as Error).message);
				return null;
			}
		});

		const results = await Promise.all(connectPromises);
		this.relays = results.filter((r): r is Relay => r !== null);

		if (this.relays.length === 0) {
			console.error('No relays connected');
			return false;
		}

		console.log(`Connected to ${this.relays.length} relays for signaling`);
		this.connected = true;

		this.subscribe();

		return true;
	}

	subscribe(): void {
		const pubkey = this.identity.pubkeyHex;
		console.log('Own pubkey:', pubkey, 'length:', pubkey?.length, 'valid:', this.isValidPubkeyHex(pubkey));

		if (!this.isValidPubkeyHex(pubkey)) {
			console.error('Invalid own pubkey format:', pubkey);
			return;
		}

		const filter = {
			kinds: [SIGNALING_KIND],
			'#p': [pubkey],
			since: Math.floor(Date.now() / 1000) - 60
		};

		console.log('Subscribing with filter:', JSON.stringify(filter));

		for (const relay of this.relays) {
			try {
				const sub = relay.subscribe([filter], {
					onevent: (event: NostrEvent) => this.handleEvent(event),
					oneose: () => {}
				});
				this.subscriptions.push(sub);
			} catch (err) {
				console.warn('Failed to subscribe:', (err as Error).message);
			}
		}
	}

	handleEvent(event: NostrEvent): void {
		if (this.seenMessages.has(event.id)) return;
		this.seenMessages.add(event.id);

		if (event.pubkey === this.identity.pubkeyHex) return;

		const message = this.decrypt(event.content, event.pubkey);
		if (!message) return;

		if (message.room !== this.roomCode) return;

		const age = Date.now() - message.timestamp;
		if (age > SIGNAL_TIMEOUT) {
			console.log('Ignoring stale signaling message:', age, 'ms old');
			return;
		}

		console.log('Received signaling:', message.type, 'from', event.pubkey.slice(0, 8));

		switch (message.type) {
			case 'offer':
				if (this.onOffer) {
					this.onOffer(event.pubkey, message.sdp);
				}
				break;
			case 'answer':
				if (this.onAnswer) {
					this.onAnswer(event.pubkey, message.sdp);
				}
				break;
			case 'candidate':
				if (this.onCandidate) {
					this.onCandidate(event.pubkey, message.candidate);
				}
				break;
			case 'candidates':
				if (this.onCandidate && message.candidates) {
					for (const candidate of message.candidates) {
						this.onCandidate(event.pubkey, candidate);
					}
				}
				break;
		}
	}

	isValidPubkeyHex(hex: string): boolean {
		return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex);
	}

	async publish(peerPubkeyHex: string, message: SignalMessage): Promise<void> {
		if (this.destroyed || !this.connected) return;

		if (!this.isValidPubkeyHex(peerPubkeyHex)) {
			console.warn('Invalid peer pubkey format:', peerPubkeyHex);
			return;
		}

		message.room = this.roomCode;
		message.timestamp = Date.now();

		const encrypted = this.encrypt(message, peerPubkeyHex);

		const event = {
			kind: SIGNALING_KIND,
			created_at: Math.floor(Date.now() / 1000),
			tags: [
				['p', peerPubkeyHex]
			],
			content: encrypted
		};

		const signedEvent = finalizeEvent(event, this.identity.secretKey);

		let published = 0;
		for (const relay of this.relays) {
			if (published >= 2) break;
			try {
				await relay.publish(signedEvent);
				published++;
			} catch {
				// Try next relay
			}
		}
	}

	async sendOffer(peerPubkeyHex: string, sdp: RTCSessionDescriptionInit): Promise<void> {
		await this.publish(peerPubkeyHex, { type: 'offer', sdp, room: '', timestamp: 0 });
	}

	async sendAnswer(peerPubkeyHex: string, sdp: RTCSessionDescriptionInit): Promise<void> {
		await this.publish(peerPubkeyHex, { type: 'answer', sdp, room: '', timestamp: 0 });
	}

	async sendCandidate(peerPubkeyHex: string, candidate: RTCIceCandidateInit): Promise<void> {
		if (!this.pendingCandidates.has(peerPubkeyHex)) {
			this.pendingCandidates.set(peerPubkeyHex, []);
		}
		this.pendingCandidates.get(peerPubkeyHex)!.push(candidate);

		if (!this.candidateFlushTimeout) {
			this.candidateFlushTimeout = setTimeout(() => {
				this.flushCandidates();
			}, 200);
		}
	}

	async flushCandidates(): Promise<void> {
		this.candidateFlushTimeout = null;

		for (const [peerPubkey, candidates] of this.pendingCandidates) {
			if (candidates.length > 0) {
				await this.publish(peerPubkey, { type: 'candidates', candidates, room: '', timestamp: 0 });
			}
		}
		this.pendingCandidates.clear();
	}

	getStatus(): { connected: boolean; relayCount: number } {
		return {
			connected: this.connected,
			relayCount: this.relays.length
		};
	}

	destroy(): void {
		this.destroyed = true;
		this.connected = false;

		if (this.candidateFlushTimeout) {
			clearTimeout(this.candidateFlushTimeout);
			this.candidateFlushTimeout = null;
		}

		for (const sub of this.subscriptions) {
			try { sub.close(); } catch {}
		}
		this.subscriptions = [];

		for (const relay of this.relays) {
			try { relay.close(); } catch {}
		}
		this.relays = [];

		this.conversationKeys.clear();
		this.seenMessages.clear();
		this.pendingCandidates.clear();
	}
}
