export interface Identity {
	odyseeId: string;
	secretKey: Uint8Array;
	pubkeyHex: string;
	name: string;
	color: number;
}

export interface ParticipantResult {
	odyseeId: string;
	name: string;
	color: number;
	wpm: number;
	accuracy: number;
	rank: number;
}

export interface RaceResult {
	raceId: string;
	timestamp: number;
	room: string;
	keyboard: string;
	duration: number;
	textPreview: string;
	participants: ParticipantResult[];
}

export interface RoomConfig {
	text: string;
	duration: number;
	keyboard: string;
}

export interface Participant {
	odyseeId: string;
	pubkeyHex: string;
	name: string;
	color: number;
	progress: number;
	wpm: number;
	accuracy: number;
	finished: boolean;
	connected: boolean;
}

export type RoomState = 'waiting' | 'countdown' | 'racing' | 'finished';

export interface SignalMessage {
	type: 'offer' | 'answer' | 'candidate' | 'candidates';
	sdp?: RTCSessionDescriptionInit;
	candidate?: RTCIceCandidateInit;
	candidates?: RTCIceCandidateInit[];
	room: string;
	timestamp: number;
}

export interface ProgressUpdate {
	odyseeId: string;
	pubkeyHex: string;
	name: string;
	color: number;
	progress: number;
	wpm: number;
	accuracy: number;
	finished: boolean;
	room: string;
	timestamp: number;
	state?: string;
	raceId?: string;
	startTime?: number;
	countdownStart?: number;
	text?: string;
	results?: Record<string, unknown>;
}

export interface RelayInfo {
	url: string;
	rttOpen: number;
	rttRead: number;
	rttWrite: number;
	nips: string[];
	relayType: string | null;
	requiresPayment: boolean;
	requiresAuth: boolean;
}

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

export interface TextItem {
	text: string;
	number: number | null;
	url: string | null;
}

export interface TextMeta {
	title: string;
	author: string;
	translator: string;
	translatorUrl: string;
	source: string;
	sourceUrl: string;
	license: string;
	language: string;
}

export interface Settings {
	uiLanguage: string;
	keyboardLocale: string;
	fontSize: number;
	hue: number;
	modeType: string;
	modeValue: number;
	physicalLayout: string;
	errorReplace: boolean;
	langOverride: string;
	parallax: boolean;
	parallaxIntensity: number;
	parallax3d: boolean;
	parallax3dEffect: string;
	parallax3dTexture: string;
	parallax3dRainbow: boolean;
	dotPattern: boolean;
	fontLatin: string;
	fontArabic: string;
	showHands: boolean;
	nostrRelays: string[];
	iceServers: RTCIceServer[];
}

export interface HistoryEntry {
	wpm: number;
	accuracy: number;
	timestamp: number;
	mode: string;
	modeValue: number;
	textLength: number;
}

export interface AppData {
	settings: Settings;
	history: HistoryEntry[];
	customTexts: Record<string, string>;
}

export interface SupportedLanguage {
	code: string;
	name: string;
	nativeName: string;
}
