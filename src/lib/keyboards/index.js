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

export const physicalLayouts = {
	ansi,
	iso
};

export const languageMappings = {
	'en-US': enUS,
	'de-DE': deDE,
	'fa-IR': faIR,
	'es-ES': esES,
	'eurkey': eurkey,
	'ar': ar,
	'ur-PK': urPK,
	'ps-AF': psAF,
	'ckb': ckb,
	'sd-PK': sdPK,
	'ug': ug,
	'pa-Arab': paArab,
	'prs': prs,
	'ks': ks
};

// Group keyboards by script type for UI organization
export const keyboardGroups = [
	{
		name: 'Latin',
		keyboards: ['en-US', 'de-DE', 'es-ES', 'eurkey']
	},
	{
		name: 'Arabic Script',
		keyboards: ['ar', 'fa-IR', 'ur-PK', 'ps-AF', 'prs', 'ckb', 'sd-PK', 'ug', 'pa-Arab', 'ks']
	}
];

export function getPhysicalLayout(name) {
	return physicalLayouts[name] || physicalLayouts.ansi;
}

export function getLanguageMapping(locale) {
	return languageMappings[locale] || languageMappings['en-US'];
}

export function buildKeyboard(physicalLayoutName, locale) {
	const physical = getPhysicalLayout(physicalLayoutName);
	const mapping = getLanguageMapping(locale);

	return {
		physical,
		mapping,
		rows: physical.rows.map((row) => ({
			keys: row.keys.map((key) => {
				const chars = [];
				const defaultChar = mapping.layers.default?.[key.code];
				const shiftChar = mapping.layers.shift?.[key.code];
				const altgrChar = mapping.layers.altgr?.[key.code];

				if (defaultChar !== undefined) chars[0] = defaultChar;
				if (shiftChar !== undefined) chars[1] = shiftChar;
				if (altgrChar !== undefined) chars[2] = altgrChar;

				// Use label for special keys
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

export function getCharacter(mapping, code, modifiers) {
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

export function isRTL(locale) {
	const mapping = languageMappings[locale];
	return mapping?.direction === 'rtl';
}
