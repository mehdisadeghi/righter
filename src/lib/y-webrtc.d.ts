declare module 'y-webrtc' {
	import type { Doc } from 'yjs';

	interface WebrtcProviderOptions {
		signaling?: string[];
		peerOpts?: { config?: RTCConfiguration };
	}

	interface Awareness {
		setLocalStateField(field: string, value: unknown): void;
		getStates(): Map<number, Record<string, unknown>>;
		on(event: 'change', listener: (changes: { added: number[]; updated: number[]; removed: number[] }) => void): void;
	}

	interface Room {
		webrtcConns: Map<string, unknown>;
		bcConns: Map<string, unknown>;
	}

	interface SignalingConn {
		connected: boolean;
	}

	class WebrtcProvider {
		constructor(roomName: string, doc: Doc, opts?: WebrtcProviderOptions);
		awareness: Awareness;
		room: Room | null;
		signalingConns: SignalingConn[];
		on(event: 'status', listener: (data: { status: string }) => void): void;
		on(event: 'synced', listener: (data: { synced: boolean }) => void): void;
		on(event: 'peers', listener: (data: { added: string[]; removed: string[]; webrtcPeers: string[]; bcPeers: string[] }) => void): void;
		destroy(): void;
	}

	export { WebrtcProvider };
}
