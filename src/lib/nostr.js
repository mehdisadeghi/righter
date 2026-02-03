// Nostr relay communication with timeouts and fallbacks
import { finalizeEvent, verifyEvent, nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

/**
 * Convert npub to hex pubkey
 * @param {string} npubOrHex
 * @returns {string} hex pubkey
 */
function toHexPubkey(npubOrHex) {
	if (!npubOrHex) return npubOrHex;
	if (npubOrHex.startsWith('npub')) {
		try {
			const { data } = nip19.decode(npubOrHex);
			return data;
		} catch {
			return npubOrHex;
		}
	}
	return npubOrHex;
}

const DEFAULT_RELAYS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.primal.net'
];

const RIGHTER_EVENT_KIND = 30078; // NIP-78 arbitrary app data
const RACE_TAG_PREFIX = 'righter:race:';
const ROOM_TAG_PREFIX = 'righter:room:';
const CONNECT_TIMEOUT = 5000;
const FETCH_TIMEOUT = 8000;
const PUBLISH_TIMEOUT = 5000;

/**
 * @typedef {Object} RaceResult
 * @property {string} raceId
 * @property {number} timestamp
 * @property {string} room
 * @property {string} keyboard
 * @property {number} duration
 * @property {string} textPreview
 * @property {Array<ParticipantResult>} participants
 */

/**
 * @typedef {Object} ParticipantResult
 * @property {string} odyseeId - npub
 * @property {string} name
 * @property {number} color
 * @property {number} wpm
 * @property {number} accuracy
 * @property {number} rank
 */

/**
 * Connect to a relay with timeout
 * @param {string} url
 * @returns {Promise<Relay|null>}
 */
async function connectWithTimeout(url) {
	try {
		const relay = await Relay.connect(url);
		return relay;
	} catch {
		return null;
	}
}

/**
 * Wrap promise with timeout
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('Timeout')), ms)
		)
	]);
}

/**
 * Publish race result to relays
 * @param {RaceResult} race
 * @param {import('./identity.js').Identity} identity
 * @param {string[]} relayUrls
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function publishRace(race, identity, relayUrls = DEFAULT_RELAYS) {
	const event = {
		kind: RIGHTER_EVENT_KIND,
		created_at: Math.floor(race.timestamp / 1000),
		tags: [
			['d', RACE_TAG_PREFIX + race.raceId],
			['k', race.keyboard],
			['room', race.room],
			// Tag all participants for queryability (convert npub to hex)
			...race.participants.map(p => ['p', toHexPubkey(p.odyseeId)])
		],
		content: JSON.stringify(race)
	};

	const signedEvent = finalizeEvent(event, identity.secretKey);

	let success = 0;
	let failed = 0;

	const publishPromises = relayUrls.map(async (url) => {
		try {
			const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
			if (!relay) {
				failed++;
				return;
			}

			await withTimeout(relay.publish(signedEvent), PUBLISH_TIMEOUT);
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
 * Fetch races from relays
 * @param {Object} filter
 * @param {string} [filter.keyboard] - Filter by keyboard
 * @param {string} [filter.odyseeId] - Filter by participant npub
 * @param {number} [filter.since] - Unix timestamp
 * @param {number} [filter.limit]
 * @param {string[]} relayUrls
 * @returns {Promise<RaceResult[]>}
 */
