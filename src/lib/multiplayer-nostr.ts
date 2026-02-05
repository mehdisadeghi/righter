import type { Identity } from './identity.js';
import type { RoomConfig, Participant, RoomState, RaceResult, ParticipantResult } from './types.js';
import Peer from 'simple-peer/simplepeer.min.js';
import { NostrSignaling } from './nostr-signaling.js';
import { NostrProgressSync } from './nostr-progress.js';
import { generateRaceId } from './nostr.js';

const ROOM_PREFIX = 'righter-';
const NOSTR_PROGRESS_INTERVAL = 500;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun1.l.google.com:19302' }
];

const MSG = {
	JOIN: 'join',
	STATE: 'state',
	PROGRESS: 'progress',
	START: 'start',
	FINISH: 'finish'
} as const;

interface ConnectionConfig {
	relayUrls?: string[];
	iceServers?: RTCIceServer[];
}

interface PeerMessage {
	type: string;
	participant?: Participant;
	state?: RoomState;
	text?: string;
	duration?: number;
	keyboard?: string;
	startTime?: number | null;
	countdownStart?: number | null;
	raceId?: string;
	progress?: number;
	wpm?: number;
	accuracy?: number;
	results?: RaceResult;
}

export function generateRoomCode(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code = '';
	for (let i = 0; i < 4; i++) {
		code += chars[Math.floor(Math.random() * chars.length)];
	}
	return code;
}

export class MultiplayerRoom {
	roomCode: string;
	identity: Identity;
	config: RoomConfig;
	relayUrls: string[];
	iceServers: RTCIceServer[];

	signaling: NostrSignaling | null;
	progressSync: NostrProgressSync | null;
	peers: Map<string, Peer>;
	connected: boolean;
	destroyed: boolean;

	nostrProgressInterval: ReturnType<typeof setInterval> | null;
	useNostrFallback: boolean;

	state: RoomState;
	startTime: number | null;
	countdownStart: number | null;
	text: string;
	duration: number;
	keyboard: string;
	raceId: string | null;

	participants: Map<string, Participant>;
	pendingCandidates: Map<string, { candidate: RTCIceCandidateInit }[]>;

	onStateChange: ((state: ReturnType<MultiplayerRoom['getState']>) => void) | null;
	onParticipantsChange: ((participants: Participant[]) => void) | null;
	onConnectionChange: ((connected: boolean) => void) | null;

	constructor(roomCode: string, identity: Identity, config: RoomConfig, connectionConfig: ConnectionConfig = {}) {
		this.roomCode = roomCode;
		this.identity = identity;
		this.config = config;
		this.relayUrls = connectionConfig.relayUrls || [];
		this.iceServers = connectionConfig.iceServers || DEFAULT_ICE_SERVERS;

		this.signaling = null;
		this.progressSync = null;
		this.peers = new Map();
		this.connected = false;
		this.destroyed = false;

		this.nostrProgressInterval = null;
		this.useNostrFallback = false;

		this.state = 'waiting';
		this.startTime = null;
		this.countdownStart = null;
		this.text = config.text || '';
		this.duration = config.duration || 60;
		this.keyboard = config.keyboard || 'en-US';
		this.raceId = null;

		this.participants = new Map();
		this.pendingCandidates = new Map();

		this.onStateChange = null;
		this.onParticipantsChange = null;
		this.onConnectionChange = null;

		this.addSelf();
	}

