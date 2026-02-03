// Nostr-based progress sync (fallback when WebRTC unavailable)
import { finalizeEvent, verifyEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

const PROGRESS_KIND = 21079; // Ephemeral, app-specific
const CONNECT_TIMEOUT = 5000;

/**
 * @typedef {Object} ProgressUpdate
 * @property {string} odyseeId
 * @property {string} pubkeyHex
 * @property {string} name
 * @property {number} color
 * @property {number} progress
 * @property {number} wpm
 * @property {number} accuracy
 * @property {boolean} finished
 * @property {string} room
 * @property {number} timestamp
 * @property {string} [state] - Room state (waiting, countdown, racing, finished)
 * @property {string} [raceId] - Unique race identifier
 * @property {number} [startTime] - Race start timestamp
 * @property {number} [countdownStart] - Countdown start timestamp
 * @property {string} [text] - Race text (only sent with state changes)
 * @property {Object} [results] - Race results (when finished)
 */

/**
 * Nostr-based progress sync for multiplayer races
 */
export class NostrProgressSync {
	/**
	 * @param {string} roomCode
	 * @param {import('./identity.js').Identity} identity
	 * @param {string[]} relayUrls
	 */
	constructor(roomCode, identity, relayUrls) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.relayUrls = relayUrls;

		this.relays = [];
		this.subscriptions = [];
		this.connected = false;
		this.destroyed = false;

		// Callbacks
		this.onProgress = null;
		this.onStateChange = null;

		// Track seen events to dedupe
		this.seenEvents = new Set();

		// Optional allowlist for known participants
		this.trustedPubkeys = new Set();

		// Rate limiting
		this.lastPublish = 0;
		this.minPublishInterval = 400; // Don't publish more than every 400ms
	}

	/**
	 * Restrict accepted progress updates to known pubkeys
	 * @param {string[]} pubkeys
	 */
	setTrustedPubkeys(pubkeys) {
		this.trustedPubkeys = new Set(pubkeys.filter(Boolean));
	}

	/**
	 * Validate hex pubkey format
	 * @param {string} hex
	 * @returns {boolean}
	 */
	isValidPubkeyHex(hex) {
		return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex);
	}

	/**
	 * Connect to relays
	 * @returns {Promise<boolean>}
	 */
	async connect() {
		if (this.destroyed) return false;

		const connectPromises = this.relayUrls.map(async (url) => {
			try {
				const relay = await Promise.race([
					Relay.connect(url),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error('Timeout')), CONNECT_TIMEOUT)
					)
				]);
				return relay;
			} catch {
				return null;
			}
		});

		const results = await Promise.all(connectPromises);
		this.relays = results.filter(r => r !== null);

		if (this.relays.length === 0) {
			return false;
		}

		this.connected = true;
		this.subscribe();
		return true;
	}

	/**
	 * Subscribe to progress events for this room
	 */
	subscribe() {
		const filter = {
			kinds: [PROGRESS_KIND],
			'#room': [this.roomCode],
			since: Math.floor(Date.now() / 1000) - 30 // Last 30 seconds
		};

		for (const relay of this.relays) {
			try {
				const sub = relay.subscribe([filter], {
					onevent: (event) => this.handleEvent(event),
					oneose: () => {}
				});
				this.subscriptions.push(sub);
			} catch {}
		}
	}

	/**
	 * Handle incoming progress event
	 * @param {import('nostr-tools').Event} event
	 */
	handleEvent(event) {
		if (this.seenEvents.has(event.id)) return;
		this.seenEvents.add(event.id);

		// Ignore own events
		if (event.pubkey === this.identity.pubkeyHex) return;

		try {
			if (!verifyEvent(event)) return;

			const progress = JSON.parse(event.content);
			if (progress.room !== this.roomCode) return;
			if (progress.pubkeyHex !== event.pubkey) return;
			if (!this.isValidPubkeyHex(progress.pubkeyHex)) return;
			if (this.trustedPubkeys.size > 0 && !this.trustedPubkeys.has(progress.pubkeyHex)) return;

			// Check freshness (ignore updates older than 5 seconds)
			const age = Date.now() - progress.timestamp;
			if (age > 5000) return;

			if (this.onProgress) {
				this.onProgress(progress);
			}

			// Handle state changes via Nostr
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

	/**
	 * Publish progress update
	 * @param {Object} data
	 * @param {boolean} [force] - Skip rate limiting (for state changes)
	 */
	async publish(data, force = false) {
		if (this.destroyed || !this.connected) return;

		// Rate limiting (skip for state changes)
		const now = Date.now();
		if (!force && now - this.lastPublish < this.minPublishInterval) return;
		this.lastPublish = now;

		const progress = {
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

		// Include state info if provided
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

		// Publish to first available relay only (reduce spam)
		for (const relay of this.relays) {
			try {
				await relay.publish(signedEvent);
				break; // Success, don't need to publish to all
			} catch {}
		}
	}

	/**
	 * Clean up
	 */
	destroy() {
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
