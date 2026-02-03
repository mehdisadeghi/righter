// Multiplayer room management using Yjs + y-webrtc
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { generateRaceId } from './nostr.js';

const DEFAULT_SIGNALING_SERVERS = [
	'wss://signaling.yjs.dev'
];

const ROOM_PREFIX = 'righter-';
const CONNECT_TIMEOUT = 10000;

/**
 * @typedef {Object} RoomConfig
 * @property {string} text - Text to type
 * @property {number} duration - Race duration in seconds
 * @property {string} keyboard - Keyboard layout
 */

/**
 * @typedef {Object} Participant
 * @property {string} odyseeId
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
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed ambiguous chars
	let code = '';
	for (let i = 0; i < 4; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

/**
 * @typedef {Object} ConnectionConfig
 * @property {string[]} [signalingServers]
 * @property {{url: string, username: string, credential: string}|null} [turnServer]
 */

/**
 * Create or join a multiplayer room
 */
export class MultiplayerRoom {
	/**
	 * @param {string} roomCode
	 * @param {import('./identity.js').Identity} identity
	 * @param {RoomConfig} config
	 * @param {ConnectionConfig} [connectionConfig]
	 */
	constructor(roomCode, identity, config, connectionConfig = {}) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.config = config;
		this.connectionConfig = connectionConfig;

		this.doc = new Y.Doc();
		this.provider = null;
		this.connected = false;
		this.destroyed = false;

		// Shared state
		this.stateMap = this.doc.getMap('state');
		this.participantsMap = this.doc.getMap('participants');

		// Event handlers
		this.onStateChange = null;
		this.onParticipantsChange = null;
		this.onConnectionChange = null;

		// Setup observers
		this.stateMap.observe(() => {
			console.log('State changed:', this.stateMap.get('state'));
			if (this.onStateChange) {
				this.onStateChange(this.getState());
			}
			// Also update participants when state changes (ensures UI refresh)
			if (this.onParticipantsChange) {
				this.onParticipantsChange(this.getParticipants());
			}
		});

