const STORAGE_KEY = 'righter_data';

const defaultData = {
	settings: {
		language: null,
		fontSize: 1.25,
		hue: 220,
		difficulty: 'easy'
	},
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
