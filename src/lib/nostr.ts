import type { Identity } from './identity.js';
import type { RaceResult } from './types.js';
import type { Event as NostrEvent } from 'nostr-tools';
import { finalizeEvent, verifyEvent, nip19 } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

function toHexPubkey(npubOrHex: string): string {
	if (!npubOrHex) return npubOrHex;
	if (npubOrHex.startsWith('npub')) {
		try {
			const { data } = nip19.decode(npubOrHex);
			return data as string;
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

const RIGHTER_EVENT_KIND = 30078;
const RACE_TAG_PREFIX = 'righter:race:';
const ROOM_TAG_PREFIX = 'righter:room:';
const CONNECT_TIMEOUT = 5000;
const FETCH_TIMEOUT = 8000;
const PUBLISH_TIMEOUT = 5000;

async function connectWithTimeout(url: string): Promise<Relay | null> {
	try {
		const relay = await Relay.connect(url);
		return relay;
	} catch {
		return null;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('Timeout')), ms)
		)
	]);
}

export async function publishRace(
	race: RaceResult,
	identity: Identity,
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<{ success: number; failed: number }> {
	const event = {
		kind: RIGHTER_EVENT_KIND,
		created_at: Math.floor(race.timestamp / 1000),
		tags: [
			['d', RACE_TAG_PREFIX + race.raceId],
			['k', race.keyboard],
			['room', race.room],
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

interface RaceFilter {
	keyboard?: string;
	odyseeId?: string;
	since?: number;
	limit?: number;
}

export async function fetchRaces(
	filter: RaceFilter = {},
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<RaceResult[]> {
	const races = new Map<string, RaceResult>();

	const nostrFilter: Record<string, unknown> = {
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
				new Promise<NostrEvent[]>((resolve) => {
					const collected: NostrEvent[] = [];
					const sub = relay.subscribe([nostrFilter], {
						onevent(event: NostrEvent) {
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
					const race: RaceResult = JSON.parse(event.content);
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

export async function fetchMyRaces(
	odyseeId: string,
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<RaceResult[]> {
	return fetchRaces({ odyseeId }, relayUrls);
}

export async function fetchKeyboardRaces(
	keyboard: string,
	limit = 50,
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<RaceResult[]> {
	return fetchRaces({ keyboard, limit }, relayUrls);
}

export function generateRaceId(room: string, startTime: number | null, textPreview: string): string {
	const data = `${room}:${startTime}:${textPreview.slice(0, 50)}`;
	let hash = 0;
	for (let i = 0; i < data.length; i++) {
		const char = data.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash;
	}
	return Math.abs(hash).toString(36);
}

export async function checkRelays(
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<{ url: string; ok: boolean }[]> {
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

interface RoomParticipant {
	odyseeId: string;
	pubkeyHex: string;
	name: string;
	color: number;
	joinedAt: number;
}

interface RoomInfo {
	roomCode: string;
	keyboard: string;
	status: string;
	createdAt: number;
	participants: RoomParticipant[];
}

interface RoomPresence extends RoomParticipant {
	roomCode: string;
	keyboard: string;
	status: string;
	_createdAt?: number;
}

export async function publishRoomPresence(
	roomCode: string,
	identity: Identity,
	keyboard: string,
	status = 'waiting',
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<{ success: number; failed: number }> {
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

export async function fetchRoomParticipants(
	roomCode: string,
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<RoomParticipant[]> {
	const participants = new Map<string, RoomPresence>();
	const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

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
				new Promise<NostrEvent[]>((resolve) => {
					const collected: NostrEvent[] = [];
					const sub = relay.subscribe([nostrFilter], {
						onevent(event: NostrEvent) {
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

					const presence: RoomPresence = JSON.parse(event.content);
					if (presence.roomCode !== roomCode) continue;
					if (presence.status !== 'waiting') continue;

					const existing = participants.get(presence.pubkeyHex);
					if (!existing || event.created_at > (existing._createdAt ?? 0)) {
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

	const now = Date.now();
	return Array.from(participants.values())
		.filter(p => now - p.joinedAt < 5 * 60 * 1000)
		.map(({ _createdAt, roomCode: _rc, keyboard: _kb, status: _st, ...p }) => p)
		.sort((a, b) => a.joinedAt - b.joinedAt);
}

export async function fetchActiveRooms(
	keyboard?: string,
	relayUrls: string[] = DEFAULT_RELAYS
): Promise<RoomInfo[]> {
	const roomParticipants = new Map<string, Map<string, RoomPresence>>();
	const fiveMinutesAgo = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);

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
				new Promise<NostrEvent[]>((resolve) => {
					const collected: NostrEvent[] = [];
					const sub = relay.subscribe([nostrFilter], {
						onevent(event: NostrEvent) {
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

					const presence: RoomPresence = JSON.parse(event.content);
					if (!presence.roomCode || presence.status !== 'waiting') continue;
					if (keyboard && presence.keyboard !== keyboard) continue;

					if (!roomParticipants.has(presence.roomCode)) {
						roomParticipants.set(presence.roomCode, new Map());
					}
					const participantsMap = roomParticipants.get(presence.roomCode)!;

					const existing = participantsMap.get(presence.pubkeyHex);
					if (!existing || event.created_at > (existing._createdAt ?? 0)) {
						participantsMap.set(presence.pubkeyHex, { ...presence, _createdAt: event.created_at });
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

	const now = Date.now();
	const rooms: RoomInfo[] = [];

	for (const [code, participantsMap] of roomParticipants) {
		const participantsList = Array.from(participantsMap.values())
			.filter(p => now - p.joinedAt < 5 * 60 * 1000)
			.map(({ _createdAt, roomCode: _rc, keyboard: _kb, status: _st, ...p }) => p);

		if (participantsList.length === 0) continue;

		const first = participantsMap.values().next().value!;
		rooms.push({
			roomCode: code,
			keyboard: first.keyboard,
			status: 'waiting',
			createdAt: Math.min(...participantsList.map(p => p.joinedAt)),
			participants: participantsList
		});
	}

	return rooms.sort((a, b) => b.createdAt - a.createdAt);
}

export { DEFAULT_RELAYS };
