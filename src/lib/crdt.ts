import type { RaceResult, ParticipantResult } from './types.js';

export function mergeRace(local: RaceResult, remote: RaceResult): RaceResult {
	if (local.raceId !== remote.raceId) {
		throw new Error('Cannot merge races with different IDs');
	}

	const base = local.timestamp >= remote.timestamp ? local : remote;

	const participantsMap = new Map<string, ParticipantResult>();

	for (const p of local.participants) {
		participantsMap.set(p.odyseeId, p);
	}

	for (const p of remote.participants) {
		const existing = participantsMap.get(p.odyseeId);
		if (!existing) {
			participantsMap.set(p.odyseeId, p);
		} else {
			participantsMap.set(p.odyseeId, existing);
		}
	}

	const participants = Array.from(participantsMap.values())
		.sort((a, b) => b.wpm - a.wpm)
		.map((p, idx) => ({ ...p, rank: idx + 1 }));

	return {
		...base,
		participants
	};
}

export function mergeRaceLists(...raceLists: RaceResult[][]): RaceResult[] {
	const merged = new Map<string, RaceResult>();

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

	return Array.from(merged.values())
		.sort((a, b) => b.timestamp - a.timestamp);
}

export function findMissingRaces(local: RaceResult[], remote: RaceResult[]): RaceResult[] {
	const remoteIds = new Set(remote.map(r => r.raceId));
	return local.filter(r => !remoteIds.has(r.raceId));
}

export function findIncompleteRaces(local: RaceResult[], remote: RaceResult[]): RaceResult[] {
	const remoteMap = new Map(remote.map(r => [r.raceId, r]));
	const incomplete: RaceResult[] = [];

	for (const localRace of local) {
		const remoteRace = remoteMap.get(localRace.raceId);
		if (remoteRace && localRace.participants.length > remoteRace.participants.length) {
			incomplete.push(localRace);
		}
	}

	return incomplete;
}

interface UserStats {
	totalRaces: number;
	avgWpm: number;
	avgAccuracy: number;
	bestWpm: number;
	wins: number;
}

export function calculateUserStats(races: RaceResult[], odyseeId: string): UserStats {
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

interface LeaderboardEntry {
	odyseeId: string;
	name: string;
	avgWpm: number;
	races: number;
}

export function getKeyboardLeaderboard(races: RaceResult[], keyboard: string): LeaderboardEntry[] {
	const keyboardRaces = races.filter(r => r.keyboard === keyboard);
	const userStats = new Map<string, { odyseeId: string; name: string; totalWpm: number; races: number }>();

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
		.slice(0, 50);
}
