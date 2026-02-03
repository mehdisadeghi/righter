// Nostr-based WebRTC signaling with NIP-44 encryption
import { finalizeEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';
import * as nip44 from 'nostr-tools/nip44';

const SIGNALING_KIND = 21078; // Ephemeral (20000+), app-specific
const CONNECT_TIMEOUT = 5000;
const SIGNAL_TIMEOUT = 60000; // 1 minute - allow for relay delays

/**
 * @typedef {Object} SignalMessage
 * @property {'offer' | 'answer' | 'candidate'} type
 * @property {RTCSessionDescriptionInit} [sdp]
 * @property {RTCIceCandidateInit} [candidate]
 * @property {string} room
 * @property {number} timestamp
 */

/**
 * Nostr-based WebRTC signaling
 */
export class NostrSignaling {
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
		this.onOffer = null;
		this.onAnswer = null;
		this.onCandidate = null;
		this.onPeerJoined = null;

		// Track conversation keys per peer (cached)
		this.conversationKeys = new Map();

		// Track seen message IDs to dedupe across relays
		this.seenMessages = new Set();

		// Batch ICE candidates to avoid rate limiting
		this.pendingCandidates = new Map(); // peerPubkey -> candidates[]
		this.candidateFlushTimeout = null;
	}

	/**
	 * Get or create conversation key for a peer
	 * @param {string} peerPubkeyHex
	 * @returns {Uint8Array}
	 */
	getConversationKey(peerPubkeyHex) {
		if (!this.conversationKeys.has(peerPubkeyHex)) {
			const key = nip44.v2.utils.getConversationKey(
				this.identity.secretKey,
				peerPubkeyHex
			);
			this.conversationKeys.set(peerPubkeyHex, key);
		}
		return this.conversationKeys.get(peerPubkeyHex);
	}

	/**
	 * Encrypt a message for a specific peer
	 * @param {SignalMessage} message
	 * @param {string} peerPubkeyHex
	 * @returns {string}
	 */
	encrypt(message, peerPubkeyHex) {
		const conversationKey = this.getConversationKey(peerPubkeyHex);
		return nip44.v2.encrypt(JSON.stringify(message), conversationKey);
	}

	/**
	 * Decrypt a message from a peer
	 * @param {string} ciphertext
	 * @param {string} peerPubkeyHex
	 * @returns {SignalMessage|null}
	 */
	decrypt(ciphertext, peerPubkeyHex) {
		try {
			const conversationKey = this.getConversationKey(peerPubkeyHex);
			const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
			return JSON.parse(plaintext);
		} catch (err) {
			console.warn('Failed to decrypt signaling message:', err.message);
			return null;
		}
	}

	/**
	 * Connect to relays and start listening
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
			} catch (err) {
				console.warn(`Failed to connect to ${url}:`, err.message);
				return null;
			}
		});

		const results = await Promise.all(connectPromises);
		this.relays = results.filter(r => r !== null);

		if (this.relays.length === 0) {
			console.error('No relays connected');
			return false;
		}

		console.log(`Connected to ${this.relays.length} relays for signaling`);
		this.connected = true;

		// Subscribe to signaling events for this room addressed to us
		this.subscribe();

		return true;
	}

	/**
	 * Subscribe to signaling events
	 * Uses #p tag (indexed) and filters room in handler
	 */
	subscribe() {
		const pubkey = this.identity.pubkeyHex;
		console.log('Own pubkey:', pubkey, 'length:', pubkey?.length, 'valid:', this.isValidPubkeyHex(pubkey));

		// Validate our own pubkey
		if (!this.isValidPubkeyHex(pubkey)) {
			console.error('Invalid own pubkey format:', pubkey);
			return;
		}

		const filter = {
			kinds: [SIGNALING_KIND],
			'#p': [pubkey],
			since: Math.floor(Date.now() / 1000) - 60 // Last minute only
		};

		console.log('Subscribing with filter:', JSON.stringify(filter));

		for (const relay of this.relays) {
			try {
				const sub = relay.subscribe([filter], {
					onevent: (event) => this.handleEvent(event),
					oneose: () => {} // End of stored events
				});
				this.subscriptions.push(sub);
			} catch (err) {
				console.warn('Failed to subscribe:', err.message);
			}
		}
	}

	/**
	 * Handle incoming signaling event
	 * @param {import('nostr-tools').Event} event
	 */
	handleEvent(event) {
		// Dedupe across relays
		if (this.seenMessages.has(event.id)) return;
		this.seenMessages.add(event.id);

		// Ignore our own events
		if (event.pubkey === this.identity.pubkeyHex) return;

		// Decrypt the message
		const message = this.decrypt(event.content, event.pubkey);
		if (!message) return;

		// Verify room code
		if (message.room !== this.roomCode) return;

		// Check message age (ignore stale signals)
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
				// Batched candidates
				if (this.onCandidate && message.candidates) {
					for (const candidate of message.candidates) {
						this.onCandidate(event.pubkey, candidate);
					}
				}
				break;
		}
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
	 * Publish a signaling message to a specific peer
	 * @param {string} peerPubkeyHex
	 * @param {SignalMessage} message
	 */
	async publish(peerPubkeyHex, message) {
		if (this.destroyed || !this.connected) return;

		// Validate pubkey format
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

		// Publish to first 2 working relays (peers may be on different relays)
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

	/**
	 * Send an SDP offer to a peer
	 * @param {string} peerPubkeyHex
	 * @param {RTCSessionDescriptionInit} sdp
	 */
	async sendOffer(peerPubkeyHex, sdp) {
		await this.publish(peerPubkeyHex, { type: 'offer', sdp });
	}

	/**
	 * Send an SDP answer to a peer
	 * @param {string} peerPubkeyHex
	 * @param {RTCSessionDescriptionInit} sdp
	 */
	async sendAnswer(peerPubkeyHex, sdp) {
		await this.publish(peerPubkeyHex, { type: 'answer', sdp });
	}

	/**
	 * Send an ICE candidate to a peer (batched to avoid rate limiting)
	 * @param {string} peerPubkeyHex
	 * @param {RTCIceCandidateInit} candidate
	 */
	async sendCandidate(peerPubkeyHex, candidate) {
		// Batch candidates to avoid rate limiting
		if (!this.pendingCandidates.has(peerPubkeyHex)) {
			this.pendingCandidates.set(peerPubkeyHex, []);
		}
		this.pendingCandidates.get(peerPubkeyHex).push(candidate);

		// Flush after short delay to batch multiple candidates
		if (!this.candidateFlushTimeout) {
			this.candidateFlushTimeout = setTimeout(() => {
				this.flushCandidates();
			}, 200);
		}
	}

	/**
	 * Flush batched ICE candidates
	 */
	async flushCandidates() {
		this.candidateFlushTimeout = null;

		for (const [peerPubkey, candidates] of this.pendingCandidates) {
			if (candidates.length > 0) {
				await this.publish(peerPubkey, { type: 'candidates', candidates });
			}
		}
		this.pendingCandidates.clear();
	}

	/**
	 * Get connection status
	 * @returns {{connected: boolean, relayCount: number}}
	 */
	getStatus() {
		return {
			connected: this.connected,
			relayCount: this.relays.length
		};
	}

	/**
	 * Close all connections
	 */
	destroy() {
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
