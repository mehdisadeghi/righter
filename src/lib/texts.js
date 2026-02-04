import khayyamFa from '$lib/data/khayyam_fa.yaml';
import khayyamEn from '$lib/data/khayyam_en.yaml';
import khayyamDe from '$lib/data/khayyam_de.yaml';

function parseTexts(data) {
	if (!data.texts) return [];
	return data.texts.map((item) => {
		if (typeof item === 'string') {
			return { text: item.trim(), number: null, url: null };
		}
		return {
			text: (item.text || '').trim(),
			number: item.number || null,
			url: item.url || null
		};
	});
}

function extractMeta(data) {
	return {
		title: data.title,
		author: data.author,
		translator: data.translator,
		translatorUrl: data.translator_url,
		source: data.source,
		sourceUrl: data.source_url,
		license: data.license,
		language: data.language
	};
}

const textsFA = parseTexts(khayyamFa);
const textsEN = parseTexts(khayyamEn);
const textsDE = parseTexts(khayyamDe);

export const texts = {
	fa: {
		easy: textsFA,
		medium: [],
		hard: [],
		expert: []
	},
	en: {
		easy: textsEN,
		medium: [],
		hard: [],
		expert: []
	},
	de: {
		easy: textsDE,
		medium: [],
		hard: [],
		expert: []
	}
};

export const textMeta = {
	fa: extractMeta(khayyamFa),
	en: extractMeta(khayyamEn),
	de: extractMeta(khayyamDe)
};

export function getRandomTextItem(lang, difficulty = 'easy') {
	const langTexts = texts[lang];
	if (!langTexts) return texts.en.easy[0];

	const difficultyTexts = langTexts[difficulty];
	if (!difficultyTexts || difficultyTexts.length === 0) {
		return langTexts.easy[Math.floor(Math.random() * langTexts.easy.length)];
	}

	return difficultyTexts[Math.floor(Math.random() * difficultyTexts.length)];
}

export function getRandomText(lang, difficulty = 'easy') {
	return getRandomTextItem(lang, difficulty).text;
}

export function getTextCount(lang, difficulty = 'easy') {
	return texts[lang]?.[difficulty]?.length ?? 0;
}

export function getTextMeta(lang) {
	return textMeta[lang] || textMeta.en;
}

export function getTextByNumber(lang, number, difficulty = 'easy') {
	const langTexts = texts[lang]?.[difficulty];
	if (!langTexts) return null;
	return langTexts.find(item => item.number === number) || null;
}

export function getAllTexts(lang, difficulty = 'easy') {
	return texts[lang]?.[difficulty] || [];
}

export const difficulties = ['easy', 'medium', 'hard', 'expert'];