		this.participantsMap.observe(() => {
			console.log('Participants changed:', this.getParticipants().map(p => p.name));
			if (this.onParticipantsChange) {
				this.onParticipantsChange(this.getParticipants());
			}
		});
	}

	/**
	 * Connect to the room
	 * @returns {Promise<boolean>}
	 */
	async connect() {
		if (this.destroyed) return false;

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (!this.connected) {
					console.warn('Room connection timeout');
					resolve(false);
				}
			}, CONNECT_TIMEOUT);

			try {
				const signalingServers = this.connectionConfig.signalingServers?.length
					? this.connectionConfig.signalingServers
					: DEFAULT_SIGNALING_SERVERS;

				// Build ICE servers config
				const iceServers = [
					{ urls: 'stun:stun.l.google.com:19302' }
				];
				if (this.connectionConfig.turnServer?.url) {
					iceServers.push({
						urls: this.connectionConfig.turnServer.url,
						username: this.connectionConfig.turnServer.username || '',
						credential: this.connectionConfig.turnServer.credential || ''
					});
				}

				console.log('Creating WebrtcProvider with room:', ROOM_PREFIX + this.roomCode, 'signaling:', signalingServers);
				this.provider = new WebrtcProvider(
					ROOM_PREFIX + this.roomCode,
					this.doc,
					{
						signaling: signalingServers,
						peerOpts: {
							config: { iceServers }
						}
					}
				);

				// Log signaling connection status
				this.provider.on('status', ({ status }) => {
					console.log('Provider status:', status);
				});

				// Set our identity in awareness so peers can see us
				this.provider.awareness.setLocalStateField('user', {
					odyseeId: this.identity.odyseeId,
					name: this.identity.name,
					color: this.identity.color
				});

				this.provider.on('synced', ({ synced }) => {
					console.log('Synced event:', synced, 'connected:', this.connected, 'peers:', this.provider.room?.webrtcConns?.size || 0);
					if (synced && !this.connected) {
						this.handleConnected(timeout, resolve);
					}
				});

				this.provider.on('peers', ({ added, removed, webrtcPeers, bcPeers }) => {
					console.log('Peers changed - added:', added.length, 'removed:', removed.length, 'webrtc:', webrtcPeers?.length, 'bc:', bcPeers?.length);
					// Trigger participants update when peers change
					if (this.onParticipantsChange) {
						this.onParticipantsChange(this.getParticipants());
					}
				});

				// Also listen for awareness changes
				this.provider.awareness.on('change', ({ added, updated, removed }) => {
					console.log('Awareness change - added:', added?.length, 'updated:', updated?.length, 'removed:', removed?.length);
					console.log('Awareness states:', [...this.provider.awareness.getStates().entries()].map(([id, s]) => s.user?.name));
					if (this.onParticipantsChange) {
						this.onParticipantsChange(this.getParticipants());
					}
				});

				// Fallback: consider connected after delay if no sync event
				setTimeout(() => {
					if (!this.connected && !this.destroyed) {
						console.log('Fallback connect triggered');
						this.handleConnected(timeout, resolve);
					}
				}, 3000);

			} catch (err) {
				console.error('Failed to connect:', err);
				clearTimeout(timeout);
				resolve(false);
			}
		});
	}

	/**
	 * Handle successful connection
	 */
	handleConnected(timeout, resolve) {
		this.connected = true;
		clearTimeout(timeout);

		// Only initialize if room is truly empty (no state set)
		// Use a small delay to allow sync to complete
		setTimeout(() => {
			if (!this.stateMap.get('state') && this.config.text) {
				console.log('Initializing room as first joiner');
				this.initializeRoom();
			} else {
				console.log('Joining existing room, state:', this.stateMap.get('state'));
			}

			this.joinRoom();

			if (this.onConnectionChange) {
				this.onConnectionChange(true);
			}

			resolve(true);
		}, 500);
	}

	/**
	 * Initialize room state (first joiner)
	 */
	initializeRoom() {
		this.doc.transact(() => {
			this.stateMap.set('state', 'waiting');
			this.stateMap.set('startTime', null);
			this.stateMap.set('text', this.config.text);
			this.stateMap.set('duration', this.config.duration);
			this.stateMap.set('keyboard', this.config.keyboard);
		});
	}

	/**
	 * Join room as participant
	 */
	joinRoom() {
		const participant = {
			odyseeId: this.identity.odyseeId,
			name: this.identity.name,
			color: this.identity.color,
			progress: 0,
			wpm: 0,
			accuracy: 100,
			finished: false,
			connected: true,
			joinedAt: Date.now()
		};

		this.participantsMap.set(this.identity.odyseeId, participant);
	}

	/**
	 * Update own progress
	 * @param {number} progress
	 * @param {number} wpm
	 * @param {number} accuracy
	 */
	updateProgress(progress, wpm, accuracy) {
		const me = this.participantsMap.get(this.identity.odyseeId);
		if (me) {
			this.participantsMap.set(this.identity.odyseeId, {
				...me,
				progress,
				wpm,
				accuracy
			});
		}
	}

	/**
	 * Mark self as finished
	 * @param {number} wpm
	 * @param {number} accuracy
	 */
	finishRace(wpm, accuracy) {
		const me = this.participantsMap.get(this.identity.odyseeId);
		if (me) {
			this.participantsMap.set(this.identity.odyseeId, {
				...me,
				finished: true,
				wpm,
				accuracy,
				progress: this.stateMap.get('text')?.length || 0
			});
		}
	}

	/**
	 * Start the race (any participant can call this)
	 */
	startCountdown() {
		const state = this.stateMap.get('state');
		console.log('startCountdown called, current state:', state, 'participants:', this.getParticipants().map(p => p.name));
		if (state !== 'waiting') {
			console.log('Not starting - state is not waiting');
			return;
		}

		const countdownStart = Date.now();
		console.log('Setting countdown state');
		this.doc.transact(() => {
			this.stateMap.set('state', 'countdown');
			this.stateMap.set('countdownStart', countdownStart);
		});

		// After 3 seconds, start racing
		setTimeout(() => {
			const currentState = this.stateMap.get('state');
			console.log('Countdown timeout fired, current state:', currentState);
			if (currentState === 'countdown') {
				const raceStart = Date.now();
				console.log('Setting racing state');
				this.doc.transact(() => {
					this.stateMap.set('state', 'racing');
					this.stateMap.set('startTime', raceStart);
				});
			}
		}, 3000);
	}

	/**
	 * End the race
	 */
	endRace() {
		this.stateMap.set('state', 'finished');
	}

	/**
	 * Get current room state
	 * @returns {{state: RoomState, startTime: number|null, text: string, duration: number, keyboard: string, countdownStart: number|null}}
	 */
	getState() {
		return {
			state: this.stateMap.get('state') || 'waiting',
			startTime: this.stateMap.get('startTime'),
			text: this.stateMap.get('text') || this.config.text,
			duration: this.stateMap.get('duration') || this.config.duration,
			keyboard: this.stateMap.get('keyboard') || this.config.keyboard,
			countdownStart: this.stateMap.get('countdownStart')
		};
	}

	/**
	 * Get all participants
	 * @returns {Participant[]}
	 */
	getParticipants() {
		const participants = [];
		this.participantsMap.forEach((value, key) => {
			participants.push({ ...value, odyseeId: key });
		});
		// Sort by progress descending
		return participants.sort((a, b) => b.progress - a.progress);
	}

	/**
	 * Get race result for publishing
	 * @returns {import('./nostr.js').RaceResult}
	 */
	getRaceResult() {
		const state = this.getState();
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
			raceId: generateRaceId(this.roomCode, state.startTime, state.text),
			timestamp: state.startTime,
			room: this.roomCode,
			keyboard: state.keyboard,
			duration: state.duration,
			textPreview: state.text.slice(0, 50),
			participants
		};
	}

	/**
	 * Update connection status for all participants
	 */
	updateConnectionStatus() {
		// Mark disconnected participants based on awareness
		const connectedIds = new Set();

		if (this.provider?.awareness) {
			const states = this.provider.awareness.getStates();
			states.forEach((state) => {
				if (state.user?.odyseeId) {
					connectedIds.add(state.user.odyseeId);
				}
			});
		}

		// Always include self
		connectedIds.add(this.identity.odyseeId);

		this.participantsMap.forEach((value, key) => {
			const isConnected = connectedIds.has(key);
			if (value.connected !== isConnected) {
				this.participantsMap.set(key, { ...value, connected: isConnected });
			}
		});
	}

	/**
	 * Leave and cleanup
	 */
	destroy() {
		this.destroyed = true;

		// Remove self from participants
		this.participantsMap.delete(this.identity.odyseeId);

		if (this.provider) {
			this.provider.destroy();
			this.provider = null;
		}

		this.doc.destroy();
		this.connected = false;

		if (this.onConnectionChange) {
			this.onConnectionChange(false);
		}
	}

	/**
	 * Check if I'm the only participant (for cleanup)
	 * @returns {boolean}
	 */
	isAlone() {
		return this.participantsMap.size <= 1;
	}

	/**
	 * Get debug info about connection status
	 */
	getDebugInfo() {
		return {
			roomName: ROOM_PREFIX + this.roomCode,
			connected: this.connected,
			destroyed: this.destroyed,
			state: this.stateMap.get('state'),
			participantsInMap: this.participantsMap.size,
			participants: this.getParticipants().map(p => p.name),
			webrtcPeers: this.provider?.room?.webrtcConns?.size || 0,
			bcPeers: this.provider?.room?.bcConns?.size || 0,
			awarenessStates: this.provider?.awareness?.getStates()?.size || 0,
			signalingConnected: this.provider?.signalingConns?.some(c => c.connected) || false
		};
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

export { DEFAULT_SIGNALING_SERVERS };
