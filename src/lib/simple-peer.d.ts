declare module 'simple-peer/simplepeer.min.js' {
	interface PeerOptions {
		initiator?: boolean;
		trickle?: boolean;
		config?: RTCConfiguration;
	}

	class Peer {
		constructor(opts?: PeerOptions);
		connected: boolean;
		signal(data: unknown): void;
		send(data: string | Uint8Array): void;
		destroy(): void;
		on(event: 'signal', listener: (data: { type?: string; candidate?: RTCIceCandidateInit }) => void): void;
		on(event: 'connect', listener: () => void): void;
		on(event: 'data', listener: (data: Uint8Array) => void): void;
		on(event: 'close', listener: () => void): void;
		on(event: 'error', listener: (err: Error) => void): void;
	}

	export default Peer;
}
