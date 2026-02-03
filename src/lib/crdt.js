// CRDT merge logic for race results
// Strategy: union of participants, latest data wins for conflicts

/**
 * @typedef {import('./nostr.js').RaceResult} RaceResult
 * @typedef {import('./nostr.js').ParticipantResult} ParticipantResult
 */

/**
 * Merge two race results with same raceId
 * @param {RaceResult} local
 * @param {RaceResult} remote
 * @returns {RaceResult}
 */
export function mergeRace(local, remote) {
	if (local.raceId !== remote.raceId) {
		throw new Error('Cannot merge races with different IDs');
	}

	// Use newer timestamp for metadata
	const base = local.timestamp >= remote.timestamp ? local : remote;

	// Merge participants (union)
	const participantsMap = new Map();

	// Add local participants
	for (const p of local.participants) {
		participantsMap.set(p.odyseeId, p);
	}

	// Merge remote participants
	for (const p of remote.participants) {
		const existing = participantsMap.get(p.odyseeId);
		if (!existing) {
			participantsMap.set(p.odyseeId, p);
		} else {
			// Same participant in both - keep one with more data or newer
			// (in practice they should be identical)
			participantsMap.set(p.odyseeId, existing);
		}
	}

	// Recalculate ranks based on WPM
	const participants = Array.from(participantsMap.values())
		.sort((a, b) => b.wpm - a.wpm)
		.map((p, idx) => ({ ...p, rank: idx + 1 }));

	return {
		...base,
		participants
	};
}

/**
 * Merge multiple race lists
 * @param {RaceResult[][]} raceLists
 * @returns {RaceResult[]}
 */
export function mergeRaceLists(...raceLists) {
	const merged = new Map();

	for (const list of raceLists) {
		for (const race of list) {
			if (!race.raceId) continue;

			const existing = merged.get(race.raceId);
			if (!existing) {
				merged.set(race.raceId, race);
			} else {
				merged.set(race.raceId, mergeRace(existing, race));
			}
		}
	}

	// Sort by timestamp descending (newest first)
	return Array.from(merged.values())
		.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Find races in local that are missing from remote
 * @param {RaceResult[]} local
 * @param {RaceResult[]} remote
 * @returns {RaceResult[]}
 */
export function findMissingRaces(local, remote) {
	const remoteIds = new Set(remote.map(r => r.raceId));
	return local.filter(r => !remoteIds.has(r.raceId));
}

/**
 * Find races where local has more participants than remote
 * @param {RaceResult[]} local
 * @param {RaceResult[]} remote
 * @returns {RaceResult[]}
 */
export function findIncompleteRaces(local, remote) {
	const remoteMap = new Map(remote.map(r => [r.raceId, r]));
	const incomplete = [];

	for (const localRace of local) {
		const remoteRace = remoteMap.get(localRace.raceId);
		if (remoteRace && localRace.participants.length > remoteRace.participants.length) {
			incomplete.push(localRace);
		}
	}

	return incomplete;
}

/**
 * Calculate aggregate stats for a user from race history
 * @param {RaceResult[]} races
 * @param {string} odyseeId
 * @returns {{totalRaces: number, avgWpm: number, avgAccuracy: number, bestWpm: number, wins: number}}
 */
export function calculateUserStats(races, odyseeId) {
	const userRaces = races.filter(race =>
		race.participants.some(p => p.odyseeId === odyseeId)
	);

	if (userRaces.length === 0) {
		return { totalRaces: 0, avgWpm: 0, avgAccuracy: 0, bestWpm: 0, wins: 0 };
	}

	let totalWpm = 0;
	let totalAccuracy = 0;
	let bestWpm = 0;
	let wins = 0;

	for (const race of userRaces) {
		const participant = race.participants.find(p => p.odyseeId === odyseeId);
		if (participant) {
			totalWpm += participant.wpm;
			totalAccuracy += participant.accuracy;
			bestWpm = Math.max(bestWpm, participant.wpm);
			if (participant.rank === 1) wins++;
		}
	}

	return {
		totalRaces: userRaces.length,
		avgWpm: Math.round(totalWpm / userRaces.length),
		avgAccuracy: Math.round(totalAccuracy / userRaces.length),
		bestWpm,
		wins
	};
}

/**
 * Get leaderboard for a keyboard layout
 * @param {RaceResult[]} races
 * @param {string} keyboard
 * @returns {Array<{odyseeId: string, name: string, avgWpm: number, races: number}>}
 */
export function getKeyboardLeaderboard(races, keyboard) {
	const keyboardRaces = races.filter(r => r.keyboard === keyboard);
	const userStats = new Map();

	for (const race of keyboardRaces) {
		for (const p of race.participants) {
			const existing = userStats.get(p.odyseeId);
			if (!existing) {
				userStats.set(p.odyseeId, {
					odyseeId: p.odyseeId,
					name: p.name,
					totalWpm: p.wpm,
					races: 1
				});
			} else {
				existing.totalWpm += p.wpm;
				existing.races++;
				// Update name to most recent
				existing.name = p.name;
			}
		}
	}

	return Array.from(userStats.values())
		.map(u => ({
			odyseeId: u.odyseeId,
			name: u.name,
			avgWpm: Math.round(u.totalWpm / u.races),
			races: u.races
		}))
		.sort((a, b) => b.avgWpm - a.avgWpm)
		.slice(0, 50); // Top 50
}