	addSelf(): void {
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

	async connect(): Promise<boolean> {
		if (this.destroyed) return false;

		this.signaling = new NostrSignaling(
			this.roomCode,
			this.identity,
			this.relayUrls
		);

		this.signaling.onOffer = (peerPubkey, sdp) => this.handleOffer(peerPubkey, sdp as RTCSessionDescriptionInit);
		this.signaling.onAnswer = (peerPubkey, sdp) => this.handleAnswer(peerPubkey, sdp as RTCSessionDescriptionInit);
		this.signaling.onCandidate = (peerPubkey, candidate) => this.handleCandidate(peerPubkey, candidate as RTCIceCandidateInit);

		const connected = await this.signaling.connect();
		if (!connected) {
			console.error('Failed to connect signaling');
			return false;
		}

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

	setKnownParticipants(pubkeys: string[]): void {
		const merged = new Set(pubkeys.filter(Boolean));
		merged.add(this.identity.pubkeyHex);
		if (this.progressSync) {
			this.progressSync.setTrustedPubkeys(Array.from(merged));
		}
	}

	handleNostrProgress(progress: { pubkeyHex: string; odyseeId: string; name: string; color: number; progress: number; wpm: number; accuracy: number; finished: boolean }): void {
		if (this.peers.has(progress.pubkeyHex)) {
			const peer = this.peers.get(progress.pubkeyHex)!;
			if (peer.connected) return;
		}

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

	handleNostrStateChange(stateData: { state: string; raceId?: string; startTime?: number; countdownStart?: number; text?: string }): void {
		const stateOrder: Record<string, number> = { waiting: 0, countdown: 1, racing: 2, finished: 3 };
		const currentOrder = stateOrder[this.state] || 0;
		const newOrder = stateOrder[stateData.state] || 0;

		if (stateData.raceId === this.raceId && newOrder <= currentOrder) return;

		if (stateData.raceId !== this.raceId && this.state !== 'waiting') {
			return;
		}

		console.log('State change via Nostr:', stateData.state, 'raceId:', stateData.raceId);

		this.state = stateData.state as RoomState;
		if (stateData.raceId) this.raceId = stateData.raceId;
		if (stateData.startTime) this.startTime = stateData.startTime;
		if (stateData.countdownStart) this.countdownStart = stateData.countdownStart;
		if (stateData.text) this.text = stateData.text;

		this.notifyStateChange();

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
				this.state = 'racing';
				this.startTime = stateData.startTime || Date.now();
				this.notifyStateChange();
			}
		}
	}

	hasConnectedPeers(): boolean {
		for (const peer of this.peers.values()) {
			if (peer.connected) return true;
		}
		return false;
	}

	isValidPubkeyHex(hex: string): boolean {
		return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex);
	}

	shouldInitiate(peerPubkeyHex: string): boolean {
		return this.identity.pubkeyHex < peerPubkeyHex;
	}

