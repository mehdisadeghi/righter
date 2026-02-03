// Multiplayer room using Nostr signaling + WebRTC data channels
import Peer from 'simple-peer/simplepeer.min.js';
import { NostrSignaling } from './nostr-signaling.js';
import { NostrProgressSync } from './nostr-progress.js';
import { generateRaceId } from './nostr.js';

const ROOM_PREFIX = 'righter-';
const NOSTR_PROGRESS_INTERVAL = 500; // Fallback progress sync interval

// Default ICE servers (STUN only, user can add TURN)
const DEFAULT_ICE_SERVERS = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' }
];

/**
 * @typedef {Object} RoomConfig
 * @property {string} text - Text to type
 * @property {number} duration - Race duration in seconds
 * @property {string} keyboard - Keyboard layout
 */

/**
 * @typedef {Object} Participant
 * @property {string} odyseeId - npub
 * @property {string} pubkeyHex
 * @property {string} name
 * @property {number} color
 * @property {number} progress - Character index
 * @property {number} wpm
 * @property {number} accuracy
 * @property {boolean} finished
 * @property {boolean} connected
 */

/**
 * @typedef {'waiting' | 'countdown' | 'racing' | 'finished'} RoomState
 */

/**
 * Generate a random 4-character room code
 * @returns {string}
 */
export function generateRoomCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 4; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

/**
 * Message types for WebRTC data channel
 */
const MSG = {
	JOIN: 'join',
	STATE: 'state',
	PROGRESS: 'progress',
	START: 'start',
	FINISH: 'finish'
};

/**
 * @typedef {Object} ConnectionConfig
 * @property {string[]} [relayUrls]
 * @property {RTCIceServer[]} [iceServers]
 */

/**
 * Multiplayer room with Nostr signaling
 */
export class MultiplayerRoom {
	/**
	 * @param {string} roomCode
	 * @param {import('./identity.js').Identity} identity
	 * @param {RoomConfig} config
	 * @param {ConnectionConfig} connectionConfig
	 */
	constructor(roomCode, identity, config, connectionConfig = {}) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.config = config;
		this.relayUrls = connectionConfig.relayUrls || [];
		this.iceServers = connectionConfig.iceServers || DEFAULT_ICE_SERVERS;

		this.signaling = null;
		this.progressSync = null;
		this.peers = new Map(); // pubkeyHex -> Peer
		this.connected = false;
		this.destroyed = false;

		// Nostr fallback state
		this.nostrProgressInterval = null;
		this.useNostrFallback = false;

		// Room state
		this.state = 'waiting';
		this.startTime = null;
		this.countdownStart = null;
		this.text = config.text || '';
		this.duration = config.duration || 60;
		this.keyboard = config.keyboard || 'en-US';
		this.raceId = null; // Generated when race starts

		// Participants (including self)
		this.participants = new Map(); // pubkeyHex -> Participant

		// Pending ICE candidates (before connection established)
		this.pendingCandidates = new Map(); // pubkeyHex -> candidate[]

		// Event handlers
		this.onStateChange = null;
		this.onParticipantsChange = null;
		this.onConnectionChange = null;

