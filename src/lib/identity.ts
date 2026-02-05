import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { generateName, generateColor } from './names.js';
import type { Identity } from './types.js';

export type { Identity };

const IDENTITY_KEY = 'righter_identity';

export function loadIdentity(rtl = false): Identity {
	if (typeof localStorage === 'undefined') {
		return createIdentity(rtl);
	}

	try {
		const stored = localStorage.getItem(IDENTITY_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			const secretKey = new Uint8Array(parsed.secretKeyArray);
			const pubkeyHex = getPublicKey(secretKey);
			return {
				odyseeId: parsed.odyseeId,
				secretKey,
				pubkeyHex,
				name: parsed.name,
				color: parsed.color
			};
		}
	} catch {
		// Corrupted data, create new
	}

	const identity = createIdentity(rtl);
	saveIdentity(identity);
	return identity;
}

function createIdentity(rtl = false): Identity {
	const secretKey = generateSecretKey();
	const pubkeyHex = getPublicKey(secretKey);
	const odyseeId = nip19.npubEncode(pubkeyHex);

	return {
		odyseeId,
		secretKey,
		pubkeyHex,
		name: generateName(rtl),
		color: generateColor()
	};
}

export function saveIdentity(identity: Identity): void {
	if (typeof localStorage === 'undefined') return;

	const toStore = {
		odyseeId: identity.odyseeId,
		secretKeyArray: Array.from(identity.secretKey),
		name: identity.name,
		color: identity.color
	};

	localStorage.setItem(IDENTITY_KEY, JSON.stringify(toStore));
}

export function updateName(identity: Identity, newName: string): Identity {
	const updated = { ...identity, name: newName.trim() || identity.name };
	saveIdentity(updated);
	return updated;
}

export function updateColor(identity: Identity, newColor: number): Identity {
	const updated = { ...identity, color: newColor };
	saveIdentity(updated);
	return updated;
}

export function shortId(npub: string): string {
	return npub.slice(0, 12) + '...';
}

export function exportIdentity(identity: Identity): string {
	const nsec = nip19.nsecEncode(identity.secretKey);
	return JSON.stringify({
		npub: identity.odyseeId,
		nsec,
		name: identity.name,
		color: identity.color
	}, null, 2);
}

export function importIdentity(json: string): Identity {
	const parsed = JSON.parse(json);
	const { data: secretKey } = nip19.decode(parsed.nsec);
	const pubkeyHex = getPublicKey(secretKey as Uint8Array);
	const odyseeId = nip19.npubEncode(pubkeyHex);

	const identity: Identity = {
		odyseeId,
		secretKey: secretKey as Uint8Array,
		pubkeyHex,
		name: parsed.name || generateName(),
		color: parsed.color ?? generateColor()
	};

	saveIdentity(identity);
	return identity;
}