	connectToPeer(peerPubkeyHex: string): void {
		if (this.peers.has(peerPubkeyHex)) return;
		if (peerPubkeyHex === this.identity.pubkeyHex) return;

		if (!this.isValidPubkeyHex(peerPubkeyHex)) {
			console.warn('Invalid peer pubkey format, skipping:', peerPubkeyHex);
			return;
		}

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

	handleOffer(peerPubkeyHex: string, sdp: RTCSessionDescriptionInit): void {
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

		const pending = this.pendingCandidates.get(peerPubkeyHex);
		if (pending) {
			for (const candidate of pending) {
				peer.signal(candidate);
			}
			this.pendingCandidates.delete(peerPubkeyHex);
		}
	}

	handleAnswer(peerPubkeyHex: string, sdp: RTCSessionDescriptionInit): void {
		const peer = this.peers.get(peerPubkeyHex);
		if (!peer) {
			console.warn('Received answer but no peer exists');
			return;
		}

		console.log('Received answer from:', peerPubkeyHex.slice(0, 8));
		peer.signal(sdp);
	}

	handleCandidate(peerPubkeyHex: string, candidate: RTCIceCandidateInit): void {
		const peer = this.peers.get(peerPubkeyHex);
		if (!peer) {
			if (!this.pendingCandidates.has(peerPubkeyHex)) {
				this.pendingCandidates.set(peerPubkeyHex, []);
			}
			this.pendingCandidates.get(peerPubkeyHex)!.push({ candidate });
			return;
		}

		peer.signal({ candidate });
	}

	setupPeer(peer: Peer, peerPubkeyHex: string): void {
		peer.on('signal', async (data) => {
			if (data.type === 'offer') {
				await this.signaling!.sendOffer(peerPubkeyHex, data as unknown as RTCSessionDescriptionInit);
			} else if (data.type === 'answer') {
				await this.signaling!.sendAnswer(peerPubkeyHex, data as unknown as RTCSessionDescriptionInit);
			} else if (data.candidate) {
				await this.signaling!.sendCandidate(peerPubkeyHex, data.candidate);
			}
		});

		peer.on('connect', () => {
			console.log('Peer connected:', peerPubkeyHex.slice(0, 8));

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
				const msg: PeerMessage = JSON.parse(data.toString());
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

	handlePeerMessage(peerPubkeyHex: string, msg: PeerMessage): void {
		switch (msg.type) {
			case MSG.JOIN: {
				this.participants.set(peerPubkeyHex, {
					...msg.participant!,
					pubkeyHex: peerPubkeyHex,
					connected: true
				});

				if (msg.state && msg.state !== 'waiting' && this.state === 'waiting') {
					this.state = msg.state;
					this.text = msg.text || this.text;
					this.duration = msg.duration || this.duration;
					this.keyboard = msg.keyboard || this.keyboard;
					this.startTime = msg.startTime ?? null;
					this.countdownStart = msg.countdownStart ?? null;
					this.notifyStateChange();
				}

				if (!this.text && msg.text) {
					this.text = msg.text;
					this.duration = msg.duration || this.duration;
					this.keyboard = msg.keyboard || this.keyboard;
				}

				this.notifyParticipantsChange();
				break;
			}

			case MSG.STATE: {
				this.state = (msg.state as RoomState) ?? this.state;
				this.startTime = msg.startTime ?? this.startTime;
				this.countdownStart = msg.countdownStart ?? this.countdownStart;
				if (msg.raceId) this.raceId = msg.raceId;
				if (msg.text) this.text = msg.text;
				this.notifyStateChange();
				break;
			}

			case MSG.PROGRESS: {
				const participant = this.participants.get(peerPubkeyHex);
				if (participant) {
					participant.progress = msg.progress ?? 0;
					participant.wpm = msg.wpm ?? 0;
					participant.accuracy = msg.accuracy ?? 100;
					this.notifyParticipantsChange();
				}
				break;
			}

			case MSG.FINISH: {
				const finisher = this.participants.get(peerPubkeyHex);
				if (finisher) {
					finisher.finished = true;
					finisher.wpm = msg.wpm ?? 0;
					finisher.accuracy = msg.accuracy ?? 100;
					finisher.progress = this.text.length;
					this.notifyParticipantsChange();
				}
				break;
			}

			case MSG.START: {
				if (this.state === 'waiting') {
					this.countdownStart = msg.countdownStart ?? null;
					this.raceId = msg.raceId ?? null;
					this.state = 'countdown';
					this.notifyStateChange();

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
	}

	sendToPeer(peerPubkeyHex: string, msg: PeerMessage): void {
		const peer = this.peers.get(peerPubkeyHex);
		if (peer && peer.connected) {
			try {
				peer.send(JSON.stringify(msg));
			} catch (err) {
				console.warn('Failed to send to peer:', (err as Error).message);
			}
		}
	}

	broadcast(msg: PeerMessage): void {
		const data = JSON.stringify(msg);
		for (const [, peer] of this.peers) {
			if (peer.connected) {
				try {
					peer.send(data);
				} catch (err) {
					console.warn('Failed to broadcast to peer:', (err as Error).message);
				}
			}
		}
	}

	startCountdown(): void {
		if (this.state !== 'waiting') return;

		console.log('Starting countdown');
		this.countdownStart = Date.now();
		this.state = 'countdown';
		this.raceId = generateRaceId(this.roomCode, this.countdownStart, this.text);

		this.broadcast({
			type: MSG.START,
			countdownStart: this.countdownStart,
			raceId: this.raceId
		});

		if (this.progressSync) {
			this.progressSync.publish({
				state: 'countdown',
				countdownStart: this.countdownStart,
				raceId: this.raceId,
				text: this.text
			}, true);
		}

		this.notifyStateChange();

		setTimeout(() => {
			if (this.state === 'countdown') {
				this.state = 'racing';
				this.startTime = Date.now();

				this.broadcast({
					type: MSG.STATE,
					state: 'racing',
					startTime: this.startTime,
					raceId: this.raceId ?? undefined,
					text: this.text
				});

				if (this.progressSync) {
					this.progressSync.publish({
						state: 'racing',
						startTime: this.startTime,
						raceId: this.raceId ?? undefined,
						text: this.text
					}, true);
				}

				this.notifyStateChange();
			}
		}, 3000);
	}

	updateProgress(progress: number, wpm: number, accuracy: number): void {
		const me = this.participants.get(this.identity.pubkeyHex);
		if (me) {
			me.progress = progress;
			me.wpm = wpm;
			me.accuracy = accuracy;

			if (this.hasConnectedPeers()) {
				this.broadcast({
					type: MSG.PROGRESS,
					progress,
					wpm,
					accuracy
				});
			}

			if (this.progressSync) {
				this.progressSync.publish({ progress, wpm, accuracy, finished: false });
			}

			this.notifyParticipantsChange();
		}
	}

	finishRace(wpm: number, accuracy: number): void {
		const me = this.participants.get(this.identity.pubkeyHex);
		if (me) {
			me.finished = true;
			me.wpm = wpm;
			me.accuracy = accuracy;
			me.progress = this.text.length;

			this.broadcast({
				type: MSG.FINISH,
				wpm,
				accuracy
			});

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

	endRace(): void {
		this.state = 'finished';

		const results = this.getRaceResult();

		this.broadcast({
			type: MSG.STATE,
			state: 'finished',
			raceId: this.raceId ?? undefined,
			results
		});

		if (this.progressSync) {
			this.progressSync.publish({
				state: 'finished',
				raceId: this.raceId ?? undefined,
				startTime: this.startTime ?? undefined
			}, true);
		}

		this.notifyStateChange();
	}

	resetForNewRace(newText: string): void {
		this.state = 'waiting';
		this.raceId = null;
		this.startTime = null;
		this.countdownStart = null;
		this.text = newText;

		for (const [, participant] of this.participants) {
			participant.progress = 0;
			participant.wpm = 0;
			participant.accuracy = 100;
			participant.finished = false;
		}

		this.broadcast({
			type: MSG.STATE,
			state: 'waiting',
			text: this.text
		});

		if (this.progressSync) {
			this.progressSync.publish({
				state: 'waiting',
				text: this.text
			}, true);
		}

		this.notifyStateChange();
		this.notifyParticipantsChange();
	}

	getState(): { state: RoomState; raceId: string | null; startTime: number | null; text: string; duration: number; keyboard: string; countdownStart: number | null } {
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

	getParticipants(): Participant[] {
		return Array.from(this.participants.values())
			.sort((a, b) => b.progress - a.progress);
	}

	getRaceResult(): RaceResult {
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
			raceId: generateRaceId(this.roomCode, this.startTime, this.text),
			timestamp: this.startTime ?? Date.now(),
			room: this.roomCode,
			keyboard: this.keyboard,
			duration: this.duration,
			textPreview: this.text.slice(0, 50),
			participants
		};
	}

	notifyStateChange(): void {
		if (this.onStateChange) {
			this.onStateChange(this.getState());
		}
		this.notifyParticipantsChange();
	}

	notifyParticipantsChange(): void {
		if (this.onParticipantsChange) {
			this.onParticipantsChange(this.getParticipants());
		}
	}

	getDebugInfo(): Record<string, unknown> {
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
				.filter(([, p]) => p.connected)
				.map(([k]) => k.slice(0, 8)),
			signalingConnected: signalingStatus.connected,
			relayCount: signalingStatus.relayCount
		};
	}

	initializeRoom(): void {
		this.state = 'waiting';
	}

	destroy(): void {
		this.destroyed = true;
		this.connected = false;

		for (const [, peer] of this.peers) {
			try { peer.destroy(); } catch {}
		}
		this.peers.clear();

		if (this.signaling) {
			this.signaling.destroy();
			this.signaling = null;
		}

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
