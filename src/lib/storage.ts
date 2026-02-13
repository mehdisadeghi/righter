import type { AppData, Settings, RaceResult, HistoryEntry } from './types.js';

const STORAGE_KEY = 'righter_data';
const RACES_KEY = 'righter_races';

const defaultSettings: Settings = {
	uiLanguage: 'en',
	keyboardLocale: 'en-US',
	fontSize: 1.25,
	hue: 220,
	modeType: 'time',
	modeValue: 60,
	physicalLayout: 'ansi',
	errorReplace: false,
	langOverride: '',
	parallax: true,
	parallaxIntensity: 1.5,
	parallax3d: false,
	parallax3dEffect: 'none',
	parallax3dTexture: 'solid',
	parallax3dRainbow: false,
	dotPattern: true,
	fontLatin: 'system',
	fontArabic: 'vazirmatn',
	showHands: true,
	nostrRelays: [
		'wss://relay.damus.io',
		'wss://nos.lol',
		'wss://relay.snort.social'
	],
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	]
};

const defaultData: AppData = {
	settings: { ...defaultSettings },
	history: [],
	customTexts: {
		fa: '',
		en: ''
	}
};

export function loadData(): AppData {
	if (typeof localStorage === 'undefined') return defaultData;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return defaultData;

		const parsed = JSON.parse(stored);
		return { ...defaultData, ...parsed };
	} catch {
		return defaultData;
	}
}

export function saveData(data: AppData): void {
	if (typeof localStorage === 'undefined') return;

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch {
		// Storage full or unavailable
	}
}

export function exportData(): string {
	const data = loadData();
	return JSON.stringify(data, null, 2);
}

export function importData(jsonString: string): AppData {
	try {
		const data = JSON.parse(jsonString);
		if (typeof data !== 'object' || data === null) {
			throw new Error('Invalid data format');
		}
		const merged = { ...defaultData, ...data };
		saveData(merged);
		return merged;
	} catch (e) {
		throw new Error('Invalid JSON: ' + (e as Error).message);
	}
}

export function addRaceResult(result: Omit<HistoryEntry, 'timestamp'>): AppData {
	const data = loadData();
	data.history.unshift({
		...result,
		timestamp: Date.now()
	});
	if (data.history.length > 100) {
		data.history = data.history.slice(0, 100);
	}
	saveData(data);
	return data;
}

export function updateSettings(settings: Partial<Settings>): AppData {
	const data = loadData();
	data.settings = { ...data.settings, ...settings };
	saveData(data);
	return data;
}

export function updateCustomText(lang: string, text: string): AppData {
	const data = loadData();
	data.customTexts[lang] = text;
	saveData(data);
	return data;
}

export function clearHistory(): AppData {
	const data = loadData();
	data.history = [];
	saveData(data);
	return data;
}

export function resetSettings(): AppData {
	const data = loadData();
	data.settings = { ...defaultSettings };
	saveData(data);
	return data;
}

// Group race storage (separate from solo history)

export function loadLocalRaces(): Record<string, RaceResult> {
	if (typeof localStorage === 'undefined') return {};

	try {
		const stored = localStorage.getItem(RACES_KEY);
		if (!stored) return {};
		return JSON.parse(stored);
	} catch {
		return {};
	}
}

export function saveLocalRace(race: RaceResult): void {
	if (typeof localStorage === 'undefined') return;
	if (!race.raceId) return;

	try {
		const races = loadLocalRaces();
		races[race.raceId] = race;

		const raceIds = Object.keys(races);
		if (raceIds.length > 500) {
			const sorted = raceIds
				.map(id => ({ id, ts: races[id].timestamp }))
				.sort((a, b) => b.ts - a.ts);
			const toKeep = new Set(sorted.slice(0, 500).map(r => r.id));
			for (const id of raceIds) {
				if (!toKeep.has(id)) delete races[id];
			}
		}

		localStorage.setItem(RACES_KEY, JSON.stringify(races));
	} catch {
		// Storage full
	}
}

export function saveLocalRaces(raceList: RaceResult[]): void {
	for (const race of raceList) {
		saveLocalRace(race);
	}
}

export function getLocalRacesArray(): RaceResult[] {
	const races = loadLocalRaces();
	return Object.values(races).sort((a, b) => b.timestamp - a.timestamp);
}

export function getMyLocalRaces(odyseeId: string): RaceResult[] {
	return getLocalRacesArray().filter(race =>
		race.participants.some(p => p.odyseeId === odyseeId)
	);
}

export function clearLocalRaces(): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.removeItem(RACES_KEY);
}