export async function fetchRaces(filter = {}, relayUrls = DEFAULT_RELAYS) {
	const races = new Map(); // raceId -> RaceResult

	const nostrFilter = {
		kinds: [RIGHTER_EVENT_KIND],
		limit: filter.limit || 100
	};

	if (filter.keyboard) {
		nostrFilter['#k'] = [filter.keyboard];
	}
	if (filter.odyseeId) {
		nostrFilter['#p'] = [toHexPubkey(filter.odyseeId)];
	}
	if (filter.since) {
		nostrFilter.since = Math.floor(filter.since / 1000);
	}

	const fetchPromises = relayUrls.map(async (url) => {
		try {
			const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
			if (!relay) return;

			const events = await withTimeout(
				new Promise((resolve) => {
					const collected = [];
					const sub = relay.subscribe([nostrFilter], {
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
					// Fallback timeout for oneose
					setTimeout(() => {
						sub.close();
						resolve(collected);
					}, FETCH_TIMEOUT - 1000);
				}),
				FETCH_TIMEOUT
			);

			relay.close();

			for (const event of events) {
				try {
					const race = JSON.parse(event.content);
					if (race.raceId && !races.has(race.raceId)) {
						races.set(race.raceId, race);
					}
				} catch {
					// Invalid content
				}
			}
		} catch {
			// Relay failed, continue with others
		}
	});

	await Promise.allSettled(fetchPromises);
	return Array.from(races.values());
}

/**
 * Fetch races where user participated
 * @param {string} odyseeId - npub
 * @param {string[]} relayUrls
 * @returns {Promise<RaceResult[]>}
 */
export async function fetchMyRaces(odyseeId, relayUrls = DEFAULT_RELAYS) {
	return fetchRaces({ odyseeId }, relayUrls);
}

/**
 * Fetch races for a specific keyboard
 * @param {string} keyboard
 * @param {number} limit
 * @param {string[]} relayUrls
 * @returns {Promise<RaceResult[]>}
 */
export async function fetchKeyboardRaces(keyboard, limit = 50, relayUrls = DEFAULT_RELAYS) {
	return fetchRaces({ keyboard, limit }, relayUrls);
}

/**
 * Generate deterministic race ID
 * @param {string} room
 * @param {number} startTime
 * @param {string} textPreview
 * @returns {string}
 */
export function generateRaceId(room, startTime, textPreview) {
	const data = `${room}:${startTime}:${textPreview.slice(0, 50)}`;
	// Simple hash
	let hash = 0;
	for (let i = 0; i < data.length; i++) {
		const char = data.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36);
}

/**
 * Check if relays are reachable (quick health check)
 * @param {string[]} relayUrls
 * @returns {Promise<{url: string, ok: boolean}[]>}
 */
export async function checkRelays(relayUrls = DEFAULT_RELAYS) {
	const results = await Promise.all(
		relayUrls.map(async (url) => {
			try {
				const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
				if (relay) {
					relay.close();
					return { url, ok: true };
				}
				return { url, ok: false };
			} catch {
				return { url, ok: false };
			}
		})
	);
	return results;
}

/**
 * @typedef {Object} RoomParticipant
 * @property {string} odyseeId - npub
 * @property {string} pubkeyHex
 * @property {string} name
 * @property {number} color
 * @property {number} joinedAt
 */

/**
 * @typedef {Object} RoomInfo
 * @property {string} roomCode
 * @property {string} keyboard
 * @property {string} status - waiting, racing, finished
 * @property {number} createdAt
 * @property {RoomParticipant[]} participants
 */

/**
 * Publish room participant (each user publishes their own presence)
 * @param {string} roomCode
 * @param {import('./identity.js').Identity} identity
 * @param {string} keyboard
 * @param {string} status
 * @param {string[]} relayUrls
 * @returns {Promise<{success: number, failed: number}>}
 */
export async function publishRoomPresence(roomCode, identity, keyboard, status = 'waiting', relayUrls = DEFAULT_RELAYS) {
	const presence = {
		roomCode,
		odyseeId: identity.odyseeId,
		pubkeyHex: identity.pubkeyHex,
		name: identity.name,
		color: identity.color,
		keyboard,
		status,
		joinedAt: Date.now()
	};

	const event = {
		kind: RIGHTER_EVENT_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags: [
			['d', ROOM_TAG_PREFIX + roomCode + ':' + identity.pubkeyHex],
			['room', roomCode],
			['k', keyboard],
			['status', status]
		],
		content: JSON.stringify(presence)
	};

	const signedEvent = finalizeEvent(event, identity.secretKey);

	// Publish to first 2 working relays (peers may be on different relays)
	let success = 0;
	const targetCount = Math.min(2, relayUrls.length);

	for (const url of relayUrls) {
		if (success >= targetCount) break;
		try {
			const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
			if (!relay) continue;

			await withTimeout(relay.publish(signedEvent), PUBLISH_TIMEOUT);
			relay.close();
			success++;
		} catch {
			// Try next relay
		}
	}
	return { success, failed: relayUrls.length - success };
}

/**
 * Fetch participants in a specific room
 * @param {string} roomCode
 * @param {string[]} relayUrls
 * @returns {Promise<RoomParticipant[]>}
 */
export async function fetchRoomParticipants(roomCode, relayUrls = DEFAULT_RELAYS) {
	const participants = new Map();
	const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

	// Fetch recent events and filter client-side (custom tags not indexed)
	const nostrFilter = {
		kinds: [RIGHTER_EVENT_KIND],
		since: fiveMinutesAgo,
		limit: 200
	};

	const fetchPromises = relayUrls.map(async (url) => {
		try {
			const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
			if (!relay) return;

			const events = await withTimeout(
				new Promise((resolve) => {
					const collected = [];
					const sub = relay.subscribe([nostrFilter], {
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
					}, FETCH_TIMEOUT - 1000);
				}),
				FETCH_TIMEOUT
			);

			relay.close();

			for (const event of events) {
				try {
					const dTag = event.tags.find(t => t[0] === 'd')?.[1];
					if (!dTag?.startsWith(ROOM_TAG_PREFIX)) continue;

					const presence = JSON.parse(event.content);
					if (presence.roomCode !== roomCode) continue;
					if (presence.status !== 'waiting') continue;

					// Keep most recent presence per user
					const existing = participants.get(presence.pubkeyHex);
					if (!existing || event.created_at > existing._createdAt) {
						participants.set(presence.pubkeyHex, { ...presence, _createdAt: event.created_at });
					}
				} catch {
					// Invalid content
				}
			}
		} catch {
			// Relay failed
		}
	});

	await Promise.allSettled(fetchPromises);

	// Filter to only recent participants (joined in last 5 minutes)
	const now = Date.now();
	return Array.from(participants.values())
		.filter(p => now - p.joinedAt < 5 * 60 * 1000)
		.map(({ _createdAt, ...p }) => p)
		.sort((a, b) => a.joinedAt - b.joinedAt);
}

/**
 * Fetch active rooms (waiting status, created in last 5 minutes)
 * Aggregates participants from individual presence events
 * @param {string} [keyboard] - Optional filter by keyboard
 * @param {string[]} relayUrls
 * @returns {Promise<RoomInfo[]>}
 */
export async function fetchActiveRooms(keyboard, relayUrls = DEFAULT_RELAYS) {
	const roomParticipants = new Map(); // roomCode -> Map<pubkey, presence>
	const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

	// Fetch recent presence events
	const nostrFilter = {
		kinds: [RIGHTER_EVENT_KIND],
		since: fiveMinutesAgo,
		limit: 200
	};

	const fetchPromises = relayUrls.map(async (url) => {
		try {
			const relay = await withTimeout(connectWithTimeout(url), CONNECT_TIMEOUT);
			if (!relay) return;

			const events = await withTimeout(
				new Promise((resolve) => {
					const collected = [];
					const sub = relay.subscribe([nostrFilter], {
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
					}, FETCH_TIMEOUT - 1000);
				}),
				FETCH_TIMEOUT
			);

			relay.close();

			for (const event of events) {
				try {
					const dTag = event.tags.find(t => t[0] === 'd')?.[1];
					if (!dTag?.startsWith(ROOM_TAG_PREFIX)) continue;

					const presence = JSON.parse(event.content);
					if (!presence.roomCode || presence.status !== 'waiting') continue;
					if (keyboard && presence.keyboard !== keyboard) continue;

					// Group by room
					if (!roomParticipants.has(presence.roomCode)) {
						roomParticipants.set(presence.roomCode, new Map());
					}
					const participants = roomParticipants.get(presence.roomCode);

					// Keep most recent presence per user
					const existing = participants.get(presence.pubkeyHex);
					if (!existing || event.created_at > existing._createdAt) {
						participants.set(presence.pubkeyHex, { ...presence, _createdAt: event.created_at });
					}
				} catch {
					// Invalid content
				}
			}
		} catch {
			// Relay failed
		}
	});

	await Promise.allSettled(fetchPromises);

	// Build room list from participants
	const now = Date.now();
	const rooms = [];

	for (const [roomCode, participantsMap] of roomParticipants) {
		const participantsList = Array.from(participantsMap.values())
			.filter(p => now - p.joinedAt < 5 * 60 * 1000)
			.map(({ _createdAt, ...p }) => p);

		if (participantsList.length === 0) continue;

		// Use first participant's data for room info
		const first = participantsList[0];
		rooms.push({
			roomCode,
			keyboard: first.keyboard,
			status: 'waiting',
			createdAt: Math.min(...participantsList.map(p => p.joinedAt)),
			participants: participantsList
		});
	}

	return rooms.sort((a, b) => b.createdAt - a.createdAt);
}

export { DEFAULT_RELAYS };
