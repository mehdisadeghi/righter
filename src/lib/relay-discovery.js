// NIP-66 Relay Discovery and Righter relay preferences
import { finalizeEvent, verifyEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

const NIP66_KIND = 30166; // Relay discovery events
const RIGHTER_RELAY_KIND = 30079; // App-specific relay preferences (NIP-78 range)
const CONNECT_TIMEOUT = 5000;
const FETCH_TIMEOUT = 8000;

// Known NIP-66 monitor relays
const MONITOR_RELAYS = [
	'wss://relay.nostr.watch',
	'wss://history.nostr.watch'
];

// Fallback relays if NIP-66 discovery fails
const FALLBACK_RELAYS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.snort.social',
	'wss://nostr.mom',
	'wss://relay.nostr.band'
];

/**
 * @typedef {Object} RelayInfo
 * @property {string} url
 * @property {number} rttOpen - Open round-trip time in ms
 * @property {number} rttRead - Read round-trip time in ms
 * @property {number} rttWrite - Write round-trip time in ms
 * @property {string[]} nips - Supported NIPs
 * @property {string|null} relayType - Relay type (e.g., PrivateInbox, Search)
 * @property {boolean} requiresPayment
 * @property {boolean} requiresAuth
 */

/**
 * Connect to relay with timeout
 * @param {string} url
 * @returns {Promise<Relay|null>}
 */
async function connectWithTimeout(url) {
	try {
		const relay = await Promise.race([
			Relay.connect(url),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Timeout')), CONNECT_TIMEOUT)
			)
		]);
		return relay;
	} catch {
		return null;
	}
}

/**
 * Parse NIP-66 event into RelayInfo
 * @param {Object} event
 * @returns {RelayInfo|null}
 */
function parseNip66Event(event) {
	const tags = event.tags;
	const dTag = tags.find(t => t[0] === 'd');
	if (!dTag || !dTag[1]) return null;

	const url = dTag[1];
	if (!url.startsWith('wss://')) return null;

	const rttOpen = parseInt(tags.find(t => t[0] === 'rtt-open')?.[1]) || 9999;
	const rttRead = parseInt(tags.find(t => t[0] === 'rtt-read')?.[1]) || 9999;
	const rttWrite = parseInt(tags.find(t => t[0] === 'rtt-write')?.[1]) || 9999;

	const nips = tags.filter(t => t[0] === 'N').map(t => t[1]);
	const requirements = tags.filter(t => t[0] === 'R').map(t => t[1]);
	const relayType = tags.find(t => t[0] === 'T')?.[1] || null;

	return {
		url,
		rttOpen,
		rttRead,
		rttWrite,
		nips,
		relayType,
		requiresPayment: requirements.includes('payment'),
		requiresAuth: requirements.includes('auth')
	};
}

// Relay types that are specialized and won't accept arbitrary events
const RESTRICTED_TYPES = new Set([
	'PrivateInbox',
	'Search',
	'Git',
	'DVM',
	'Media',
	'Blossom',
	'Inbox',
	'ReadOnly',
	'Archive'
]);

/**
 * Fetch fast relays using NIP-66 discovery
 * Filters out specialized relays that restrict event kinds
 * @param {number} count - Number of relays to return
 * @returns {Promise<string[]>} - Array of relay URLs sorted by speed
 */
export async function fetchFastRelays(count = 5) {
	const relays = new Map(); // url -> RelayInfo

	for (const monitorUrl of MONITOR_RELAYS) {
		try {
			const relay = await connectWithTimeout(monitorUrl);
			if (!relay) continue;

			const events = await new Promise((resolve) => {
				const collected = [];
				const filter = {
					kinds: [NIP66_KIND],
					limit: 500
				};

				const sub = relay.subscribe([filter], {
					onevent(event) {
						if (verifyEvent(event)) {
							collected.push(event);
						}
					},
					oneose() {
						sub.close();
						resolve(collected);
					}
				});

				setTimeout(() => {
					sub.close();
					resolve(collected);
				}, FETCH_TIMEOUT);
			});

			relay.close();

			for (const event of events) {
				const info = parseNip66Event(event);
				if (!info) continue;

				// Skip specialized relay types
				if (info.relayType && RESTRICTED_TYPES.has(info.relayType)) continue;

				// Skip paid/auth relays
				if (info.requiresPayment || info.requiresAuth) continue;

				// Skip relays with paths (often specialized)
				if (new URL(info.url).pathname !== '/') continue;

				// Skip slow relays
				if (info.rttOpen > 500) continue;

				// Keep best RTT per relay
				const existing = relays.get(info.url);
				if (!existing || info.rttOpen < existing.rttOpen) {
					relays.set(info.url, info);
				}
			}

			if (relays.size >= count * 3) break;
		} catch {
			// Monitor failed, try next
		}
	}

	if (relays.size === 0) {
		return FALLBACK_RELAYS.slice(0, count);
	}

	// Sort by RTT and return top N
	return Array.from(relays.values())
		.sort((a, b) => (a.rttOpen + a.rttWrite) - (b.rttOpen + b.rttWrite))
		.slice(0, count)
		.map(r => r.url);
}

/**
 * Publish righter's relay preferences so peers can discover us
 * @param {import('./identity.js').Identity} identity
 * @param {string[]} relayUrls - Relays we're using for racing
 * @param {string[]} publishTo - Relays to publish this announcement to
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function publishRelayPreferences(identity, relayUrls, publishTo) {
	const event = {
		kind: RIGHTER_RELAY_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			['d', 'righter:relays'],
			['client', 'righter'],
			...relayUrls.map(url => ['r', url])
		],
		content: JSON.stringify({
			app: 'righter',
			version: '1.0',
			relays: relayUrls,
			updated: Date.now()
		})
	};

	const signedEvent = finalizeEvent(event, identity.secretKey);

	let success = 0;
	let failed = 0;

	const publishPromises = publishTo.map(async (url) => {
		try {
			const relay = await connectWithTimeout(url);
			if (!relay) {
				failed++;
				return;
			}

			await relay.publish(signedEvent);
			relay.close();
			success++;
		} catch {
			failed++;
		}
	});

	await Promise.allSettled(publishPromises);
	return { success, failed };
}

/**
 * Fetch relay preferences published by a specific user
 * @param {string} pubkeyHex
 * @param {string[]} relayUrls - Relays to query
 * @returns {Promise<string[]|null>} - User's preferred relays or null
 */
export async function fetchUserRelayPreferences(pubkeyHex, relayUrls) {
	for (const url of relayUrls) {
		try {
			const relay = await connectWithTimeout(url);
			if (!relay) continue;

			const event = await new Promise((resolve) => {
				let found = null;
				const filter = {
					kinds: [RIGHTER_RELAY_KIND],
					authors: [pubkeyHex],
					'#d': ['righter:relays'],
					limit: 1
				};

				const sub = relay.subscribe([filter], {
					onevent(event) {
						if (verifyEvent(event)) {
							found = event;
						}
					},
					oneose() {
						sub.close();
						resolve(found);
					}
				});

				setTimeout(() => {
					sub.close();
					resolve(found);
				}, FETCH_TIMEOUT);
			});

			relay.close();

			if (event) {
				try {
					const content = JSON.parse(event.content);
					if (content.relays && Array.isArray(content.relays)) {
						return content.relays;
					}
				} catch {}
			}
		} catch {
			// Try next relay
		}
	}

	return null;
}

export { FALLBACK_RELAYS, MONITOR_RELAYS };
