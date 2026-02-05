import khayyamFa from '$lib/data/khayyam_fa.yaml';
import khayyamEn from '$lib/data/khayyam_en.yaml';
import khayyamDe from '$lib/data/khayyam_de.yaml';
import type { TextItem, TextMeta, Difficulty } from './types.js';

interface YamlData {
	title: string;
	author: string;
	translator: string;
	translator_url: string;
	source: string;
	source_url: string;
	license: string;
	language: string;
	texts: (string | { text: string; number?: number; url?: string })[];
}

function parseTexts(data: YamlData): TextItem[] {
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

function extractMeta(data: YamlData): TextMeta {
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

const textsFA = parseTexts(khayyamFa as YamlData);
const textsEN = parseTexts(khayyamEn as YamlData);
const textsDE = parseTexts(khayyamDe as YamlData);

export const texts: Record<string, Record<Difficulty, TextItem[]>> = {
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

export const textMeta: Record<string, TextMeta> = {
	fa: extractMeta(khayyamFa as YamlData),
	en: extractMeta(khayyamEn as YamlData),
	de: extractMeta(khayyamDe as YamlData)
};

export function getRandomTextItem(lang: string, difficulty: Difficulty = 'easy'): TextItem {
	const langTexts = texts[lang];
	if (!langTexts) return texts.en.easy[0];

	const difficultyTexts = langTexts[difficulty];
	if (!difficultyTexts || difficultyTexts.length === 0) {
		return langTexts.easy[Math.floor(Math.random() * langTexts.easy.length)];
	}

	return difficultyTexts[Math.floor(Math.random() * difficultyTexts.length)];
}

export function getTextCount(lang: string, difficulty: Difficulty = 'easy'): number {
	return texts[lang]?.[difficulty]?.length ?? 0;
}

export function getTextMeta(lang: string): TextMeta {
	return textMeta[lang] || textMeta.en;
}

export function getTextByNumber(lang: string, number: number, difficulty: Difficulty = 'easy'): TextItem | null {
	const langTexts = texts[lang]?.[difficulty];
	if (!langTexts) return null;
	return langTexts.find(item => item.number === number) || null;
}

export function getAllTexts(lang: string, difficulty: Difficulty = 'easy'): TextItem[] {
	return texts[lang]?.[difficulty] || [];
}

export const difficulties: Difficulty[] = ['easy', 'medium', 'hard', 'expert'];
