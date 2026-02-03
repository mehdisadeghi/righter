// User identity management using Nostr keypairs
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { generateName, generateColor } from './names.js';

const IDENTITY_KEY = 'righter_identity';

/**
 * @typedef {Object} Identity
 * @property {string} odyseeId - npub (public key in bech32)
 * @property {Uint8Array} secretKey - Private key bytes
 * @property {string} pubkeyHex - Public key in hex
 * @property {string} name - Display name
 * @property {number} color - Hue value (0-360)
 */

/**
 * Load or create user identity
 * @param {boolean} rtl - Whether to generate RTL-friendly name
 * @returns {Identity}
 */
export function loadIdentity(rtl = false) {
	if (typeof localStorage === 'undefined') {
		return createIdentity(rtl);
	}

	try {
		const stored = localStorage.getItem(IDENTITY_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			// Convert stored array back to Uint8Array
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

/**
 * Create a new identity
 * @param {boolean} rtl
 * @returns {Identity}
 */
function createIdentity(rtl = false) {
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

/**
 * Save identity to localStorage
 * @param {Identity} identity
 */
export function saveIdentity(identity) {
	if (typeof localStorage === 'undefined') return;

	const toStore = {
		odyseeId: identity.odyseeId,
		secretKeyArray: Array.from(identity.secretKey),
		name: identity.name,
		color: identity.color
	};

	localStorage.setItem(IDENTITY_KEY, JSON.stringify(toStore));
}

/**
 * Update display name
 * @param {Identity} identity
 * @param {string} newName
 * @returns {Identity}
 */
export function updateName(identity, newName) {
	const updated = { ...identity, name: newName.trim() || identity.name };
	saveIdentity(updated);
	return updated;
}

/**
 * Update color
 * @param {Identity} identity
 * @param {number} newColor
 * @returns {Identity}
 */
export function updateColor(identity, newColor) {
	const updated = { ...identity, color: newColor };
	saveIdentity(updated);
	return updated;
}

/**
 * Get short ID for display (first 8 chars of npub)
 * @param {string} npub
 * @returns {string}
 */
export function shortId(npub) {
	return npub.slice(0, 12) + '...';
}

/**
 * Export identity as JSON (for backup)
 * @param {Identity} identity
 * @returns {string}
 */
export function exportIdentity(identity) {
	const nsec = nip19.nsecEncode(identity.secretKey);
	return JSON.stringify({
		npub: identity.odyseeId,
		nsec,
		name: identity.name,
		color: identity.color
	}, null, 2);
}

/**
 * Import identity from JSON backup
 * @param {string} json
 * @returns {Identity}
 */
export function importIdentity(json) {
	const parsed = JSON.parse(json);
	const { data: secretKey } = nip19.decode(parsed.nsec);
	const pubkeyHex = getPublicKey(secretKey);
	const odyseeId = nip19.npubEncode(pubkeyHex);

	const identity = {
		odyseeId,
		secretKey,
		pubkeyHex,
		name: parsed.name || generateName(),
		color: parsed.color ?? generateColor()
	};

	saveIdentity(identity);
	return identity;
}
