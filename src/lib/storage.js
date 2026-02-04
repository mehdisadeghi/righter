const STORAGE_KEY = 'righter_data';
const RACES_KEY = 'righter_races';

const defaultSettings = {
	uiLanguage: 'en',
	keyboardLocale: 'en-US',
	fontSize: 1.25,
	hue: 220,
	modeType: 'time',
	modeValue: 30,
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
	// Font settings (per script)
	fontLatin: 'system',
	fontArabic: 'vazirmatn',
	// Relay settings - reliable public relays
	nostrRelays: [
		'wss://relay.damus.io',
		'wss://nos.lol',
		'wss://relay.snort.social'
	],
	// ICE servers for WebRTC (STUN/TURN)
	iceServers: [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	]
};

const defaultData = {
	settings: { ...defaultSettings },
	history: [],
	customTexts: {
		fa: '',
		en: ''
	}
};

export function loadData() {
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

export function saveData(data) {
	if (typeof localStorage === 'undefined') return;

	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	} catch {
		// Storage full or unavailable
	}
}

export function exportData() {
	const data = loadData();
	return JSON.stringify(data, null, 2);
}

export function importData(jsonString) {
	try {
		const data = JSON.parse(jsonString);
		if (typeof data !== 'object' || data === null) {
			throw new Error('Invalid data format');
		}
		const merged = { ...defaultData, ...data };
		saveData(merged);
		return merged;
	} catch (e) {
		throw new Error('Invalid JSON: ' + e.message);
	}
}

export function addRaceResult(result) {
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

export function updateSettings(settings) {
	const data = loadData();
	data.settings = { ...data.settings, ...settings };
	saveData(data);
	return data;
}

export function updateCustomText(lang, text) {
	const data = loadData();
	data.customTexts[lang] = text;
	saveData(data);
	return data;
}

export function clearHistory() {
	const data = loadData();
	data.history = [];
	saveData(data);
	return data;
}

export function resetSettings() {
	const data = loadData();
	data.settings = { ...defaultSettings };
	saveData(data);
	return data;
}

// Group race storage (separate from solo history)

/**
 * Load all locally stored group races
 * @returns {Object.<string, import('./nostr.js').RaceResult>}
 */
export function loadLocalRaces() {
	if (typeof localStorage === 'undefined') return {};

	try {
		const stored = localStorage.getItem(RACES_KEY);
		if (!stored) return {};
		return JSON.parse(stored);
	} catch {
		return {};
	}
}

/**
 * Save group race locally
 * @param {import('./nostr.js').RaceResult} race
 */
export function saveLocalRace(race) {
	if (typeof localStorage === 'undefined') return;
	if (!race.raceId) return;

	try {
		const races = loadLocalRaces();
		races[race.raceId] = race;

		// Keep only last 500 races to avoid storage limits
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

/**
 * Save multiple races (for merge results)
 * @param {import('./nostr.js').RaceResult[]} raceList
 */
export function saveLocalRaces(raceList) {
	for (const race of raceList) {
		saveLocalRace(race);
	}
}

/**
 * Get local races as array
 * @returns {import('./nostr.js').RaceResult[]}
 */
export function getLocalRacesArray() {
	const races = loadLocalRaces();
	return Object.values(races).sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get races where user participated
 * @param {string} odyseeId
 * @returns {import('./nostr.js').RaceResult[]}
 */
export function getMyLocalRaces(odyseeId) {
	return getLocalRacesArray().filter(race =>
		race.participants.some(p => p.odyseeId === odyseeId)
	);
}

/**
 * Clear all local races
 */
export function clearLocalRaces() {
	if (typeof localStorage === 'undefined') return;
	localStorage.removeItem(RACES_KEY);
}
