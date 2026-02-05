import type { Identity } from './identity.js';
import type { RoomConfig, Participant, RoomState, RaceResult, ParticipantResult } from './types.js';
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import { generateRaceId } from './nostr.js';

const DEFAULT_SIGNALING_SERVERS = [
	'wss://signaling.yjs.dev'
];

const ROOM_PREFIX = 'righter-';
const CONNECT_TIMEOUT = 10000;

export function generateRoomCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 4; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

interface ConnectionConfig {
	signalingServers?: string[];
	turnServer?: { url: string; username: string; credential: string } | null;
}

interface YjsParticipant extends Participant {
	joinedAt?: number;
}

export class MultiplayerRoom {
	roomCode: string;
	identity: Identity;
	config: RoomConfig;
	connectionConfig: ConnectionConfig;

	doc: Y.Doc;
	provider: WebrtcProvider | null;
	connected: boolean;
	destroyed: boolean;

	stateMap: Y.Map<unknown>;
	participantsMap: Y.Map<YjsParticipant>;

	onStateChange: ((state: ReturnType<MultiplayerRoom['getState']>) => void) | null;
	onParticipantsChange: ((participants: Participant[]) => void) | null;
	onConnectionChange: ((connected: boolean) => void) | null;

	constructor(roomCode: string, identity: Identity, config: RoomConfig, connectionConfig: ConnectionConfig = {}) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.config = config;
		this.connectionConfig = connectionConfig;

		this.doc = new Y.Doc();
		this.provider = null;
		this.connected = false;
		this.destroyed = false;

		this.stateMap = this.doc.getMap('state');
		this.participantsMap = this.doc.getMap('participants');

		this.onStateChange = null;
		this.onParticipantsChange = null;
		this.onConnectionChange = null;

		this.stateMap.observe(() => {
			console.log('State changed:', this.stateMap.get('state'));
			if (this.onStateChange) {
				this.onStateChange(this.getState());
			}
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

	async connect(): Promise<boolean> {
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

				const iceServers: RTCIceServer[] = [
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

				this.provider.on('status', ({ status }) => {
					console.log('Provider status:', status);
				});

				this.provider.awareness.setLocalStateField('user', {
					odyseeId: this.identity.odyseeId,
					name: this.identity.name,
					color: this.identity.color
				});

				this.provider.on('synced', ({ synced }) => {
					console.log('Synced event:', synced, 'connected:', this.connected, 'peers:', this.provider?.room?.webrtcConns?.size || 0);
					if (synced && !this.connected) {
						this.handleConnected(timeout, resolve);
					}
				});

				this.provider.on('peers', ({ added, removed, webrtcPeers, bcPeers }) => {
					console.log('Peers changed - added:', added.length, 'removed:', removed.length, 'webrtc:', webrtcPeers?.length, 'bc:', bcPeers?.length);
					if (this.onParticipantsChange) {
						this.onParticipantsChange(this.getParticipants());
					}
				});

				this.provider.awareness.on('change', ({ added, updated, removed }) => {
					console.log('Awareness change - added:', added?.length, 'updated:', updated?.length, 'removed:', removed?.length);
					console.log('Awareness states:', [...this.provider!.awareness.getStates().entries()].map(([, s]) => (s as Record<string, Record<string, string>>).user?.name));
					if (this.onParticipantsChange) {
						this.onParticipantsChange(this.getParticipants());
					}
				});

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

	handleConnected(timeout: ReturnType<typeof setTimeout>, resolve: (value: boolean) => void): void {
		this.connected = true;
		clearTimeout(timeout);

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

	initializeRoom(): void {
		this.doc.transact(() => {
			this.stateMap.set('state', 'waiting');
			this.stateMap.set('startTime', null);
			this.stateMap.set('text', this.config.text);
			this.stateMap.set('duration', this.config.duration);
			this.stateMap.set('keyboard', this.config.keyboard);
		});
	}

	joinRoom(): void {
		const participant: YjsParticipant = {
			odyseeId: this.identity.odyseeId,
			pubkeyHex: this.identity.pubkeyHex ?? '',
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

	updateProgress(progress: number, wpm: number, accuracy: number): void {
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

	finishRace(wpm: number, accuracy: number): void {
		const me = this.participantsMap.get(this.identity.odyseeId);
		if (me) {
			this.participantsMap.set(this.identity.odyseeId, {
				...me,
				finished: true,
				wpm,
				accuracy,
				progress: (this.stateMap.get('text') as string)?.length || 0
			});
		}
	}

	startCountdown(): void {
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

	endRace(): void {
		this.stateMap.set('state', 'finished');
	}

	getState(): { state: RoomState; startTime: number | null; text: string; duration: number; keyboard: string; countdownStart: number | null } {
		return {
			state: (this.stateMap.get('state') as RoomState) || 'waiting',
			startTime: this.stateMap.get('startTime') as number | null,
			text: (this.stateMap.get('text') as string) || this.config.text,
			duration: (this.stateMap.get('duration') as number) || this.config.duration,
			keyboard: (this.stateMap.get('keyboard') as string) || this.config.keyboard,
			countdownStart: this.stateMap.get('countdownStart') as number | null
		};
	}

	getParticipants(): Participant[] {
		const participants: Participant[] = [];
		this.participantsMap.forEach((value, key) => {
			participants.push({ ...value, odyseeId: key });
		});
		return participants.sort((a, b) => b.progress - a.progress);
	}

	getRaceResult(): RaceResult {
		const state = this.getState();
		const participants: ParticipantResult[] = this.getParticipants()
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
			timestamp: state.startTime ?? Date.now(),
			room: this.roomCode,
			keyboard: state.keyboard,
			duration: state.duration,
			textPreview: state.text.slice(0, 50),
			participants
		};
	}

	updateConnectionStatus(): void {
		const connectedIds = new Set<string>();

		if (this.provider?.awareness) {
			const states = this.provider.awareness.getStates();
			states.forEach((state) => {
				const user = (state as Record<string, Record<string, string>>).user;
				if (user?.odyseeId) {
					connectedIds.add(user.odyseeId);
				}
			});
		}

		connectedIds.add(this.identity.odyseeId);

		this.participantsMap.forEach((value, key) => {
			const isConnected = connectedIds.has(key);
			if (value.connected !== isConnected) {
				this.participantsMap.set(key, { ...value, connected: isConnected });
			}
		});
	}

	destroy(): void {
		this.destroyed = true;

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

	isAlone(): boolean {
		return this.participantsMap.size <= 1;
	}

	getDebugInfo(): Record<string, unknown> {
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

export function getRoomFromUrl(): string | null {
	if (typeof window === 'undefined') return null;
	const hash = window.location.hash;
	const match = hash.match(/room=([A-Z0-9]{4})/i);
	return match ? match[1].toUpperCase() : null;
}

export function setRoomInUrl(roomCode: string): void {
	if (typeof window === 'undefined') return;
	window.location.hash = `room=${roomCode}`;
}

export function clearRoomFromUrl(): void {
	if (typeof window === 'undefined') return;
	window.location.hash = '';
}

export { DEFAULT_SIGNALING_SERVERS };
