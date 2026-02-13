import ansi from './ansi.json';
import iso from './iso.json';
import enUS from './en-US.json';
import deDE from './de-DE.json';
import faIR from './fa-IR.json';
import esES from './es-ES.json';
import eurkey from './eurkey.json';
import ar from './ar.json';
import urPK from './ur-PK.json';
import psAF from './ps-AF.json';
import ckb from './ckb.json';
import sdPK from './sd-PK.json';
import ug from './ug.json';
import paArab from './pa-Arab.json';
import prs from './prs.json';
import ks from './ks.json';

interface PhysicalKey {
	code: string;
	iso?: string;
	width?: number;
	height?: number;
	modifier?: boolean;
	isoEnterTop?: boolean;
	isoEnterBottom?: boolean;
	spacer?: boolean;
}

interface PhysicalRow {
	keys: PhysicalKey[];
}

interface PhysicalLayout {
	rows: PhysicalRow[];
}

interface LanguageMapping {
	direction?: string;
	layers: {
		default?: Record<string, string>;
		shift?: Record<string, string>;
		altgr?: Record<string, string>;
	};
	labels?: Record<string, string>;
}

export interface BuiltKey {
	code: string;
	iso?: string;
	width?: number;
	height?: number;
	modifier?: boolean;
	isoEnterTop?: boolean;
	isoEnterBottom?: boolean;
	spacer?: boolean;
	chars: (string | undefined)[];
	label?: string;
}

export interface BuiltKeyboard {
	physical: PhysicalLayout;
	mapping: LanguageMapping;
	rows: { keys: BuiltKey[] }[];
}

export interface KeyboardGroup {
	name: string;
	keyboards: string[];
}

export const physicalLayouts: Record<string, PhysicalLayout> = {
	ansi: ansi as PhysicalLayout,
	iso: iso as PhysicalLayout
};

export const languageMappings: Record<string, LanguageMapping> = {
	'en-US': enUS as LanguageMapping,
	'de-DE': deDE as LanguageMapping,
	'fa-IR': faIR as LanguageMapping,
	'es-ES': esES as LanguageMapping,
	'eurkey': eurkey as LanguageMapping,
	'ar': ar as LanguageMapping,
	'ur-PK': urPK as LanguageMapping,
	'ps-AF': psAF as LanguageMapping,
	'ckb': ckb as LanguageMapping,
	'sd-PK': sdPK as LanguageMapping,
	'ug': ug as LanguageMapping,
	'pa-Arab': paArab as LanguageMapping,
	'prs': prs as LanguageMapping,
	'ks': ks as LanguageMapping
};

export const keyboardGroups: KeyboardGroup[] = [
	{
		name: 'Latin',
		keyboards: ['en-US', 'de-DE', 'es-ES']
	},
	{
		name: 'Arabic Script',
		keyboards: ['ar', 'fa-IR', 'ur-PK', 'ps-AF', 'prs', 'ckb', 'sd-PK', 'ug', 'pa-Arab', 'ks']
	}
];

export function getPhysicalLayout(name: string): PhysicalLayout {
	return physicalLayouts[name] || physicalLayouts.ansi;
}

export function getLanguageMapping(locale: string): LanguageMapping {
	return languageMappings[locale] || languageMappings['en-US'];
}

export function buildKeyboard(physicalLayoutName: string, locale: string): BuiltKeyboard {
	const physical = getPhysicalLayout(physicalLayoutName);
	const mapping = getLanguageMapping(locale);

	return {
		physical,
		mapping,
		rows: physical.rows.map((row) => ({
			keys: row.keys.map((key) => {
				const chars: (string | undefined)[] = [];
				const defaultChar = mapping.layers.default?.[key.code];
				const shiftChar = mapping.layers.shift?.[key.code];
				const altgrChar = mapping.layers.altgr?.[key.code];

				if (defaultChar !== undefined) chars[0] = defaultChar;
				if (shiftChar !== undefined) chars[1] = shiftChar;
				if (altgrChar !== undefined) chars[2] = altgrChar;

				const label = mapping.labels?.[key.code];

				return {
					code: key.code,
					iso: key.iso,
					width: key.width,
					height: key.height,
					modifier: key.modifier,
					isoEnterTop: key.isoEnterTop,
					isoEnterBottom: key.isoEnterBottom,
					spacer: key.spacer,
					chars,
					label
				};
			})
		}))
	};
}

export function getCharacter(mapping: LanguageMapping, code: string, modifiers: { shift: boolean; altgr: boolean }): string | null {
	const { shift, altgr } = modifiers;
	const layers = mapping.layers;

	if (altgr && layers.altgr?.[code]) {
		return layers.altgr[code];
	}
	if (shift && layers.shift?.[code]) {
		return layers.shift[code];
	}
	return layers.default?.[code] || null;
}

export function isRTL(locale: string): boolean {
	const mapping = languageMappings[locale];
	return mapping?.direction === 'rtl';
}