		// Add self as participant
		this.addSelf();
	}

	addSelf() {
		this.participants.set(this.identity.pubkeyHex, {
			odyseeId: this.identity.odyseeId,
			pubkeyHex: this.identity.pubkeyHex,
			name: this.identity.name,
			color: this.identity.color,
			progress: 0,
			wpm: 0,
			accuracy: 100,
			finished: false,
			connected: true
		});
	}

	/**
	 * Connect to the room
	 * @returns {Promise<boolean>}
	 */
	async connect() {
		if (this.destroyed) return false;

		// Create signaling connection
		this.signaling = new NostrSignaling(
			this.roomCode,
			this.identity,
			this.relayUrls
		);

		// Set up signaling handlers
		this.signaling.onOffer = (peerPubkey, sdp) => this.handleOffer(peerPubkey, sdp);
		this.signaling.onAnswer = (peerPubkey, sdp) => this.handleAnswer(peerPubkey, sdp);
		this.signaling.onCandidate = (peerPubkey, candidate) => this.handleCandidate(peerPubkey, candidate);

		const connected = await this.signaling.connect();
		if (!connected) {
			console.error('Failed to connect signaling');
			return false;
		}

		// Set up Nostr progress sync (fallback)
		this.progressSync = new NostrProgressSync(
			this.roomCode,
			this.identity,
			this.relayUrls
		);
		this.progressSync.setTrustedPubkeys([this.identity.pubkeyHex]);
		this.progressSync.onProgress = (progress) => this.handleNostrProgress(progress);
		this.progressSync.onStateChange = (state) => this.handleNostrStateChange(state);
		await this.progressSync.connect();

		this.connected = true;
		console.log('Signaling connected, room:', this.roomCode);

		if (this.onConnectionChange) {
			this.onConnectionChange(true);
		}

		return true;
	}

	/**
	 * Update known participant pubkeys for Nostr fallback validation
	 * @param {string[]} pubkeys
	 */
	setKnownParticipants(pubkeys) {
		const merged = new Set(pubkeys.filter(Boolean));
		merged.add(this.identity.pubkeyHex);
		if (this.progressSync) {
			this.progressSync.setTrustedPubkeys(Array.from(merged));
		}
	}

	/**
	 * Handle progress update from Nostr (fallback)
	 * @param {Object} progress
	 */
	handleNostrProgress(progress) {
		// Only use Nostr progress if we don't have WebRTC connection to this peer
		if (this.peers.has(progress.pubkeyHex)) {
			const peer = this.peers.get(progress.pubkeyHex);
			if (peer.connected) return; // Have WebRTC, ignore Nostr
		}

		// Update or add participant
		this.participants.set(progress.pubkeyHex, {
			odyseeId: progress.odyseeId,
			pubkeyHex: progress.pubkeyHex,
			name: progress.name,
			color: progress.color,
			progress: progress.progress,
			wpm: progress.wpm,
			accuracy: progress.accuracy,
			finished: progress.finished,
			connected: true
		});

		this.notifyParticipantsChange();
	}

	/**
	 * Handle state change from Nostr (fallback when no WebRTC)
	 * @param {Object} stateData
	 */
	handleNostrStateChange(stateData) {
		// Only process if we're behind in state (or same race finished)
		const stateOrder = { waiting: 0, countdown: 1, racing: 2, finished: 3 };
		const currentOrder = stateOrder[this.state] || 0;
		const newOrder = stateOrder[stateData.state] || 0;

		// If same raceId, only accept forward state changes
		if (stateData.raceId === this.raceId && newOrder <= currentOrder) return;

		// If different raceId and we're in waiting, accept the new race
		if (stateData.raceId !== this.raceId && this.state !== 'waiting') {
			// Different race in progress, ignore
			return;
		}

		console.log('State change via Nostr:', stateData.state, 'raceId:', stateData.raceId);

		this.state = stateData.state;
		if (stateData.raceId) this.raceId = stateData.raceId;
		if (stateData.startTime) this.startTime = stateData.startTime;
		if (stateData.countdownStart) this.countdownStart = stateData.countdownStart;
		if (stateData.text) this.text = stateData.text;

		this.notifyStateChange();

		// Handle countdown -> racing transition
		if (stateData.state === 'countdown' && stateData.countdownStart) {
			const elapsed = Date.now() - stateData.countdownStart;
			const remaining = 3000 - elapsed;
			if (remaining > 0) {
				setTimeout(() => {
					if (this.state === 'countdown') {
						this.state = 'racing';
						this.startTime = Date.now();
						this.notifyStateChange();
					}
				}, remaining);
			} else {
				// Countdown already passed, go straight to racing
				this.state = 'racing';
				this.startTime = stateData.startTime || Date.now();
				this.notifyStateChange();
			}
		}
	}

	/**
	 * Check if we have any connected WebRTC peers
	 * @returns {boolean}
	 */
	hasConnectedPeers() {
		for (const peer of this.peers.values()) {
			if (peer.connected) return true;
		}
		return false;
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
	 * Determine if we should be the initiator (polite peer pattern)
	 * The peer with lexicographically smaller pubkey initiates
	 * @param {string} peerPubkeyHex
	 * @returns {boolean}
	 */
	shouldInitiate(peerPubkeyHex) {
		return this.identity.pubkeyHex < peerPubkeyHex;
	}

	/**
	 * Initiate connection to a known peer
	 * @param {string} peerPubkeyHex
	 */
	connectToPeer(peerPubkeyHex) {
		if (this.peers.has(peerPubkeyHex)) return;
		if (peerPubkeyHex === this.identity.pubkeyHex) return;

		// Validate pubkey format
		if (!this.isValidPubkeyHex(peerPubkeyHex)) {
			console.warn('Invalid peer pubkey format, skipping:', peerPubkeyHex);
			return;
		}

		// Only initiate if we have the smaller pubkey (polite peer pattern)
		if (!this.shouldInitiate(peerPubkeyHex)) {
			console.log('Waiting for peer to initiate:', peerPubkeyHex.slice(0, 8));
			return;
		}

		console.log('Initiating connection to peer:', peerPubkeyHex.slice(0, 8));

		const peer = new Peer({
			initiator: true,
			trickle: true,
			config: { iceServers: this.iceServers }
		});

		this.setupPeer(peer, peerPubkeyHex);
		this.peers.set(peerPubkeyHex, peer);
	}

	/**
	 * Handle incoming WebRTC offer
	 * @param {string} peerPubkeyHex
	 * @param {RTCSessionDescriptionInit} sdp
	 */
	handleOffer(peerPubkeyHex, sdp) {
		if (this.peers.has(peerPubkeyHex)) {
			console.log('Already have peer, ignoring offer');
			return;
		}

		console.log('Received offer from:', peerPubkeyHex.slice(0, 8));

		const peer = new Peer({
			initiator: false,
			trickle: true,
			config: { iceServers: this.iceServers }
		});

		this.setupPeer(peer, peerPubkeyHex);
		this.peers.set(peerPubkeyHex, peer);

		peer.signal(sdp);

		// Apply any pending candidates
		const pending = this.pendingCandidates.get(peerPubkeyHex);
		if (pending) {
			for (const candidate of pending) {
				peer.signal(candidate);
			}
			this.pendingCandidates.delete(peerPubkeyHex);
		}
	}

	/**
	 * Handle incoming WebRTC answer
	 * @param {string} peerPubkeyHex
	 * @param {RTCSessionDescriptionInit} sdp
	 */
	handleAnswer(peerPubkeyHex, sdp) {
		const peer = this.peers.get(peerPubkeyHex);
		if (!peer) {
			console.warn('Received answer but no peer exists');
			return;
		}

		console.log('Received answer from:', peerPubkeyHex.slice(0, 8));
		peer.signal(sdp);
	}

	/**
	 * Handle incoming ICE candidate
	 * @param {string} peerPubkeyHex
	 * @param {RTCIceCandidateInit} candidate
	 */
	handleCandidate(peerPubkeyHex, candidate) {
		const peer = this.peers.get(peerPubkeyHex);
		if (!peer) {
			// Store for later if peer not yet created
			if (!this.pendingCandidates.has(peerPubkeyHex)) {
				this.pendingCandidates.set(peerPubkeyHex, []);
			}
			this.pendingCandidates.get(peerPubkeyHex).push({ candidate });
			return;
		}

		peer.signal({ candidate });
	}

	/**
	 * Set up peer event handlers
	 * @param {Peer} peer
	 * @param {string} peerPubkeyHex
	 */
	setupPeer(peer, peerPubkeyHex) {
		peer.on('signal', async (data) => {
			// Send signaling data via Nostr
			if (data.type === 'offer') {
				await this.signaling.sendOffer(peerPubkeyHex, data);
			} else if (data.type === 'answer') {
				await this.signaling.sendAnswer(peerPubkeyHex, data);
			} else if (data.candidate) {
				await this.signaling.sendCandidate(peerPubkeyHex, data.candidate);
			}
		});

		peer.on('connect', () => {
			console.log('Peer connected:', peerPubkeyHex.slice(0, 8));

			// Send our info to the peer
			this.sendToPeer(peerPubkeyHex, {
				type: MSG.JOIN,
				participant: this.participants.get(this.identity.pubkeyHex),
				state: this.state,
				text: this.text,
				duration: this.duration,
				keyboard: this.keyboard,
				startTime: this.startTime,
				countdownStart: this.countdownStart
			});

			this.notifyParticipantsChange();
		});

		peer.on('data', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				this.handlePeerMessage(peerPubkeyHex, msg);
			} catch (err) {
				console.warn('Failed to parse peer message:', err);
			}
		});

		peer.on('close', () => {
			console.log('Peer disconnected:', peerPubkeyHex.slice(0, 8));
			this.peers.delete(peerPubkeyHex);

			const participant = this.participants.get(peerPubkeyHex);
			if (participant) {
				participant.connected = false;
				this.notifyParticipantsChange();
			}
		});

		peer.on('error', (err) => {
			console.warn('Peer error:', peerPubkeyHex.slice(0, 8), err.message);
		});
	}

	/**
	 * Handle message from peer
	 * @param {string} peerPubkeyHex
	 * @param {Object} msg
	 */
	handlePeerMessage(peerPubkeyHex, msg) {
		switch (msg.type) {
			case MSG.JOIN:
				// Add/update participant
				this.participants.set(peerPubkeyHex, {
					...msg.participant,
					pubkeyHex: peerPubkeyHex,
					connected: true
				});

				// Sync state if they have newer info
				if (msg.state && msg.state !== 'waiting' && this.state === 'waiting') {
					this.state = msg.state;
					this.text = msg.text || this.text;
					this.duration = msg.duration || this.duration;
					this.keyboard = msg.keyboard || this.keyboard;
					this.startTime = msg.startTime;
					this.countdownStart = msg.countdownStart;
					this.notifyStateChange();
				}

				// If we don't have text but they do, use theirs
				if (!this.text && msg.text) {
					this.text = msg.text;
					this.duration = msg.duration || this.duration;
					this.keyboard = msg.keyboard || this.keyboard;
				}

				this.notifyParticipantsChange();
				break;

			case MSG.STATE:
				this.state = msg.state;
				this.startTime = msg.startTime;
				this.countdownStart = msg.countdownStart;
				if (msg.raceId) this.raceId = msg.raceId;
				if (msg.text) this.text = msg.text;
				this.notifyStateChange();
				break;

			case MSG.PROGRESS:
				const participant = this.participants.get(peerPubkeyHex);
				if (participant) {
					participant.progress = msg.progress;
					participant.wpm = msg.wpm;
					participant.accuracy = msg.accuracy;
					this.notifyParticipantsChange();
				}
				break;

			case MSG.FINISH:
				const finisher = this.participants.get(peerPubkeyHex);
				if (finisher) {
					finisher.finished = true;
					finisher.wpm = msg.wpm;
					finisher.accuracy = msg.accuracy;
					finisher.progress = this.text.length;
					this.notifyParticipantsChange();
				}
				break;

			case MSG.START:
				if (this.state === 'waiting') {
					this.countdownStart = msg.countdownStart;
					this.raceId = msg.raceId;
					this.state = 'countdown';
					this.notifyStateChange();

					// Transition to racing after countdown
					setTimeout(() => {
						if (this.state === 'countdown') {
							this.state = 'racing';
							this.startTime = Date.now();
							this.notifyStateChange();
						}
					}, 3000);
				}
				break;
		}
	}

	/**
	 * Send message to a specific peer
	 * @param {string} peerPubkeyHex
	 * @param {Object} msg
	 */
	sendToPeer(peerPubkeyHex, msg) {
		const peer = this.peers.get(peerPubkeyHex);
		if (peer && peer.connected) {
			try {
				peer.send(JSON.stringify(msg));
			} catch (err) {
				console.warn('Failed to send to peer:', err.message);
			}
		}
	}

	/**
	 * Broadcast message to all peers
	 * @param {Object} msg
	 */
	broadcast(msg) {
		const data = JSON.stringify(msg);
		for (const [pubkey, peer] of this.peers) {
			if (peer.connected) {
				try {
					peer.send(data);
				} catch (err) {
					console.warn('Failed to broadcast to peer:', err.message);
				}
			}
		}
	}

	/**
	 * Start the race countdown
	 */
	startCountdown() {
		if (this.state !== 'waiting') return;

		console.log('Starting countdown');
		this.countdownStart = Date.now();
		this.state = 'countdown';
		// Generate unique race ID
		this.raceId = generateRaceId(this.roomCode, this.countdownStart, this.text);

		// Broadcast to all peers via WebRTC
		this.broadcast({
			type: MSG.START,
			countdownStart: this.countdownStart,
			raceId: this.raceId
		});

		// Also publish via Nostr (for peers without WebRTC connection)
		if (this.progressSync) {
			this.progressSync.publish({
				state: 'countdown',
				countdownStart: this.countdownStart,
				raceId: this.raceId,
				text: this.text
			}, true);
		}

		this.notifyStateChange();

		// Transition to racing after 3 seconds
		setTimeout(() => {
			if (this.state === 'countdown') {
				this.state = 'racing';
				this.startTime = Date.now();

				// Broadcast via WebRTC
				this.broadcast({
					type: MSG.STATE,
					state: 'racing',
					startTime: this.startTime,
					raceId: this.raceId,
					text: this.text
				});

				// Also publish via Nostr
				if (this.progressSync) {
					this.progressSync.publish({
						state: 'racing',
						startTime: this.startTime,
						raceId: this.raceId,
						text: this.text
					}, true);
				}

				this.notifyStateChange();
			}
		}, 3000);
	}

	/**
	 * Update own progress
	 * @param {number} progress
	 * @param {number} wpm
	 * @param {number} accuracy
	 */
	updateProgress(progress, wpm, accuracy) {
		const me = this.participants.get(this.identity.pubkeyHex);
		if (me) {
			me.progress = progress;
			me.wpm = wpm;
			me.accuracy = accuracy;

			// Send via WebRTC if available
			if (this.hasConnectedPeers()) {
				this.broadcast({
					type: MSG.PROGRESS,
					progress,
					wpm,
					accuracy
				});
			}

			// Always publish to Nostr as fallback (rate-limited internally)
			if (this.progressSync) {
				this.progressSync.publish({ progress, wpm, accuracy, finished: false });
			}

			this.notifyParticipantsChange();
		}
	}

	/**
	 * Mark self as finished
	 * @param {number} wpm
	 * @param {number} accuracy
	 */
	finishRace(wpm, accuracy) {
		const me = this.participants.get(this.identity.pubkeyHex);
		if (me) {
			me.finished = true;
			me.wpm = wpm;
			me.accuracy = accuracy;
			me.progress = this.text.length;

			// Broadcast via WebRTC
			this.broadcast({
				type: MSG.FINISH,
				wpm,
				accuracy
			});

			// Also publish via Nostr (fallback)
			if (this.progressSync) {
				this.progressSync.publish({
					progress: this.text.length,
					wpm,
					accuracy,
					finished: true
				});
			}

			this.notifyParticipantsChange();
		}
	}

	/**
	 * End the race and announce results
	 */
	endRace() {
		this.state = 'finished';

		const results = this.getRaceResult();

		// Broadcast via WebRTC
		this.broadcast({
			type: MSG.STATE,
			state: 'finished',
			raceId: this.raceId,
			results
		});

		// Publish finish state via Nostr with results
		if (this.progressSync) {
			this.progressSync.publish({
				state: 'finished',
				raceId: this.raceId,
				startTime: this.startTime,
				results
			}, true);
		}

		this.notifyStateChange();
	}

	/**
	 * Reset room for a new race
	 * @param {string} newText - New text for the race
	 */
	resetForNewRace(newText) {
		this.state = 'waiting';
		this.raceId = null;
		this.startTime = null;
		this.countdownStart = null;
		this.text = newText;

		// Reset all participants' progress
		for (const [pubkey, participant] of this.participants) {
			participant.progress = 0;
			participant.wpm = 0;
			participant.accuracy = 100;
			participant.finished = false;
		}

		// Broadcast reset via WebRTC
		this.broadcast({
			type: MSG.STATE,
			state: 'waiting',
			text: this.text
		});

		// Publish via Nostr
		if (this.progressSync) {
			this.progressSync.publish({
				state: 'waiting',
				text: this.text
			}, true);
		}

		this.notifyStateChange();
		this.notifyParticipantsChange();
	}

	/**
	 * Get current room state
	 */
	getState() {
		return {
			state: this.state,
			raceId: this.raceId,
			startTime: this.startTime,
			text: this.text,
			duration: this.duration,
			keyboard: this.keyboard,
			countdownStart: this.countdownStart
		};
	}

	/**
	 * Get all participants
	 * @returns {Participant[]}
	 */
	getParticipants() {
		return Array.from(this.participants.values())
			.sort((a, b) => b.progress - a.progress);
	}

	/**
	 * Get race result for publishing
	 */
	getRaceResult() {
		const participants = this.getParticipants()
			.sort((a, b) => b.wpm - a.wpm)
			.map((p, idx) => ({
				odyseeId: p.odyseeId,
				name: p.name,
				color: p.color,
				wpm: p.wpm,
				accuracy: p.accuracy,
				rank: idx + 1
			}));

		return {
			raceId: generateRaceId(this.roomCode, this.startTime, this.text),
			timestamp: this.startTime,
			room: this.roomCode,
			keyboard: this.keyboard,
			duration: this.duration,
			textPreview: this.text.slice(0, 50),
			participants
		};
	}

	/**
	 * Notify state change
	 */
	notifyStateChange() {
		if (this.onStateChange) {
			this.onStateChange(this.getState());
		}
		// Also trigger participants change for UI refresh
		this.notifyParticipantsChange();
	}

	/**
	 * Notify participants change
	 */
	notifyParticipantsChange() {
		if (this.onParticipantsChange) {
			this.onParticipantsChange(this.getParticipants());
		}
	}

	/**
	 * Get debug info
	 */
	getDebugInfo() {
		const signalingStatus = this.signaling?.getStatus() || { connected: false, relayCount: 0 };
		return {
			roomCode: this.roomCode,
			connected: this.connected,
			destroyed: this.destroyed,
			state: this.state,
			participantCount: this.participants.size,
			participants: Array.from(this.participants.values()).map(p => p.name),
			peerCount: this.peers.size,
			connectedPeers: Array.from(this.peers.entries())
				.filter(([_, p]) => p.connected)
				.map(([k, _]) => k.slice(0, 8)),
			signalingConnected: signalingStatus.connected,
			relayCount: signalingStatus.relayCount
		};
	}

	/**
	 * Initialize room with text (for first joiner)
	 */
	initializeRoom() {
		// Already has config from constructor
		this.state = 'waiting';
	}

	/**
	 * Clean up
	 */
	destroy() {
		this.destroyed = true;
		this.connected = false;

		// Close all peer connections
		for (const [_, peer] of this.peers) {
			try { peer.destroy(); } catch {}
		}
		this.peers.clear();

		// Close signaling
		if (this.signaling) {
			this.signaling.destroy();
			this.signaling = null;
		}

		// Close Nostr progress sync
		if (this.progressSync) {
			this.progressSync.destroy();
			this.progressSync = null;
		}

		this.participants.clear();
		this.pendingCandidates.clear();

		if (this.onConnectionChange) {
			this.onConnectionChange(false);
		}
	}
}

/**
 * Get room code from URL hash
 * @returns {string|null}
 */
export function getRoomFromUrl() {
	if (typeof window === 'undefined') return null;
	const hash = window.location.hash;
	const match = hash.match(/room=([A-Z0-9]{4})/i);
	return match ? match[1].toUpperCase() : null;
}

/**
 * Set room code in URL hash
 * @param {string} roomCode
 */
export function setRoomInUrl(roomCode) {
	if (typeof window === 'undefined') return;
	window.location.hash = `room=${roomCode}`;
}

/**
 * Clear room from URL hash
 */
export function clearRoomFromUrl() {
	if (typeof window === 'undefined') return;
	window.location.hash = '';
}
