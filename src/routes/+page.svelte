<script>
	import { onMount, tick } from 'svelte';
	import { base } from '$app/paths';
	import { replaceState } from '$app/navigation';
	import { t, getDirection, supportedLanguages } from '$lib/i18n.js';
	import { getRandomTextItem, getTextMeta, getTextCount, getTextByNumber } from '$lib/texts.js';
	import { buildKeyboard, languageMappings, keyboardGroups, isRTL } from '$lib/keyboards/index.js';
	import {
		loadData,
		saveData,
		addRaceResult,
		updateSettings,
		exportData,
		importData,
		clearHistory,
		resetSettings,
		saveLocalRace,
		getMyLocalRaces
	} from '$lib/storage.js';
	import { loadIdentity, updateName } from '$lib/identity.js';
	import { MultiplayerRoom, generateRoomCode, getRoomFromUrl, setRoomInUrl, clearRoomFromUrl } from '$lib/multiplayer-nostr.js';
	import { publishRace, fetchMyRaces, publishRoomPresence, fetchActiveRooms, fetchRoomParticipants, DEFAULT_RELAYS } from '$lib/nostr.js';
	import { fetchFastRelays } from '$lib/relay-discovery.js';
	import { mergeRaceLists, findMissingRaces } from '$lib/crdt.js';
	import { isWebGLAvailable, Parallax3DRenderer } from '$lib/parallax3d.js';

	const MODES = {
		time: [15, 30, 60, 120],
		text: [1, 3, 5, 10]
	};

	// Font options (per script)
	const FONTS_LATIN = [
		{ id: 'system', family: 'system-ui, -apple-system, sans-serif' },
		{ id: 'arial', family: 'Arial, Helvetica, sans-serif' },
		{ id: 'georgia', family: 'Georgia, serif' },
		{ id: 'times', family: '"Times New Roman", Times, serif' }
	];
	const FONTS_ARABIC = [
		{ id: 'vazirmatn', family: "'Vazirmatn', 'Tahoma', system-ui, sans-serif" },
		{ id: 'tahoma', family: "'Tahoma', 'Segoe UI', system-ui, sans-serif" },
		{ id: 'segoe', family: "'Segoe UI', 'Tahoma', system-ui, sans-serif" },
		{ id: 'system', family: 'system-ui, sans-serif' }
	];

	// Reliable public relays (curated list with good uptime)
	const RECOMMENDED_RELAYS = [
		'wss://relay.damus.io',
		'wss://nos.lol',
		'wss://relay.snort.social',
		'wss://nostr.mom',
		'wss://relay.nostr.band',
		'wss://nostr.mutinywallet.com'
	];

	let data = $state({
		settings: { uiLanguage: 'en', keyboardLocale: 'en-US', fontSize: 1.25, hue: 220, modeType: 'time', modeValue: 30, physicalLayout: 'ansi', showTyped: false },
		history: [],
		customTexts: { fa: '', en: '' }
	});

	let targetText = $state('');
	let currentTextItems = $state([]);
	let uploadedTexts = $state(null);
	let userInput = $state('');
	let startTime = $state(null);
	let endTime = $state(null);
	let isComplete = $state(false);
	let endlessMode = $state(false);
	let inputElement = $state(null);
	let textDisplayElement = $state(null);
	let timerInterval = $state(null);
	let now = $state(Date.now());
	let scrollOffset = $state(0);

	// Background lanes (space invaders parallax effect)
	let backgroundLanes = $state([]);
	let laneIdCounter = $state(0);
	let lastSpawnedLineIndex = $state(-1);
	let laneSpawnInterval = $state(null);
	const LANE_POOL_SIZE = 15;

	// Three.js 3D parallax renderer
	let parallax3dRenderer = $state(null);
	let parallax3dContainer = $state(null);
	let webglAvailable = $state(false);

	// Settings panel toggle
	let showMoreSettings = $state(false);
	// Will be loaded from sessionStorage on mount
	let customModeValue = $state('');

	// Dark mode (session only, defaults to OS preference)
	let darkMode = $state(false);


	// Sync dark mode and hue to document root for body/background styles
	$effect(() => {
		if (typeof document !== 'undefined') {
			document.documentElement.classList.toggle('dark', darkMode);
		}
	});

	$effect(() => {
		if (typeof document !== 'undefined' && data?.settings?.hue !== undefined) {
			document.documentElement.style.setProperty('--hue', data.settings.hue);
		}
	});

	// Apply font settings to CSS variables
	$effect(() => {
		if (typeof document === 'undefined') return;
		const s = data?.settings;
		if (!s) return;

		const latinFont = FONTS_LATIN.find(f => f.id === s.fontLatin) || FONTS_LATIN[0];
		const arabicFont = FONTS_ARABIC.find(f => f.id === s.fontArabic) || FONTS_ARABIC[0];

		document.documentElement.style.setProperty('--font-family', latinFont.family);
		document.documentElement.style.setProperty('--font-family-arabic', arabicFont.family);
	});

	// URL query params for shareable settings
	const URL_PARAM_KEYS = ['lng', 'hue', 'parallax', 'intensity', '3d', 'effect', 'texture', 'rainbow', 'q'];

	function getUrlParams() {
		if (typeof window === 'undefined') return {};
		const params = new URLSearchParams(window.location.search);
		const result = {};
		for (const key of URL_PARAM_KEYS) {
			if (params.has(key)) result[key] = params.get(key);
		}
		return result;
	}

	// Map short language codes to full locale codes
	function resolveLocale(lng) {
		if (!lng) return null;
		// If already a full locale, return as-is
		if (lng.includes('-')) return lng;
		// Map common short codes to full locales
		const map = {
			'fa': 'fa-IR', 'en': 'en-US', 'de': 'de-DE', 'es': 'es-ES',
			'ar': 'ar-SA', 'ur': 'ur-PK', 'ps': 'ps-AF', 'ckb': 'ckb-IQ',
			'sd': 'sd-PK', 'ug': 'ug-CN', 'pa': 'pa-PK', 'ks': 'ks-IN'
		};
		return map[lng] || lng;
	}

	function applyUrlParams(params) {
		const updates = {};
		if (params.lng) updates.keyboardLocale = resolveLocale(params.lng);
		if (params.hue) updates.hue = parseInt(params.hue, 10);
		if (params.parallax !== undefined) updates.parallax = params.parallax !== '0' && params.parallax !== 'false';
		if (params.intensity) updates.parallaxIntensity = parseFloat(params.intensity);
		if (params['3d'] !== undefined) updates.parallax3d = params['3d'] !== '0' && params['3d'] !== 'false';
		if (params.effect) updates.parallax3dEffect = params.effect;
		if (params.texture) updates.parallax3dTexture = params.texture;
		if (params.rainbow !== undefined) updates.parallax3dRainbow = params.rainbow !== '0' && params.rainbow !== 'false';
		return updates;
	}

	function updateUrlParams() {
		if (typeof window === 'undefined') return;
		const params = new URLSearchParams();
		const s = data.settings;

		// Only add non-default values
		if (s.keyboardLocale && s.keyboardLocale !== 'en-US') params.set('lng', s.keyboardLocale);
		if (s.hue !== undefined && s.hue !== 220) params.set('hue', s.hue);
		if (s.parallax === false) params.set('parallax', '0');
		if (s.parallaxIntensity !== undefined && s.parallaxIntensity !== 1.5) params.set('intensity', s.parallaxIntensity);
		if (s.parallax3d === true) params.set('3d', '1');
		if (s.parallax3dEffect && s.parallax3dEffect !== 'none') params.set('effect', s.parallax3dEffect);
		if (s.parallax3dTexture && s.parallax3dTexture !== 'solid') params.set('texture', s.parallax3dTexture);
		if (s.parallax3dRainbow === true) params.set('rainbow', '1');

		// Add current quatrain number if available
		if (currentTextItem?.number) params.set('q', currentTextItem.number);

		const newUrl = params.toString() ? `${window.location.pathname}?${params}` : window.location.pathname;
		replaceState(newUrl, {});
	}

	// Track current quatrain number for URL
	let urlQuatrain = $state(null);
	// Skip URL updates until initial load is complete
	let initialLoadComplete = $state(false);

	// Multiplayer state
	let identity = $state(null);
	let multiplayerRoom = $state(null);
	let roomState = $state('waiting');
	let participants = $state([]);
	let roomConnected = $state(false);
	let signalingConnected = $state(false);
	let peerCount = $state(0);
	let countdown = $state(null);
	let showJoinModal = $state(false);
	let joinRoomCode = $state('');
	let publishingStats = $state(false);
	let activeRooms = $state([]);
	let loadingRooms = $state(false);
	let presenceInterval = $state(null);
	let nostrParticipants = $state([]);
	let connectionCheckInterval = $state(null);
	let raceAnnounced = $state(false);
	let historyChartEl = $state(null);
	let historyChart = $state(null);
	let ChartJS = $state(null);

	// Keyboard tracking
	let pressedKeys = $state(new Set());
	let modifiers = $state({ shift: false, ctrl: false, alt: false, altgr: false, meta: false });
	let layoutMismatch = $state(false);
	let mismatchTimeout = $state(null);

	let keyboardLocale = $derived(data.settings.keyboardLocale || 'en-US');
	let physicalLayout = $derived(data.settings.physicalLayout || 'ansi');
	let modeType = $derived(data.settings.modeType || 'time');
	let modeValue = $derived(data.settings.modeValue || 30);
	let errorReplace = $derived(data.settings.errorReplace || false);
	let parallax = $derived(data.settings.parallax !== false);
	let parallaxIntensity = $derived(data.settings.parallaxIntensity ?? 1.5);
	let parallax3d = $derived(data.settings.parallax3d === true);
	let parallax3dEffect = $derived(data.settings.parallax3dEffect || 'none');
	let parallax3dTexture = $derived(data.settings.parallax3dTexture || 'solid');
	let parallax3dRainbow = $derived(data.settings.parallax3dRainbow === true);
	let dotPattern = $derived(data.settings.dotPattern !== false);
	let keyboard = $derived(buildKeyboard(physicalLayout, keyboardLocale));
	let keyboardMapping = $derived(languageMappings[keyboardLocale]);

	// Relay settings (used for both Nostr and WebRTC signaling)
	let nostrRelays = $derived(data.settings.nostrRelays || ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']);
	let loadingFastRelays = $state(false);

	// ICE servers for WebRTC (STUN/TURN)
	let iceServers = $derived(data.settings.iceServers || [
		{ urls: 'stun:stun.l.google.com:19302' },
		{ urls: 'stun:stun1.l.google.com:19302' }
	]);

	// Map keyboard locale to UI language (with fallbacks)
	const keyboardToUiLang = {
		'en-US': 'en',
		'de-DE': 'de',
		'es-ES': 'es',
		'fa-IR': 'fa',
		'eurkey': 'en',
		'ar': 'ar',
		'ur-PK': 'ur',
		'ps-AF': 'ps',
		'ckb': 'ckb',
		'sd-PK': 'sd',
		'ug': 'ug',
		'pa-Arab': 'pa',
		'ks': 'ks',
		'prs': 'fa'
	};
	let langOverride = $derived(data.settings.langOverride || '');
	let autoUiLang = $derived(keyboardToUiLang[keyboardLocale] || (isRTL(keyboardLocale) ? 'fa' : 'en'));
	let uiLang = $derived(langOverride || autoUiLang);
	let tr = $derived(t(uiLang));
	let uiDir = $derived(getDirection(uiLang));
	let textDir = $derived(isRTL(keyboardLocale) ? 'rtl' : 'ltr');
	// Text content follows keyboard locale when possible; UI language override does not affect text selection.
	let textLang = $derived.by(() => {
		const localeLang = keyboardLocale?.split('-')[0];
		if (localeLang && getTextCount(localeLang) > 0) return localeLang;
		return isRTL(keyboardLocale) ? 'fa' : 'en';
	});
	let meta = $derived(getTextMeta(textLang));

	// Map characters to key codes for highlighting next expected key
	let charToKey = $derived.by(() => {
		const map = new Map();
		for (const row of keyboard.rows) {
			for (const key of row.keys) {
				if (key.modifier) continue;
				key.chars.forEach((char, level) => {
					if (char && !map.has(char)) {
						map.set(char, { code: key.code, level });
					}
				});
			}
		}
		// Handle newline -> Enter
		map.set('\n', { code: 'Enter', level: 0 });
		return map;
	});

	// Next expected key
	let nextChar = $derived(targetText[userInput.length] || null);
	let nextKey = $derived(nextChar ? charToKey.get(nextChar) : null);

	// Split text into lines for scrolling display
	let lines = $derived(targetText.split('\n'));

	// Track character positions for each line
	let linePositions = $derived.by(() => {
		const positions = [];
		let pos = 0;
		for (const line of lines) {
			positions.push({ start: pos, end: pos + line.length });
			pos += line.length + 1; // +1 for newline
		}
		return positions;
	});

	// Current line index based on cursor position
	let currentLineIndex = $derived.by(() => {
		const cursorPos = userInput.length;
		for (let i = 0; i < linePositions.length; i++) {
			if (cursorPos <= linePositions[i].end) {
				return i;
			}
		}
		return linePositions.length - 1;
	});

	// Current text item index based on line position
	let currentTextItemIndex = $derived.by(() => {
		if (currentTextItems.length <= 1) return 0;
		let lineCount = 0;
		for (let i = 0; i < currentTextItems.length; i++) {
			const textLines = currentTextItems[i].text.split('\n').length;
			lineCount += textLines;
			if (currentLineIndex < lineCount) {
				return i;
			}
		}
		return currentTextItems.length - 1;
	});

	let currentTextItem = $derived(currentTextItems[currentTextItemIndex] || null);

	// Update URL when settings or current text change (skip during initial load)
	$effect(() => {
		// Dependencies: key settings and current quatrain
		const _ = [
			data.settings.keyboardLocale,
			data.settings.hue,
			data.settings.parallax,
			data.settings.parallaxIntensity,
			data.settings.parallax3d,
			data.settings.parallax3dEffect,
			data.settings.parallax3dTexture,
			data.settings.parallax3dRainbow,
			currentTextItem?.number
		];
		if (initialLoadComplete) {
			updateUrlParams();
		}
	});

	// Line indices that start a new text (for visual separation)
	let textStartLines = $derived.by(() => {
		const starts = new Set([0]);
		let lineCount = 0;
		for (let i = 0; i < currentTextItems.length - 1; i++) {
			lineCount += currentTextItems[i].text.split('\n').length;
			starts.add(lineCount);
		}
		return starts;
	});

	// Character states per line
	let lineCharStates = $derived.by(() => {
		return lines.map((line, lineIdx) => {
			const { start } = linePositions[lineIdx];
			const states = [];
			for (let i = 0; i < line.length; i++) {
				const globalIdx = start + i;
				if (globalIdx < userInput.length) {
					const userChar = userInput[globalIdx];
					states.push(userChar === targetText[globalIdx] ? 'correct' : 'error');
				} else if (globalIdx === userInput.length) {
					states.push('current');
				} else {
					states.push('pending');
				}
			}
			return states;
		});
	});

	let correctChars = $derived.by(() => {
		let count = 0;
		for (let i = 0; i < userInput.length && i < targetText.length; i++) {
			if (userInput[i] === targetText[i]) count++;
		}
		return count;
	});

	let accuracy = $derived(
		userInput.length > 0 ? Math.round((correctChars / userInput.length) * 100) : 100
	);

	let progress = $derived(
		targetText.length > 0 ? Math.round((userInput.length / targetText.length) * 100) : 0
	);

	let remainingChars = $derived(Math.max(0, targetText.length - userInput.length));

	let elapsedSeconds = $derived.by(() => {
		if (!startTime) return 0;
		const end = endTime || now;
		return Math.max(0, Math.floor((end - startTime) / 1000));
	});

	let remainingTime = $derived.by(() => {
		if (modeType !== 'time') return null;
		if (!startTime) return modeValue;
		return Math.max(0, modeValue - elapsedSeconds);
	});

	let displayTime = $derived.by(() => {
		if (modeType === 'time') {
			return startTime ? remainingTime : modeValue;
		}
		return elapsedSeconds;
	});

	let wpm = $derived.by(() => {
		if (!startTime || elapsedSeconds === 0) return 0;
		const words = correctChars / 5;
		const minutes = elapsedSeconds / 60;
		return Math.round(words / minutes);
	});

	let historySeries = $derived.by(() => {
		const items = [...data.history].slice(0, 30).reverse();
		return {
			labels: items.map((r) => formatDate(r.timestamp)),
			wpm: items.map((r) => r.wpm),
			accuracy: items.map((r) => r.accuracy)
		};
	});

	let mergedParticipants = $derived.by(() => {
		const base = [...participants];
		const seen = new Set(base.map(p => p.odyseeId || p.pubkeyHex));
		if (identity && !seen.has(identity.odyseeId)) {
			base.push({
				odyseeId: identity.odyseeId,
				name: identity.name,
				color: identity.color,
				progress: correctChars,
				wpm,
				accuracy,
				connected: true,
				finished: isComplete
			});
			seen.add(identity.odyseeId);
		}
		for (const p of nostrParticipants) {
			if (!seen.has(p.odyseeId)) {
				base.push({ ...p, progress: 0, wpm: 0, connected: true, finished: false });
			}
		}
		return base;
	});

	let allParticipantsFinished = $derived.by(() => {
		if (!multiplayerRoom || mergedParticipants.length === 0) return false;
		return mergedParticipants.every(p => p.finished);
	});

	let multiplayerDuration = $derived.by(() => multiplayerRoom?.duration || (modeType === 'time' ? modeValue : 60));

	function startTimer() {
		if (timerInterval) return;
		timerInterval = setInterval(() => {
			now = Date.now();
		}, 100);
	}

	function stopTimer() {
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	}

	$effect(() => {
		if (!historyChartEl || !ChartJS) return;
		if (historySeries.labels.length === 0) {
			if (historyChart) {
				historyChart.destroy();
				historyChart = null;
			}
			return;
		}

		if (!historyChart) {
			// Get computed hue from CSS variable
			const hue = getComputedStyle(document.documentElement).getPropertyValue('--hue').trim() || '220';
			const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim();
			const gridColor = `hsla(${hue}, 10%, 50%, 0.15)`;

			historyChart = new ChartJS(historyChartEl, {
				type: 'line',
				data: {
					labels: historySeries.labels,
					datasets: [
						{
							label: 'WPM',
							data: historySeries.wpm,
							borderColor: `hsl(${hue}, 60%, 50%)`,
							backgroundColor: `hsla(${hue}, 60%, 50%, 0.1)`,
							borderWidth: 2,
							tension: 0.3,
							fill: true,
							pointRadius: 3,
							pointHoverRadius: 5
						},
						{
							label: 'Accuracy',
							data: historySeries.accuracy,
							borderColor: `hsl(${hue}, 25%, 60%)`,
							backgroundColor: 'transparent',
							borderWidth: 2,
							borderDash: [4, 4],
							tension: 0.3,
							yAxisID: 'y1',
							pointRadius: 2,
							pointHoverRadius: 4
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					interaction: {
						intersect: false,
						mode: 'index'
					},
					plugins: {
						legend: {
							display: true,
							position: 'bottom',
							labels: {
								color: textColor || `hsl(${hue}, 10%, 60%)`,
								usePointStyle: true,
								padding: 15
							}
						}
					},
					scales: {
						x: {
							display: false
						},
						y: {
							ticks: { color: textColor || `hsl(${hue}, 10%, 60%)` },
							grid: { color: gridColor },
							beginAtZero: true,
							title: {
								display: false
							}
						},
						y1: {
							position: 'right',
							min: 0,
							max: 100,
							ticks: {
								color: textColor || `hsl(${hue}, 10%, 60%)`,
								callback: (v) => v + '%'
							},
							grid: { drawOnChartArea: false }
						}
					}
				}
			});
			return;
		}

		historyChart.data.labels = historySeries.labels;
		historyChart.data.datasets[0].data = historySeries.wpm;
		historyChart.data.datasets[1].data = historySeries.accuracy;
		historyChart.update();
	});

	onMount(async () => {
		const mod = await import('chart.js/auto');
		ChartJS = mod.default;
	});

	$effect(() => {
		if (!multiplayerRoom) {
			raceAnnounced = false;
			return;
		}
		if (roomState === 'waiting' || roomState === 'countdown') {
			raceAnnounced = false;
		}
	});

	$effect(() => {
		if (!multiplayerRoom || roomState !== 'racing' || raceAnnounced) return;
		if (allParticipantsFinished || elapsedSeconds >= multiplayerDuration) {
			multiplayerRoom.endRace();
			raceAnnounced = true;
		}
	});

	// Track if OS keyboard layout matches selected layout
	let osLayoutValid = $state(true);

	function checkOsLayout(e) {
		// Only check letter keys (KeyA-KeyZ)
		if (!e.code || !e.code.startsWith('Key')) return true;

		const char = e.key;
		if (!char || char.length !== 1) return true;

		const expectRTL = isRTL(keyboardLocale);

		// Check if the produced character matches expected script
		if (expectRTL && isLatinScript(char)) {
			return false; // OS is Latin, we expect RTL
		}
		if (!expectRTL && isArabicScript(char)) {
			return false; // OS is Arabic, we expect Latin
		}
		return true;
	}

	function handleBeforeInput(e) {
		// Block all input if OS keyboard layout doesn't match
		if (!osLayoutValid) {
			e.preventDefault();
			triggerMismatchWarning();
			return;
		}
	}

	function handleInput(e) {
		const value = e.target.value;

		// In multiplayer, don't start timer locally - it's synced
		if (!multiplayerRoom && !startTime && value.length > 0) {
			startTime = Date.now();
			startTimer();
		}

		userInput = value;

		// Sync progress in multiplayer (use correctChars so random typing doesn't count)
		if (multiplayerRoom && roomState === 'racing') {
			multiplayerRoom.updateProgress(correctChars, wpm, accuracy);
		}

		// Text mode: complete when all text is typed (solo only), or append more in endless mode
		if (!multiplayerRoom && modeType === 'text' && value.length >= targetText.length && !isComplete) {
			if (endlessMode) {
				appendMoreText();
			} else {
				completeRace();
			}
		}

		// Multiplayer: complete when text is finished
		if (multiplayerRoom && value.length >= targetText.length && !isComplete) {
			multiplayerRoom.finishRace(wpm, accuracy);
		}

		// Time mode: generate more text when running low (solo only)
		if (!multiplayerRoom && modeType === 'time' && !isComplete && targetText.length - value.length < 100) {
			appendMoreText();
		}
	}

	function handleKeydown(e) {
		// Track pressed keys for keyboard visualization
		pressedKeys = new Set([...pressedKeys, e.code]);
		modifiers = {
			shift: e.shiftKey,
			ctrl: e.ctrlKey,
			alt: e.altKey,
			altgr: e.code === 'AltRight' || modifiers.altgr,
			meta: e.metaKey
		};

		// Don't interfere if user is typing in another input/textarea
		const activeEl = document.activeElement;
		const isInOtherInput = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && activeEl !== inputElement;
		if (isInOtherInput) return;

		if (e.key === 'Enter' && isComplete) {
			e.preventDefault();
			if (multiplayerRoom) {
				raceAgain();
			} else {
				loadNewText();
			}
		}

		if (e.key === 'Escape') {
			e.preventDefault();
			loadNewText();
		}

		// Check OS keyboard layout on letter keys
		if (e.code?.startsWith('Key') && !e.ctrlKey && !e.metaKey) {
			osLayoutValid = checkOsLayout(e);
			if (!osLayoutValid) {
				e.preventDefault();
				triggerMismatchWarning();
				return;
			}
		}

		// Focus input on any printable key
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && inputElement) {
			inputElement.focus({ preventScroll: true });
		}
	}

	function handleKeyup(e) {
		const newPressed = new Set(pressedKeys);
		newPressed.delete(e.code);
		pressedKeys = newPressed;
		modifiers = {
			shift: e.shiftKey,
			ctrl: e.ctrlKey,
			alt: e.altKey,
			altgr: e.code === 'AltRight' ? false : modifiers.altgr,
			meta: e.metaKey
		};
	}

	function completeRace() {
		endTime = Date.now();
		isComplete = true;
		stopTimer();

		const result = {
			wpm,
			accuracy,
			chars: targetText.length,
			time: elapsedSeconds,
			language: textLang
		};

		data = addRaceResult(result);
	}

	function generateText(count) {
		const customText = data.customTexts[textLang]?.trim();
		if (customText) {
			currentTextItems = [{ text: customText, number: null, url: null }];
			return customText;
		}

		const source = uploadedTexts || null;
		if (source && source.length > 0) {
			const items = [];
			for (let i = 0; i < count; i++) {
				items.push(source[Math.floor(Math.random() * source.length)]);
			}
			currentTextItems = items;
			return items.map((item) => item.text).join('\n');
		}

		// Load specific quatrain from URL param if provided
		if (urlQuatrain !== null) {
			const specificItem = getTextByNumber(textLang, urlQuatrain);
			if (specificItem) {
				currentTextItems = [specificItem];
				urlQuatrain = null; // Clear so subsequent loads are random
				return specificItem.text;
			}
		}

		const items = [];
		for (let i = 0; i < count; i++) {
			items.push(getRandomTextItem(textLang));
		}
		currentTextItems = items;
		return items.map((item) => item.text).join('\n');
	}

	function appendMoreText() {
		const source = uploadedTexts || null;
		let newItem;
		if (source && source.length > 0) {
			newItem = source[Math.floor(Math.random() * source.length)];
		} else {
			newItem = getRandomTextItem(textLang);
		}
		currentTextItems = [...currentTextItems, newItem];
		targetText = targetText + '\n' + newItem.text;
	}

	async function loadNewText() {
		// For time mode, start with 3 texts; for text mode, use modeValue
		const count = modeType === 'time' ? 3 : modeValue;
		targetText = generateText(count);
		userInput = '';
		startTime = null;
		endTime = null;
		isComplete = false;
		endlessMode = false;
		lastSpawnedLineIndex = 0;
		await tick();
		// Spawn initial background lanes and start continuous spawner
		const firstLine = targetText.split('\n')[0];
		if (firstLine?.trim()) {
			for (let i = 0; i < 5; i++) {
				spawnLane(firstLine, textDir);
			}
		}
		startLaneSpawner();
		inputElement?.focus({ preventScroll: true });
	}

	function continueTyping() {
		isComplete = false;
		endlessMode = true;
		// Append more text for continued typing
		appendMoreText();
		appendMoreText();
		// Keep existing startTime for continuous stats
		if (!startTime) startTime = Date.now();
		startTimer();
		inputElement?.focus({ preventScroll: true });
	}

	function changeSetting(key, value) {
		data = updateSettings({ [key]: value });
		if (key === 'keyboardLocale' || key === 'modeType' || key === 'modeValue' || key === 'langOverride') {
			// Stop spawner and clear lanes before loading new text
			// This prevents spawning wrong-language text during the async load
			stopLaneSpawner();
			backgroundLanes = [];
			if (parallax3dRenderer) {
				parallax3dRenderer.clearAllLanes();
				// Update renderer RTL setting immediately before spawning new lanes
				if (key === 'keyboardLocale') {
					parallax3dRenderer.updateSettings({ isRTL: isRTL(value) });
				}
			}
			loadNewText();
		}
	}

	function handleRelayChange(key, textValue) {
		const urls = textValue.split('\n').map(s => s.trim()).filter(s => s && s.startsWith('wss://'));
		changeSetting(key, urls);
	}

	async function loadFastRelays() {
		if (loadingFastRelays) return;
		loadingFastRelays = true;

		try {
			const fastRelays = await fetchFastRelays(5);
			changeSetting('nostrRelays', fastRelays);
		} catch {
			// Fallback to recommended list
			changeSetting('nostrRelays', [...RECOMMENDED_RELAYS]);
		}

		loadingFastRelays = false;
	}

	function loadRecommendedRelays() {
		changeSetting('nostrRelays', [...RECOMMENDED_RELAYS]);
	}

	function handleIceServersChange(textValue) {
		// Parse ICE server config from textarea
		// Format: one URL per line, optionally followed by username:credential
		// e.g., stun:stun.example.com
		//       turn:turn.example.com|username|credential
		const servers = textValue.split('\n')
			.map(s => s.trim())
			.filter(s => s && (s.startsWith('stun:') || s.startsWith('turn:') || s.startsWith('turns:')))
			.map(line => {
				const parts = line.split('|');
				const server = { urls: parts[0] };
				if (parts[1] && parts[2]) {
					server.username = parts[1];
					server.credential = parts[2];
				}
				return server;
			});
		changeSetting('iceServers', servers);
	}

	function iceServersToText(servers) {
		// Convert ICE servers array to textarea format
		return servers.map(s => {
			if (s.username && s.credential) {
				return `${s.urls}|${s.username}|${s.credential}`;
			}
			return s.urls;
		}).join('\n');
	}


	function handleCustomModeValue() {
		const val = parseInt(customModeValue);
		if (!val || val <= 0) return;
		if (modeType === 'time' && val >= 5 && val <= 600) {
			changeSetting('modeValue', val);
		} else if (modeType === 'text' && val >= 1 && val <= 50) {
			changeSetting('modeValue', val);
		}
		customModeValue = '';
	}

	function handleExport() {
		const json = exportData();
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'righter-data.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	function handleImport() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async (e) => {
			const file = e.target.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				data = importData(text);
				loadNewText();
			} catch (err) {
				alert(err.message);
			}
		};
		input.click();
	}

	function handleClearHistory() {
		if (confirm(tr('confirmClearHistory'))) {
			data = clearHistory();
		}
	}

	function handleResetSettings() {
		if (confirm(tr('confirmResetSettings'))) {
			data = resetSettings();
			loadNewText();
		}
	}

	function handleLoadTexts() {
		const input = document.createElement('input');
		input.type = 'file';
		input.onchange = async (e) => {
			const file = e.target.files?.[0];
			if (!file) return;
			const content = await file.text();
			const texts = content
				.split(/\n\s*\n/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((text, i) => ({ text, number: i + 1, url: null }));
			if (texts.length > 0) {
				uploadedTexts = texts;
				loadNewText();
			}
		};
		input.click();
	}

	function handleClearTexts() {
		uploadedTexts = null;
		loadNewText();
	}

	const persianDigits = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
	const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
	const persianNumeralLangs = ['fa', 'ur', 'ps', 'ckb', 'sd', 'ug', 'pa', 'ks'];
	const arabicNumeralLangs = ['ar'];

	// Check if character belongs to Arabic script (Arabic, Persian, Urdu, etc.)
	function isArabicScript(char) {
		if (!char) return false;
		const code = char.charCodeAt(0);
		return (code >= 0x0600 && code <= 0x06FF) ||  // Arabic
		       (code >= 0x0750 && code <= 0x077F) ||  // Arabic Supplement
		       (code >= 0x08A0 && code <= 0x08FF) ||  // Arabic Extended-A
		       (code >= 0xFB50 && code <= 0xFDFF) ||  // Arabic Presentation Forms-A
		       (code >= 0xFE70 && code <= 0xFEFF);    // Arabic Presentation Forms-B
	}

	// Check if character is Latin
	function isLatinScript(char) {
		if (!char) return false;
		const code = char.charCodeAt(0);
		return (code >= 0x0041 && code <= 0x007A) ||  // Basic Latin
		       (code >= 0x00C0 && code <= 0x024F);    // Latin Extended
	}

	function checkLayoutMismatch(char) {
		if (!char || char === ' ' || char === '\n') return false;
		const expectRTL = isRTL(keyboardLocale);
		if (expectRTL && isLatinScript(char)) return true;
		if (!expectRTL && isArabicScript(char)) return true;
		return false;
	}

	function triggerMismatchWarning() {
		if (mismatchTimeout) clearTimeout(mismatchTimeout);
		layoutMismatch = true;
		mismatchTimeout = setTimeout(() => {
			layoutMismatch = false;
		}, 150);
	}

	function formatNumber(num) {
		const str = String(num);
		if (persianNumeralLangs.includes(uiLang)) {
			return str.replace(/[0-9]/g, (d) => persianDigits[d]);
		}
		if (arabicNumeralLangs.includes(uiLang)) {
			return str.replace(/[0-9]/g, (d) => arabicDigits[d]);
		}
		return str;
	}

	function formatPercent(num) {
		const rtlLangs = [...persianNumeralLangs, ...arabicNumeralLangs];
		const pct = rtlLangs.includes(uiLang) ? '٪' : '%';
		return formatNumber(num) + pct;
	}

	function formatTime(seconds) {
		const m = Math.floor(seconds / 60);
		const s = seconds % 60;
		if (m > 0) {
			return formatNumber(m) + ':' + formatNumber(s.toString().padStart(2, '0'));
		}
		return formatNumber(s);
	}

	function formatDate(timestamp) {
		const rtlLangs = [...persianNumeralLangs, ...arabicNumeralLangs];
		const locale = rtlLangs.includes(uiLang) ? uiLang : 'en-US';
		return new Date(timestamp).toLocaleDateString(locale, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function hueToHex(h) {
		const s = 0.5, l = 0.5;
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs((h / 60) % 2 - 1));
		const m = l - c / 2;
		let r, g, b;
		if (h < 60) { r = c; g = x; b = 0; }
		else if (h < 120) { r = x; g = c; b = 0; }
		else if (h < 180) { r = 0; g = c; b = x; }
		else if (h < 240) { r = 0; g = x; b = c; }
		else if (h < 300) { r = x; g = 0; b = c; }
		else { r = c; g = 0; b = x; }
		const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	function hexToHue(hex) {
		const r = parseInt(hex.slice(1, 3), 16) / 255;
		const g = parseInt(hex.slice(3, 5), 16) / 255;
		const b = parseInt(hex.slice(5, 7), 16) / 255;
		const max = Math.max(r, g, b), min = Math.min(r, g, b);
		let h = 0;
		if (max !== min) {
			const d = max - min;
			if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
			else if (max === g) h = ((b - r) / d + 2) * 60;
			else h = ((r - g) / d + 4) * 60;
		}
		return Math.round(h);
	}

	// Multiplayer functions
	async function createRoom() {
		if (!identity) return;
		const code = generateRoomCode();
		const config = {
			text: generateText(1),
			duration: modeType === 'time' ? modeValue : 60,
			keyboard: keyboardLocale
		};
		await joinRoomWithCode(code, config);
	}

	async function joinRoom() {
		if (!identity || !joinRoomCode.trim()) return;
		const code = joinRoomCode.trim().toUpperCase();
		await joinRoomWithCode(code, {
			text: '',
			duration: modeType === 'time' ? modeValue : 60,
			keyboard: keyboardLocale
		});
		showJoinModal = false;
		joinRoomCode = '';
	}

	async function loadActiveRooms() {
		loadingRooms = true;
		try {
			activeRooms = await fetchActiveRooms(null, nostrRelays);
		} catch {
			activeRooms = [];
		}
		loadingRooms = false;
	}

	async function joinActiveRoom(room) {
		showJoinModal = false;
		await joinRoomWithCode(room.roomCode, {
			text: '',
			duration: modeType === 'time' ? modeValue : 60,
			keyboard: room.keyboard
		});
	}

	async function joinRoomWithCode(code, config) {
		if (multiplayerRoom) {
			multiplayerRoom.destroy();
		}
		stopPresenceInterval();

		const connectionConfig = {
			relayUrls: nostrRelays,
			iceServers: iceServers
		};
		const room = new MultiplayerRoom(code, identity, config, connectionConfig);

		room.onStateChange = (state) => {
			roomState = state.state;
			if (state.state === 'countdown') {
				startCountdownTimer(state.countdownStart);
				// Update presence to racing
				publishRoomPresence(code, identity, config.keyboard || keyboardLocale, 'racing', nostrRelays).catch(() => {});
			} else if (state.state === 'racing') {
				countdown = null;
				if (state.text) {
					targetText = state.text;
				}
				userInput = '';
				startTime = state.startTime || Date.now();
				endTime = null;
				isComplete = false;
				startTimer();
			} else if (state.state === 'finished') {
				handleMultiplayerRaceEnd();
			}
		};

		room.onParticipantsChange = (p) => {
			participants = p;
		};

		room.onConnectionChange = (connected) => {
			roomConnected = connected;
			if (connected) {
				startConnectionCheck();
			}
		};

		const connected = await room.connect();
		if (connected) {
			multiplayerRoom = room;
			setRoomInUrl(code);
			// Use room's text if we're joining
			const state = room.getState();
			if (state.text) {
				targetText = state.text;
			}

			// Publish presence so peers can find us
			publishRoomPresence(code, identity, config.keyboard || keyboardLocale, 'waiting', nostrRelays).catch(() => {});
			startPresenceInterval(code, config.keyboard || keyboardLocale);
		}
	}

	function startPresenceInterval(roomCode, keyboard) {
		// Republish presence every 60s to stay visible
		presenceInterval = setInterval(() => {
			if (multiplayerRoom && roomState === 'waiting') {
				publishRoomPresence(roomCode, identity, keyboard, 'waiting', nostrRelays).catch(() => {});
			}
		}, 60000);

		// Also refresh participants from Nostr every 10s
		refreshNostrParticipants(roomCode);
		const refreshInterval = setInterval(() => {
			if (multiplayerRoom && roomState === 'waiting') {
				refreshNostrParticipants(roomCode);
			} else {
				clearInterval(refreshInterval);
			}
		}, 10000);
	}

	function stopPresenceInterval() {
		if (presenceInterval) {
			clearInterval(presenceInterval);
			presenceInterval = null;
		}
	}

	function startConnectionCheck() {
		if (connectionCheckInterval) return;
		const check = () => {
			if (multiplayerRoom) {
				const debug = multiplayerRoom.getDebugInfo();
				signalingConnected = debug.signalingConnected;
				peerCount = debug.peerCount;
			}
		};
		check();
		connectionCheckInterval = setInterval(check, 2000);
	}

	function stopConnectionCheck() {
		if (connectionCheckInterval) {
			clearInterval(connectionCheckInterval);
			connectionCheckInterval = null;
		}
	}

	async function refreshNostrParticipants(roomCode) {
		try {
			nostrParticipants = await fetchRoomParticipants(roomCode, nostrRelays);
			if (multiplayerRoom) {
				multiplayerRoom.setKnownParticipants(
					nostrParticipants.map((p) => p.pubkeyHex).filter(Boolean)
				);
			}

			// Try to connect to discovered peers via WebRTC
			if (multiplayerRoom) {
				for (const p of nostrParticipants) {
					if (p.pubkeyHex && p.pubkeyHex !== identity?.pubkeyHex) {
						multiplayerRoom.connectToPeer(p.pubkeyHex);
					}
				}
			}
		} catch {
			// Ignore errors
		}
	}

	function startCountdownTimer(startTime) {
		const tick = () => {
			const elapsed = Math.floor((Date.now() - startTime) / 1000);
			countdown = 3 - elapsed;
			if (countdown > 0) {
				requestAnimationFrame(tick);
			} else {
				countdown = null;
			}
		};
		tick();
	}

	function handleMultiplayerRaceEnd() {
		stopTimer();
		isComplete = true;
		if (multiplayerRoom) {
			multiplayerRoom.finishRace(wpm, accuracy);
			publishRaceStats();
		}
	}

	async function publishRaceStats() {
		if (!multiplayerRoom || !identity) return;
		publishingStats = true;

		const raceResult = multiplayerRoom.getRaceResult();

		// Save locally first
		saveLocalRace(raceResult);

		// Publish to Nostr (with timeout fallback)
		try {
			await publishRace(raceResult, identity, nostrRelays);
		} catch {
			// Silently fail - data is saved locally
		}

		publishingStats = false;
	}

	function leaveRoom() {
		stopPresenceInterval();
		stopConnectionCheck();
		if (multiplayerRoom) {
			multiplayerRoom.destroy();
			multiplayerRoom = null;
		}
		roomConnected = false;
		signalingConnected = false;
		peerCount = 0;
		roomState = 'waiting';
		participants = [];
		nostrParticipants = [];
		raceAnnounced = false;
		clearRoomFromUrl();
		loadNewText();
	}

	function startMultiplayerRace() {
		if (multiplayerRoom && roomState === 'waiting') {
			const debug = multiplayerRoom.getDebugInfo();
			console.log('Start Race clicked, debug:', debug);

			// Check if we have signaling issues
			if (!debug.signalingConnected) {
				alert('Not connected to Nostr relays for signaling. Check your relay settings.');
				return;
			}

			multiplayerRoom.startCountdown();
		}
	}

	function raceAgain() {
		if (multiplayerRoom) {
			// Reset local state
			userInput = '';
			startTime = null;
			isComplete = false;

			// Generate new text and reset room
			const newText = generateText(1);
			targetText = newText;
			multiplayerRoom.resetForNewRace(newText);
		}
	}


	// Sync local races with Nostr on load (background, non-blocking)
	async function syncRacesWithNostr() {
		if (!identity) return;

		try {
			const [localRaces, remoteRaces] = await Promise.all([
				Promise.resolve(getMyLocalRaces(identity.odyseeId)),
				fetchMyRaces(identity.odyseeId, nostrRelays).catch(() => [])
			]);

			// Merge and save locally
			const merged = mergeRaceLists(localRaces, remoteRaces);
			for (const race of merged) {
				saveLocalRace(race);
			}

			// Find races we have that relays don't, and republish
			const missing = findMissingRaces(localRaces, remoteRaces);
			for (const race of missing.slice(0, 10)) {
				publishRace(race, identity, nostrRelays).catch(() => {});
			}
		} catch {
			// Non-critical, ignore
		}
	}

	onMount(async () => {
		// Settings panel: check sessionStorage
		const storedSettingsOpen = sessionStorage.getItem('settingsOpen');
		if (storedSettingsOpen !== null) {
			showMoreSettings = storedSettingsOpen === 'true';
		}

		// Dark mode: check sessionStorage first, then OS preference
		const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
		const storedDarkMode = sessionStorage.getItem('darkMode');
		if (storedDarkMode !== null) {
			darkMode = storedDarkMode === 'true';
		} else {
			darkMode = darkModeQuery.matches;
		}
		// Only follow OS changes if user hasn't manually set preference this session
		const handleColorSchemeChange = (e) => {
			if (sessionStorage.getItem('darkMode') === null) {
				darkMode = e.matches;
			}
		};
		darkModeQuery.addEventListener('change', handleColorSchemeChange);

		// Check WebGL availability for 3D parallax
		webglAvailable = isWebGLAvailable();

		data = loadData();
		if (!data.settings.uiLanguage) {
			data.settings.uiLanguage = detectLanguage();
			saveData(data);
		}
		if (!data.settings.keyboardLocale) {
			data.settings.keyboardLocale = data.settings.uiLanguage === 'fa' ? 'fa-IR' : 'en-US';
			saveData(data);
		}

		// Apply URL params (override stored settings)
		const urlParams = getUrlParams();
		const urlUpdates = applyUrlParams(urlParams);
		if (Object.keys(urlUpdates).length > 0) {
			data.settings = { ...data.settings, ...urlUpdates };
			saveData(data);
		}
		// Store quatrain param for loading specific text
		urlQuatrain = urlParams.q ? parseInt(urlParams.q, 10) : null;

		// Load identity
		identity = loadIdentity(isRTL(data.settings.keyboardLocale));

		await loadNewText();
		initialLoadComplete = true;
		updateUrlParams(); // Now safe to update URL with loaded quatrain

		// Check for room in URL
		const roomCode = getRoomFromUrl();
		if (roomCode) {
			await joinRoomWithCode(roomCode, {
				text: '',
				duration: 60,
				keyboard: keyboardLocale
			});
		}

		// Background sync with Nostr (non-blocking)
		syncRacesWithNostr();

		return () => {
			darkModeQuery.removeEventListener('change', handleColorSchemeChange);
			stopTimer();
			stopLaneSpawner();
			stopPresenceInterval();
			stopConnectionCheck();
			if (multiplayerRoom) {
				multiplayerRoom.destroy();
			}
			if (parallax3dRenderer) {
				parallax3dRenderer.dispose();
				parallax3dRenderer = null;
			}
		};
	});

	// Focus input after render
	$effect(() => {
		if (inputElement && !isComplete) {
			inputElement.focus({ preventScroll: true });
		}
	});

	// Check for time mode completion (skip in endless mode)
	$effect(() => {
		if (!multiplayerRoom && !endlessMode && modeType === 'time' && startTime && !isComplete && remainingTime === 0) {
			completeRace();
		}
	});

	// Calculate scroll offset to keep active line visible
	function updateScrollOffset() {
		if (!textDisplayElement) return;
		const containerHeight = textDisplayElement.clientHeight;
		const scrollContainer = textDisplayElement.querySelector('.scroll-container');
		const lineElements = textDisplayElement.querySelectorAll('.line');
		if (!scrollContainer || !lineElements.length) return;

		const activeLineElement = lineElements[currentLineIndex];
		if (!activeLineElement) return;

		const lineHeight = activeLineElement.offsetHeight;
		const scrollContainerHeight = scrollContainer.scrollHeight;

		// For short texts that fit in container, center the whole block
		if (scrollContainerHeight <= containerHeight) {
			scrollOffset = (containerHeight - scrollContainerHeight) / 2;
			return;
		}

		// Get active line position relative to scroll container
		const activeLineTop = activeLineElement.offsetTop;

		// If line is taller than container, align to top with small margin
		if (lineHeight >= containerHeight * 0.8) {
			scrollOffset = 16 - activeLineTop;
			return;
		}

		// Center the active line in the container
		const centerY = containerHeight / 2;
		const lineCenterY = activeLineTop + (lineHeight / 2);
		scrollOffset = centerY - lineCenterY;
	}

	$effect(() => {
		currentLineIndex;
		lines;
		// Wait for DOM update before measuring
		tick().then(() => {
			requestAnimationFrame(updateScrollOffset);
		});
	});

	// Spawn a single background lane with diversity
	// Base values, scaled by parallaxIntensity setting
	function spawnLane(text, direction, initialProgress = 0) {
		// Use Three.js renderer if available and enabled
		if (parallax3dRenderer) {
			parallax3dRenderer.spawnLane(text, direction, initialProgress);
			return;
		}

		// DOM-based fallback
		const intensity = parallaxIntensity;
		const sizeRand = Math.random();
		const speedRand = Math.random();
		const opacityRand = Math.random();

		// Size: 0.5-8rem base, scaled by intensity (intensity 2 = up to 16rem)
		const fontSize = 0.5 + Math.pow(sizeRand, 2) * 7.5 * intensity;

		// Duration scales with font size - larger text needs more time to cross
		// Base: 20-120s, but multiply by fontSize factor so giants move smoothly
		const baseDuration = (20 + Math.pow(speedRand, 2) * 100) / intensity;
		const sizeFactor = 1 + (fontSize / 8); // larger text = longer duration
		const duration = baseDuration * sizeFactor;

		// Opacity: 0.03-0.2 base, more visible with higher intensity
		const opacity = (0.03 + Math.pow(opacityRand, 2) * 0.17) * intensity;

		backgroundLanes = [...backgroundLanes, {
			id: laneIdCounter++,
			text,
			direction,
			top: Math.random() * 94 + 3, // 3-97% from top
			fontSize,
			duration,
			opacity: Math.min(opacity, 0.6) // cap at 0.6 to avoid too bright
		}];
	}

	function removeLane(id) {
		backgroundLanes = backgroundLanes.filter((l) => l.id !== id);
	}

	function getCurrentLaneText() {
		const lineText = lines[currentLineIndex];
		return lineText?.trim() ? lineText : lines[0] || '';
	}

	function startLaneSpawner() {
		if (laneSpawnInterval) return;

		// Spawner function - also used for immediate first spawn
		const trySpawn = () => {
			const poolSize = Math.round(LANE_POOL_SIZE * parallaxIntensity);
			const spawnChance = parallaxIntensity;
			const currentCount = parallax3dRenderer
				? parallax3dRenderer.getLaneCount()
				: backgroundLanes.length;
			if (currentCount < poolSize && Math.random() < spawnChance) {
				const text = getCurrentLaneText();
				if (text) spawnLane(text, textDir);
			}
		};

		// Use fixed base interval, intensity affects pool size and spawn rate dynamically
		laneSpawnInterval = setInterval(trySpawn, 400);
	}

	function stopLaneSpawner() {
		if (laneSpawnInterval) {
			clearInterval(laneSpawnInterval);
			laneSpawnInterval = null;
		}
	}

	// Spawn lanes when line changes (burst of new text)
	$effect(() => {
		if (currentLineIndex === lastSpawnedLineIndex) return;
		const lineText = lines[currentLineIndex];
		if (lineText?.trim()) {
			// Spawn 2-4 lanes immediately for the new line
			const burst = 2 + Math.floor(Math.random() * 3);
			for (let i = 0; i < burst; i++) {
				spawnLane(lineText, textDir);
			}
			lastSpawnedLineIndex = currentLineIndex;
		}
	});

	// Three.js 3D parallax renderer management
	$effect(() => {
		const shouldUse3d = parallax && parallax3d && webglAvailable && parallax3dContainer;

		if (shouldUse3d && !parallax3dRenderer) {
			parallax3dRenderer = new Parallax3DRenderer(parallax3dContainer, {
				intensity: parallaxIntensity,
				hue: data.settings.hue,
				isDark: darkMode,
				isRTL: textDir === 'rtl',
				effect: parallax3dEffect,
				texture: parallax3dTexture,
				rainbow: parallax3dRainbow
			});
			// Initial burst: spawn fewer lanes at earlier progress so they fade in gradually
			const burstCount = Math.round(LANE_POOL_SIZE * parallaxIntensity * 0.5);
			for (let i = 0; i < burstCount; i++) {
				const text = getCurrentLaneText();
				if (text) {
					// Spread progress from 0.0 to 0.4 - lines start further back in fog
					const progress = (i / burstCount) * 0.4;
					spawnLane(text, textDir, progress);
				}
			}
		} else if (!shouldUse3d && parallax3dRenderer) {
			parallax3dRenderer.dispose();
			parallax3dRenderer = null;
		}
	});

	// Update Three.js renderer settings when they change
	$effect(() => {
		if (parallax3dRenderer) {
			parallax3dRenderer.updateSettings({
				intensity: parallaxIntensity,
				hue: data.settings.hue,
				isDark: darkMode,
				isRTL: textDir === 'rtl',
				effect: parallax3dEffect,
				texture: parallax3dTexture,
				rainbow: parallax3dRainbow
			});
		}
	});

	// Clean up all parallax resources when disabled
	$effect(() => {
		if (!parallax) {
			// Stop spawning new lanes
			stopLaneSpawner();
			// Clear DOM-based lanes
			backgroundLanes = [];
			// 3D renderer cleanup is handled by the separate effect above
		}
	});

</script>

<svelte:head>
	<style>
		@import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600&display=swap');
	</style>
</svelte:head>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} onresize={updateScrollOffset} />

<div
	class="app"
	class:parallax={parallax}
	dir={uiDir}
	style="--font-size: {data.settings.fontSize}rem;"
>
	<!-- Background effects layer (dots) - always visible when parallax enabled -->
	<div
		class="background-effects"
		class:dot-pattern={dotPattern}
		aria-hidden="true"
	></div>

	<!-- Three.js 3D container (renders when 3D parallax is enabled) -->
	<div bind:this={parallax3dContainer} class="parallax3d-container" aria-hidden="true"></div>

	<!-- DOM-based background lanes (fallback when 3D is disabled) -->
	<div
		class="background-lanes"
		class:hidden={parallax3dRenderer}
		aria-hidden="true"
	>
		{#each backgroundLanes as lane (lane.id)}
			<div
				class="bg-lane"
				class:rtl={lane.direction === 'rtl'}
				style="top: {lane.top}%; font-size: {lane.fontSize}rem; animation-duration: {lane.duration}s; opacity: {lane.opacity};"
				onanimationend={() => removeLane(lane.id)}
			>
				{lane.text}
			</div>
		{/each}
	</div>

	<header class="header">
		<div class="settings-row settings-row-top" dir="ltr">
			<a href={base || '/'} class="brand">RIGHTER</a>
			<div class="top-controls">
				<select
					class="keyboard-select"
					value={keyboardLocale}
					onchange={(e) => changeSetting('keyboardLocale', e.target.value)}
				>
					{#each keyboardGroups as group}
						<optgroup label={group.name}>
							{#each group.keyboards as kb}
								<option value={kb}>{languageMappings[kb].name}</option>
							{/each}
						</optgroup>
					{/each}
				</select>

				<button
					class="mode-btn"
					class:active={physicalLayout === 'ansi'}
					onclick={() => changeSetting('physicalLayout', 'ansi')}
				>
					ANSI
				</button>
				<button
					class="mode-btn"
					class:active={physicalLayout === 'iso'}
					onclick={() => changeSetting('physicalLayout', 'iso')}
				>
					ISO
				</button>

				<button
					class="mode-btn"
					onclick={() => {
						darkMode = !darkMode;
						sessionStorage.setItem('darkMode', darkMode);
					}}
					title={darkMode ? 'Light mode' : 'Dark mode'}
				>
					{darkMode ? '☼' : '☾'}
				</button>

				<button
					class="mode-btn more-toggle"
					onclick={() => {
						showMoreSettings = !showMoreSettings;
						sessionStorage.setItem('settingsOpen', showMoreSettings);
					}}
					title="More settings"
				>
					<span class="toggle-arrow" class:open={showMoreSettings} class:rtl={uiDir === 'rtl'}>›</span>
				</button>
			</div>
		</div>

		<fieldset class="settings-panel" class:open={showMoreSettings}>
			<legend>{tr('settings')}</legend>
			<div class="settings-content">
				<div class="settings-row">
					<label class="setting-item">
						<span class="setting-label">{tr('mode')}</span>
						<select
							class="setting-select"
							value={modeType}
							onchange={(e) => changeSetting('modeType', e.target.value)}
						>
							<option value="time">{tr('time')}</option>
							<option value="text">{tr('texts')}</option>
						</select>
						<select
							class="setting-select"
							value={modeValue}
							onchange={(e) => changeSetting('modeValue', parseInt(e.target.value))}
						>
							{#each MODES[modeType] as value}
								<option value={value}>
									{#if modeType === 'time'}
										{value >= 60 ? formatNumber(value / 60) + tr('min') : formatNumber(value) + tr('sec')}
									{:else}
										{formatNumber(value)}
									{/if}
								</option>
							{/each}
						</select>
						<input
							type="number"
							class="setting-input-small"
							placeholder={tr('custom')}
							min={modeType === 'time' ? 5 : 1}
							max={modeType === 'time' ? 600 : 50}
							bind:value={customModeValue}
							onkeydown={(e) => e.key === 'Enter' && handleCustomModeValue()}
							onblur={handleCustomModeValue}
						/>
					</label>

					<label class="setting-item" title={tr('fontSizeTooltip')}>
						<span class="setting-label">{tr('fontSize')}</span>
						<input
							type="range"
							min="0.875"
							max="2"
							step="0.125"
							value={data.settings.fontSize}
							oninput={(e) => changeSetting('fontSize', parseFloat(e.target.value))}
						/>
					</label>

					<label class="setting-item">
						<span class="setting-label">{tr('fontLatin')}</span>
						<select
							class="setting-select"
							value={data.settings.fontLatin || 'system'}
							onchange={(e) => changeSetting('fontLatin', e.target.value)}
						>
							{#each FONTS_LATIN as font}
								<option value={font.id}>{tr('font_' + font.id)}</option>
							{/each}
						</select>
					</label>

					<label class="setting-item">
						<span class="setting-label">{tr('fontArabic')}</span>
						<select
							class="setting-select"
							value={data.settings.fontArabic || 'vazirmatn'}
							onchange={(e) => changeSetting('fontArabic', e.target.value)}
						>
							{#each FONTS_ARABIC as font}
								<option value={font.id}>{tr('font_' + font.id)}</option>
							{/each}
						</select>
					</label>

					<label class="setting-item" title={tr('colorTooltip')}>
						<span class="setting-label">{tr('color')}</span>
						<input
							type="color"
							value={hueToHex(data.settings.hue)}
							oninput={(e) => changeSetting('hue', hexToHue(e.target.value))}
						/>
					</label>

					<label class="setting-item">
						<span class="setting-label">{tr('errorReplace')}</span>
						<input
							type="checkbox"
							checked={errorReplace}
							onchange={(e) => changeSetting('errorReplace', e.target.checked)}
						/>
					</label>

					<label class="setting-item">
						<span class="setting-label">{tr('parallax')}</span>
						<input
							type="checkbox"
							checked={parallax}
							onchange={(e) => changeSetting('parallax', e.target.checked)}
						/>
					</label>

					{#if parallax}
					{#if webglAvailable}
					<label class="setting-item" title="Use WebGL 3D rendering">
						<span class="setting-label">{tr('parallax3d')}</span>
						<input
							type="checkbox"
							checked={parallax3d}
							onchange={(e) => changeSetting('parallax3d', e.target.checked)}
						/>
					</label>
					{#if parallax3d}
					<label class="setting-item" title="3D text effect">
						<span class="setting-label">{tr('parallax3dEffect')}</span>
						<select
							class="setting-select"
							value={parallax3dEffect}
							onchange={(e) => changeSetting('parallax3dEffect', e.target.value)}
						>
							<option value="none">{tr('effect_none')}</option>
							<option value="outline">{tr('effect_outline')}</option>
							<option value="shadow">{tr('effect_shadow')}</option>
							<option value="emboss">{tr('effect_emboss')}</option>
							<option value="extrude">{tr('effect_extrude')}</option>
							<option value="neon">{tr('effect_neon')}</option>
						</select>
					</label>

					<label class="setting-item" title="Text texture style">
						<span class="setting-label">{tr('parallax3dTexture')}</span>
						<select
							class="setting-select"
							value={parallax3dTexture}
							onchange={(e) => changeSetting('parallax3dTexture', e.target.value)}
						>
							<option value="solid">{tr('texture_solid')}</option>
							<option value="gradient">{tr('texture_gradient')}</option>
							<option value="metallic">{tr('texture_metallic')}</option>
							<option value="glass">{tr('texture_glass')}</option>
						</select>
					</label>

					<label class="setting-item" title="Rainbow colors for each letter">
						<span class="setting-label">{tr('rainbow')}</span>
						<input
							type="checkbox"
							checked={parallax3dRainbow}
							onchange={(e) => changeSetting('parallax3dRainbow', e.target.checked)}
						/>
					</label>
					{/if}
					{/if}

					<label class="setting-item" title={tr('intensity')}>
						<span class="setting-label">{tr('intensity')}</span>
						<input
							type="range"
							min="0.5"
							max="3"
							step="0.25"
							value={parallaxIntensity}
							oninput={(e) => changeSetting('parallaxIntensity', parseFloat(e.target.value))}
						/>
						<span class="setting-value">{parallaxIntensity.toFixed(1)}x</span>
					</label>

					{/if}

					<label class="setting-item">
						<span class="setting-label">{tr('dotPattern')}</span>
						<input
							type="checkbox"
							checked={dotPattern}
							onchange={(e) => changeSetting('dotPattern', e.target.checked)}
						/>
					</label>

					<label class="setting-item" title={tr('langOverride')}>
						<span class="setting-label">{tr('language')}</span>
						<select
							class="setting-select"
							value={langOverride}
							onchange={(e) => changeSetting('langOverride', e.target.value)}
						>
							<option value="">{tr('auto')}</option>
							{#each supportedLanguages as l}
								<option value={l.code}>{l.nativeName}</option>
							{/each}
						</select>
					</label>
				</div>

				<label class="setting-item setting-vertical">
					<span class="setting-label">
						{tr('nostrRelays')}
						<button class="btn-tiny" type="button" onclick={loadFastRelays} disabled={loadingFastRelays} title="Load fast relays via NIP-66">
							{loadingFastRelays ? '...' : '⚡'}
						</button>
						<button class="btn-tiny" type="button" onclick={loadRecommendedRelays} title="Load recommended relays">↻</button>
					</span>
					<textarea
						class="setting-textarea"
						rows="3"
						placeholder="wss://relay.damus.io"
						value={nostrRelays.join('\n')}
						onchange={(e) => handleRelayChange('nostrRelays', e.target.value)}
					></textarea>
				</label>

				<label class="setting-item setting-vertical">
					<span class="setting-label">{tr('iceServers')}</span>
					<textarea
						class="setting-textarea"
						rows="3"
						placeholder="stun:stun.example.com&#10;turn:turn.example.com|username|credential"
						value={iceServersToText(iceServers)}
						onchange={(e) => handleIceServersChange(e.target.value)}
					></textarea>
				</label>


				<div class="setting-item">
					<span class="setting-label">{tr('data')}</span>
					<button class="setting-btn" onclick={handleExport}>{tr('export')}</button>
					<button class="setting-btn" onclick={handleImport}>{tr('import')}</button>
					<button class="setting-btn reset-btn" onclick={handleResetSettings}>{uiDir === 'rtl' ? 'ریست' : 'reset'}</button>
				</div>

				<div class="credits">
					<div class="credits-section">
						<div class="credits-title">{tr('about')}</div>
						<p>{tr('aboutText')}</p>
					</div>

					<div class="credits-section">
						<div class="credits-title">{tr('howto')}</div>
						<p>{tr('howtoText')}</p>
					</div>

					<div class="credits-section">
						<div class="credits-title">{tr('poet')}</div>
						<p>
							<a href="https://en.wikipedia.org/wiki/Omar_Khayyam" target="_blank" rel="noopener">Omar Khayyam</a>
							{tr('poetText')}
						</p>
					</div>

					<div class="credits-section">
						<div class="credits-title">{tr('credits')}</div>
						<p>
							{tr('builtWith')}
							<a href="https://svelte.dev" target="_blank" rel="noopener">Svelte 5</a>,
							<a href="https://kit.svelte.dev" target="_blank" rel="noopener">SvelteKit</a>,
							<a href="https://threejs.org" target="_blank" rel="noopener">Three.js</a>,
							<a href="https://protectwise.github.io/troika/troika-three-text/" target="_blank" rel="noopener">Troika</a>,
							<a href="https://opentype.js.org" target="_blank" rel="noopener">opentype.js</a>,
							<a href="https://github.com/nbd-wtf/nostr-tools" target="_blank" rel="noopener">nostr-tools</a>,
							<a href="https://yjs.dev" target="_blank" rel="noopener">Yjs</a>
						</p>
						<p>
							{tr('fontsBy')}
							<a href="https://rastikerdar.github.io/vazirmatn/" target="_blank" rel="noopener">Vazirmatn</a> (Saber Rastikerdar),
							Helvetiker (Three.js)
						</p>
						<p>
							{tr('textsFrom')}
							<a href="https://github.com/mehdisadeghi" target="_blank" rel="noopener">Mehdi Sadeghi</a> (FA),
							<a href="https://www.okonlife.com/poems/" target="_blank" rel="noopener">Shahriar Shahriari</a> (EN),
							Unknown (DE)
						</p>
						<p>
							{tr('madeWith')}
							<a href="https://claude.ai/claude-code" target="_blank" rel="noopener">Claude Code</a>
						</p>
						<p class="credits-date">Public Domain 2025</p>
					</div>
				</div>
			</div>
		</fieldset>
	</header>

	<div class="metrics-bar">
		<div class="metric">
			<span class="metric-value">{formatNumber(wpm)}</span>
			<span class="metric-label">{tr('wpm')}</span>
		</div>
		<div class="metric">
			<span class="metric-value">{formatPercent(accuracy)}</span>
			<span class="metric-label">{tr('accuracy')}</span>
		</div>
		<div class="metric">
			<span class="metric-value">{formatTime(displayTime)}<sup class="metric-unit">{tr('sec')}</sup></span>
			<span class="metric-label">{tr('time')}</span>
		</div>
		<div class="metric">
			<span class="metric-value">{formatPercent(progress)}</span>
			<span class="metric-label">{formatNumber(remainingChars)}</span>
		</div>
	</div>

	<div class="text-display" bind:this={textDisplayElement} dir={textDir}>
		<div class="scroll-container" style="transform: translateY({scrollOffset}px);">
			{#each lines as line, lineIdx}
				{@const distance = Math.abs(lineIdx - currentLineIndex)}
				{@const lineState = distance === 0 ? 'active' : distance === 1 ? 'adjacent' : lineIdx < currentLineIndex ? 'done' : 'upcoming'}
				{@const isTextStart = lineIdx > 0 && textStartLines.has(lineIdx)}
				<div class="line {lineState}" class:text-start={isTextStart}>
					{#each line.split('') as char, charIdx}
						{@const isZeroWidth = char === '\u200C' || char === '\u200B' || char === '\u200D'}
						{@const globalIdx = linePositions[lineIdx].start + charIdx}
						{@const typedChar = globalIdx < userInput.length ? userInput[globalIdx] : null}
						{@const isError = typedChar !== null && typedChar !== char}
						{@const displayChar = (isError && errorReplace) ? typedChar : char}
						<span class="char {lineCharStates[lineIdx]?.[charIdx] || 'pending'}" class:zw={isZeroWidth}>{displayChar}</span>
					{/each}
					{#if line.length === 0}
						<span class="char pending">&nbsp;</span>
					{/if}
				</div>
			{/each}
		</div>
		<div class="text-credit">
			{#if meta.translator}
				© <a href={meta.translatorUrl} target="_blank" rel="noopener">{meta.translator}</a>{#if meta.license}, {meta.license}{/if}
				{#if currentTextItem?.number}
					<span class="text-number">#{currentTextItem.number}</span>
				{/if}
				{#if currentTextItem?.url}
					<a class="text-url" href={currentTextItem.url} target="_blank" rel="noopener">source</a>
				{/if}
			{/if}
		</div>
	</div>

	<div class="keyboard" class:layout-mismatch={layoutMismatch} dir="ltr">
		{#each keyboard.rows as row}
			<div class="keyboard-row">
				{#each row.keys as key}
					{@const isPressed = pressedKeys.has(key.code) || (key.modifier === 'shift' && modifiers.shift) || (key.modifier === 'ctrl' && modifiers.ctrl) || (key.modifier === 'alt' && modifiers.alt) || (key.modifier === 'altgr' && modifiers.altgr) || (key.modifier === 'meta' && modifiers.meta)}
					{@const isExpected = nextKey?.code === key.code || (key.modifier === 'shift' && nextKey?.level === 1) || (key.modifier === 'altgr' && nextKey?.level === 2)}
					{@const charIndex = modifiers.altgr && key.chars[2] ? 2 : modifiers.shift && key.chars[1] ? 1 : 0}
					{@const displayChar = key.label || key.chars[charIndex] || key.chars[0] || ''}
					<div
						class="key"
						class:pressed={isPressed}
						class:expected={isExpected && !isComplete}
						class:modifier={key.modifier}
						class:iso-enter-top={key.isoEnterTop}
						class:iso-enter-bottom={key.isoEnterBottom}
						class:spacer={key.spacer}
						style={key.width ? `flex: ${key.width};` : ''}
					>
						<span class="key-char">{displayChar}</span>
						{#if key.chars[1] && !key.modifier && !key.label && key.chars[1] !== key.chars[0]}
							<span class="key-shift">{key.chars[1]}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</div>

	{#if multiplayerRoom}
		{@const displayParticipants = mergedParticipants}
		{@const participantCount = displayParticipants.length}
		<div class="race-track">
			<div class="race-header">
				<span class="room-code">{multiplayerRoom.roomCode}</span>
				<span class="connection-status" class:connected={signalingConnected} class:has-peers={peerCount > 0} title={signalingConnected ? `Signaling OK, ${peerCount} peer(s)` : 'Signaling disconnected'}>
					{#if signalingConnected}
						{#if peerCount > 0}●{:else}○{/if}
					{:else}
						⚠
					{/if}
				</span>
				<span class="race-status">
					{#if roomState === 'waiting'}
						{participantCount} player{participantCount !== 1 ? 's' : ''}
					{:else if roomState === 'countdown'}
						{countdown}
					{:else if roomState === 'racing'}
						{formatTime(Math.max(0, multiplayerDuration - elapsedSeconds))}
					{:else}
						Finished
					{/if}
				</span>
				<button class="btn-small" onclick={leaveRoom}>{tr('leave')}</button>
			</div>
			<div class="race-lanes">
				{#each displayParticipants as p (p.odyseeId || p.pubkeyHex)}
					{@const progressPct = targetText.length > 0 ? (p.progress / targetText.length) * 100 : 0}
					{@const isMe = p.odyseeId === identity?.odyseeId || p.pubkeyHex === identity?.pubkeyHex}
					<div class="race-lane" class:is-me={isMe} class:disconnected={!p.connected}>
						<span class="lane-name">{p.name}</span>
						<div class="lane-progress">
							<div class="lane-bar" style="width: {progressPct}%"></div>
							<span class="lane-icon" style="inset-inline-start: {progressPct}%; color: hsl({p.color}, 60%, var(--accent-l))">{isMe ? '🐢' : '🐇'}</span>
						</div>
						<span class="lane-wpm">{formatNumber(p.wpm)}</span>
					</div>
				{/each}
			</div>
			{#if roomState === 'waiting'}
				<button class="btn race-start-btn" onclick={startMultiplayerRace}>{tr('startRace')}</button>
			{/if}
			{#if roomState === 'finished'}
				{@const sortedByWpm = [...displayParticipants].sort((a, b) => b.wpm - a.wpm)}
				{@const winner = sortedByWpm[0]}
				{@const myResult = sortedByWpm.find(p => p.odyseeId === identity?.odyseeId)}
				{@const myRank = sortedByWpm.findIndex(p => p.odyseeId === identity?.odyseeId) + 1}
				{@const isWinner = winner?.odyseeId === identity?.odyseeId}
				<div class="race-results">
					<div class="result-winner" style="color: hsl({winner?.color || 200}, 60%, var(--accent-l))">
						{#if isWinner}
							{tr('youWon')}
						{:else}
							{tr('winner')}: {winner?.name}
						{/if}
						<span class="result-stats">{formatNumber(winner?.wpm || 0)} {tr('wpm')} / {winner?.accuracy || 0}%</span>
					</div>
					{#if !isWinner && myResult}
						<div class="result-you">
							{tr('yourResult')}: {tr('rank')} #{myRank}
							<span class="result-stats">{formatNumber(myResult.wpm)} {tr('wpm')} / {myResult.accuracy}%</span>
						</div>
					{/if}
				</div>
				<button class="btn" onclick={raceAgain}>{tr('raceAgain')}</button>
			{/if}
		</div>
	{/if}

	{#if showJoinModal}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div
			class="modal-overlay"
			role="button"
			tabindex="0"
			aria-label="Close join room dialog"
			onclick={() => showJoinModal = false}
			onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (showJoinModal = false)}
		>
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div
				class="modal"
				role="dialog"
				aria-modal="true"
				tabindex="0"
				onclick={(e) => e.stopPropagation()}
			>
				<h3>{tr('joinRoom')}</h3>
				<input
					type="text"
					class="room-input"
					placeholder="Room code (e.g. ABCD)"
					maxlength="4"
					bind:value={joinRoomCode}
					onkeydown={(e) => e.key === 'Enter' && joinRoom()}
				/>
				<div class="modal-buttons">
					<button class="btn" onclick={joinRoom}>{tr('join')}</button>
					<button class="btn" onclick={() => showJoinModal = false}>{tr('close')}</button>
				</div>

				<div class="active-rooms">
					<div class="active-rooms-header">
						<span>Active Rooms</span>
						<button class="btn-small" onclick={loadActiveRooms} disabled={loadingRooms}>
							{loadingRooms ? '...' : 'Refresh'}
						</button>
					</div>
					{#if activeRooms.length === 0}
						<p class="no-rooms">{loadingRooms ? 'Loading...' : 'No active rooms found'}</p>
					{:else}
						<ul class="room-list">
							{#each activeRooms as room}
								<li class="room-item">
									<span class="room-item-code">{room.roomCode}</span>
									<span class="room-item-players">{room.participants?.length || 1}</span>
									<span class="room-item-host" style="color: hsl({room.participants?.[0]?.color || 200}, 50%, 40%)">{room.participants?.[0]?.name || 'Unknown'}</span>
									<span class="room-item-kb">{room.keyboard}</span>
									<button class="btn-small" onclick={() => joinActiveRoom(room)}>{tr('join')}</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</div>
		</div>
	{/if}

	<div class="input-area">
		{#if isComplete && !multiplayerRoom}
			<div class="complete-message">
				<p>{tr('raceComplete')} {formatNumber(wpm)} {tr('wpm')}{uiDir === 'rtl' ? '،' : ','} {formatPercent(accuracy)}</p>
				<div class="complete-actions">
					<button class="btn" onclick={loadNewText}>{tr('newText')}</button>
					<button class="btn" onclick={continueTyping}>{tr('oneMoreTime')}</button>
				</div>
			</div>
		{/if}
		<textarea
			bind:this={inputElement}
			class="input-field"
			dir="auto"
			placeholder={multiplayerRoom && roomState !== 'racing' ? 'Waiting for race to start...' : tr('startTyping')}
			value={userInput}
			onbeforeinput={handleBeforeInput}
			oninput={handleInput}
			disabled={isComplete || (multiplayerRoom && roomState !== 'racing')}
			autocomplete="off"
			autocorrect="off"
			autocapitalize="off"
			spellcheck="false"
			rows="3"
		></textarea>
		<div class="controls">
			{#if !multiplayerRoom}
				<button class="btn" onclick={loadNewText}>{tr('newText')}</button>
				<button class="btn" onclick={handleLoadTexts}>{tr('loadText')}</button>
				{#if uploadedTexts}
					<button class="btn" onclick={handleClearTexts}>{tr('clearTexts')}</button>
				{/if}
				<span class="controls-divider"></span>
				<button class="btn" onclick={createRoom}>{tr('createRoom')}</button>
				<button class="btn" onclick={() => { showJoinModal = true; loadActiveRooms(); }}>{tr('joinRoom')}</button>
			{/if}
		</div>
	</div>

	<details class="history-panel">
		<summary>{tr('history')} ({formatNumber(data.history.length)})</summary>
		{#if data.history.length === 0}
			<p>{tr('noHistory')}</p>
		{:else}
			<ul class="history-list">
				{#each data.history.slice(0, 20) as race}
					<li class="history-item">
						<span>{formatDate(race.timestamp)}</span>
						<span>{formatNumber(race.wpm)} {tr('wpm')}</span>
						<span>{formatPercent(race.accuracy)}</span>
					</li>
				{/each}
			</ul>
			<div class="history-chart">
				<canvas bind:this={historyChartEl}></canvas>
			</div>
			<button class="btn-small" onclick={handleClearHistory}>{tr('clear')}</button>
		{/if}
	</details>

	<div class="build-date">{__BUILD_DATE__}</div>
</div>

<style>
	/* Background effects layer (dots) */
	.background-effects {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: -3;
	}

	/* Three.js 3D parallax container */
	.parallax3d-container {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: -2;
	}

	/* Background lanes - space invaders parallax effect */
	.background-lanes {
		position: fixed;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: -1;
	}

	.background-lanes.hidden {
		display: none;
	}

	/* Dot pattern background */
	.background-effects.dot-pattern {
		background-color: var(--bg);
		background-image: radial-gradient(circle at 1px 1px, hsla(var(--hue), var(--base-s), 30%, 0.35) 1px, transparent 0);
		background-size: 20px 20px;
		-webkit-mask-image: linear-gradient(to right, transparent 0%, #000 30%, #000 70%, transparent 100%);
		mask-image: linear-gradient(to right, transparent 0%, #000 30%, #000 70%, transparent 100%);
	}

	:global(.dark) .background-effects.dot-pattern {
		background-image: radial-gradient(circle at 1px 1px, hsla(var(--hue), var(--base-s), 70%, 0.3) 1px, transparent 0);
	}

	.bg-lane {
		position: absolute;
		left: 0;
		white-space: nowrap;
		color: hsl(var(--hue), var(--base-s), 50%);
		animation: scroll-ltr linear forwards;
		will-change: transform;
	}

	.bg-lane.rtl {
		animation-name: scroll-rtl;
	}


	/* LTR text moves right-to-left - travel full width + 200vw buffer for giant text */
	@keyframes scroll-ltr {
		from { transform: translateX(100vw); }
		to { transform: translateX(calc(-100% - 200vw)); }
	}

	/* RTL text moves left-to-right - start just off left edge, exit right */
	@keyframes scroll-rtl {
		from { transform: translateX(-100%); }
		to { transform: translateX(calc(100vw + 200vw)); }
	}

	.header {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow: hidden;
		margin: 0;
	}

	.settings-row {
		display: flex;
		align-items: center;
		gap: 0.5rem 1rem;
		flex-wrap: wrap;
	}

	.settings-row.settings-row-top {
		gap: 0.3rem;
		justify-content: space-between;
		font-family: system-ui, -apple-system, sans-serif;
	}

	.brand {
		font-family: system-ui, -apple-system, sans-serif;
		font-weight: 900;
		font-size: 1.5rem;
		letter-spacing: 0.15em;
		color: var(--text-muted);
		text-decoration: none;
	}

	.top-controls {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		flex-wrap: wrap;
	}

	.settings-panel {
		display: none;
		max-height: 0;
		overflow: hidden;
		opacity: 0;
		margin: 0;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 0.25rem;
		min-inline-size: 0;
	}

	.settings-panel.open {
		display: block;
		max-height: 80vh;
		overflow-y: auto;
		opacity: 1;
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-color: var(--border);
		background: var(--bg-card-alpha);
	}

	.settings-panel legend {
		font-size: 0.625rem;
		color: var(--text-muted);
		padding: 0 0.25rem;
		margin: 0;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.settings-content {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.settings-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
	}

	.setting-item {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.setting-label {
		font-size: 0.7rem;
		color: var(--text-muted);
	}

	.setting-value {
		font-size: 0.65rem;
		color: var(--text-muted);
		min-width: 2rem;
		text-align: center;
	}

	.setting-select {
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.setting-select option {
		unicode-bidi: plaintext;
		direction: ltr;
	}

	.setting-btn {
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.setting-btn:hover {
		background: var(--border);
	}

	.setting-btn.reset-btn {
		color: var(--error);
		border-color: hsla(0, 45%, 45%, 0.3);
	}

	.setting-btn.reset-btn:hover {
		background: hsla(0, 45%, 45%, 0.1);
	}

	.setting-input-small {
		width: 3rem;
		padding: 0.2rem 0.3rem;
		font-family: inherit;
		font-size: 0.7rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		text-align: center;
	}

	.setting-input-small::placeholder {
		font-size: 0.6rem;
	}

	.setting-input-small::-webkit-outer-spin-button,
	.setting-input-small::-webkit-inner-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}

	.setting-vertical {
		flex-direction: column;
		align-items: stretch !important;
		gap: 0.25rem;
	}

	.setting-textarea {
		width: 100%;
		padding: 0.25rem 0.5rem;
		font-family: monospace;
		font-size: 0.65rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		resize: vertical;
		line-height: 1.4;
	}

	.credits {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
		font-size: 0.65rem;
		color: var(--text-muted);
		line-height: 1.6;
	}

	.credits-section {
		margin-bottom: 0.75rem;
	}

	.credits-section:last-child {
		margin-bottom: 0;
	}

	.credits-title {
		font-size: 0.625rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 0.25rem;
		font-weight: 600;
	}

	.credits-section p {
		margin: 0.2rem 0;
	}

	.credits a {
		color: var(--text);
		text-decoration: none;
	}

	.credits a:hover {
		text-decoration: underline;
	}

	.credits-date {
		margin-top: 0.5rem !important;
		opacity: 0.6;
	}

	.setting-input {
		flex: 1;
		min-width: 0;
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.7rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
	}


	.setting-item input[type="range"] {
		width: 4rem;
		cursor: pointer;
	}

	.setting-item input[type="color"] {
		width: 1.25rem;
		height: 1.25rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 50%;
		cursor: pointer;
		background: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.setting-item input[type="color"]::-webkit-color-swatch-wrapper {
		padding: 0;
	}

	.setting-item input[type="color"]::-webkit-color-swatch {
		border: none;
		border-radius: 50%;
	}

	.setting-item input[type="color"]::-moz-color-swatch {
		border: none;
		border-radius: 50%;
	}

	.setting-item input[type="checkbox"] {
		cursor: pointer;
	}

	.toggle-arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		transition: transform 0.25s ease-out;
		transform: rotate(0deg);
		font-size: 1rem;
		line-height: 1;
	}

	.toggle-arrow.open {
		transform: rotate(90deg);
	}

	.toggle-arrow.rtl.open {
		transform: rotate(-90deg);
	}

	.mode-btn {
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.mode-btn.active {
		background: var(--text);
		color: var(--bg);
		border-color: var(--text);
	}

	.mode-btn.more-toggle {
		min-width: 1.5rem;
		padding: 0.25rem 0.4rem;
	}

	.keyboard-select {
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
		unicode-bidi: plaintext;
	}

	.keyboard-select option,
	.keyboard-select optgroup {
		unicode-bidi: plaintext;
		direction: ltr;
	}

	.keyboard-select:focus {
		outline: 1px solid var(--text-muted);
	}

	.btn-small {
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.btn-small:hover {
		background: var(--border);
	}

	.btn-tiny {
		padding: 0.1rem 0.3rem;
		font-family: inherit;
		font-size: 0.65rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.2rem;
		color: var(--text-muted);
		cursor: pointer;
		margin-inline-start: 0.25rem;
		vertical-align: middle;
	}

	.btn-tiny:hover {
		background: var(--border);
	}

	.metrics-bar {
		display: flex;
		justify-content: center;
		gap: 2rem;
		padding: 0.5rem 1rem;
		background: var(--bg-card-alpha);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		font-family: 'Vazirmatn', system-ui, -apple-system, sans-serif;
	}

	.metric {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0;
	}

	.metric-value {
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.2;
	}

	.metric-unit {
		font-size: 0.5em;
		font-weight: 400;
		opacity: 0.7;
		margin-inline-start: 0.1em;
	}

	.metric-label {
		font-size: 0.625rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.text-display {
		position: relative;
		min-height: calc(var(--font-size) * 5);
		max-height: clamp(7rem, calc(100vh - 26rem), 32vh);
		overflow: hidden;
		background: var(--bg-card-alpha);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		padding: 0.75rem 1rem;
	}

	.text-credit {
		position: absolute;
		bottom: 0.25rem;
		left: 0.5rem;
		font-size: 0.625rem;
		color: var(--text-muted);
		opacity: 0.5;
	}

	.text-credit a {
		color: inherit;
		text-decoration: none;
	}

	.text-credit a:hover {
		text-decoration: underline;
	}

	.text-number {
		margin-inline-start: 0.5em;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.text-url {
		margin-inline-start: 0.5em;
		opacity: 0;
		transition: opacity 0.2s;
	}

	.text-credit:hover .text-number,
	.text-credit:hover .text-url {
		opacity: 1;
	}

	.scroll-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		transition: transform 0.3s ease-out;
		padding: 1rem 2rem;
	}

	.line {
		font-size: var(--font-size);
		line-height: 2.2;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-wrap: break-word;
		text-align: center;
		max-width: 90%;
		transition: all 0.35s ease-out;
		transform-origin: center center;
	}

	.line.done {
		opacity: 0.1;
		transform: scale(0.55);
		filter: blur(1px);
	}

	.line.adjacent {
		opacity: 0.6;
		transform: scale(0.82);
	}

	.line.active {
		opacity: 1;
		transform: scale(1.15);
		font-weight: 500;
		color: var(--text);
	}

	.line.active .char.pending {
		color: var(--text);
	}

	.line.upcoming {
		opacity: 0.25;
		transform: scale(0.65);
		filter: blur(0.5px);
	}

	.line.text-start {
		margin-top: 1.5em;
	}

	.char {
		display: inline;
		transition: color 0.1s;
		/* Preserve Arabic/Persian text shaping */
		font-feature-settings: "calt" 1, "liga" 1;
	}

	/* Zero-width characters (ZWNJ, ZWS, ZWJ) should not break text shaping */
	.char.zw {
		display: contents;
	}

	.char.correct {
		color: var(--correct);
	}

	.char.error {
		color: var(--error);
		text-decoration: underline;
		text-decoration-style: wavy;
		text-underline-offset: 0.15em;
	}

	.char.current {
		background: var(--current);
		border-radius: 0.125rem;
	}

	.char.pending {
		color: var(--pending);
	}


	.keyboard {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		padding: 0.5rem;
		background: var(--bg-card-alpha);
		border: 2px solid var(--border);
		border-radius: 0.25rem;
		font-family: var(--font-family-mono);
		user-select: none;
		transition: border-color 0.05s ease-out, box-shadow 0.05s ease-out;
	}


	.keyboard.layout-mismatch {
		border-color: var(--error);
		box-shadow: inset 0 0 20px hsla(0, 45%, 45%, 0.15), 0 0 12px hsla(0, 45%, 45%, 0.5);
	}

	.keyboard-row {
		display: flex;
		gap: 0.2rem;
	}

	.key {
		flex: 1;
		min-width: 0;
		height: 2.5rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		font-size: 1rem;
		color: var(--text-muted);
		position: relative;
		transition: all 0.1s;
	}

	.key.modifier {
		font-size: 0.75rem;
	}

	.key.spacer {
		visibility: hidden;
	}

	.key.iso-enter-top {
		position: relative;
		border-bottom-right-radius: 0;
	}

	.key.iso-enter-top::after {
		content: '';
		position: absolute;
		top: 100%;
		right: -1px;
		width: 83%;
		height: calc(2.5rem + 0.2rem);
		background: var(--bg);
		border: 1px solid var(--border);
		border-top: none;
		border-radius: 0 0 0.25rem 0.25rem;
	}

	.key.iso-enter-top.pressed::after {
		background: var(--text);
		border-color: var(--text);
	}

	.key.iso-enter-bottom {
		visibility: hidden;
	}

	.key.pressed {
		background: var(--text);
		color: var(--bg);
		border-color: var(--text);
		transform: scale(0.95);
	}

	.key-char {
		line-height: 1;
	}

	.key-shift {
		position: absolute;
		top: 0.15rem;
		right: 0.25rem;
		font-size: 0.8rem;
		opacity: 0.6;
	}

	.input-area {
		padding: 0.5rem;
		background: var(--bg-card-alpha);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
	}

	.input-field {
		width: 100%;
		padding: 0.5rem;
		font-family: 'Vazirmatn', system-ui, -apple-system, sans-serif;
		font-size: var(--font-size);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		background: var(--bg);
		color: var(--text);
		text-align: inherit;
		resize: none;
	}

	.input-field:focus {
		outline: 2px solid var(--text-muted);
		outline-offset: 2px;
	}

	.controls {
		display: flex;
		justify-content: center;
		margin-top: 0.5rem;
	}

	.btn {
		padding: 0.375rem 1rem;
		font-family: inherit;
		font-size: 0.75rem;
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.btn:hover {
		background: var(--border);
	}

	.complete-message {
		text-align: center;
		padding: 0.75rem;
		margin-bottom: 0.75rem;
		background: var(--border);
		border-radius: 0.25rem;
	}

	.complete-actions {
		display: flex;
		justify-content: center;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.25rem;
	}

	.history-panel {
		padding: 0.75rem 1rem;
		background: var(--bg-card-alpha);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		font-size: 0.875rem;
	}

	.history-panel summary {
		cursor: pointer;
		color: var(--text-muted);
	}

	.history-panel[open] summary {
		margin-bottom: 0.75rem;
	}

	.history-panel .btn-small {
		display: block;
		margin-top: 0.75rem;
		margin-inline-start: auto;
	}

	.history-chart {
		margin-top: 0.75rem;
		height: 180px;
	}

	.history-list {
		list-style: none;
	}

	.history-item {
		display: flex;
		justify-content: space-between;
		padding: 0.375rem 0;
		border-bottom: 1px solid var(--border);
		font-size: 0.75rem;
	}

	.history-item:last-child {
		border-bottom: none;
	}

	/* Multiplayer styles */
	.race-track {
		padding: 0.75rem 1rem;
		background: var(--bg-card-alpha);
		border: 1px solid var(--border);
		border-radius: 0.25rem;
	}

	.race-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.room-code {
		font-family: var(--font-family-mono);
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--text);
	}

	.connection-status {
		font-size: 0.75rem;
		color: var(--error);
		cursor: help;
	}

	.connection-status.connected {
		color: var(--text-muted);
	}

	.connection-status.connected.has-peers {
		color: var(--correct);
	}

	.race-status {
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.race-lanes {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.race-lane {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
	}

	.race-lane.is-me {
		font-weight: 600;
	}

	.race-lane.disconnected {
		opacity: 0.4;
	}

	.lane-icon {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		font-size: 1.25rem;
		line-height: 1;
		transition: inset-inline-start 0.15s ease-out;
	}

	[dir="ltr"] .lane-icon {
		transform: translateY(-50%) scaleX(-1);
	}

	.lane-name {
		font-size: 0.75rem;
		min-width: 6rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.lane-progress {
		flex: 1;
		height: 0.5rem;
		border-radius: 0.25rem;
		position: relative;
		border: 1px solid var(--border);
	}

	.lane-bar {
		height: 100%;
		background: var(--text-muted);
		transition: width 0.15s ease-out;
		border-radius: 0.25rem;
	}

	.lane-wpm {
		font-size: 0.75rem;
		font-family: var(--font-family-mono);
		min-width: 2.5rem;
		text-align: right;
		color: var(--text-muted);
	}

	.race-start-btn {
		margin-top: 0.75rem;
		width: 100%;
	}

	.race-results {
		margin-top: 1rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		text-align: center;
	}

	.result-winner {
		font-size: 1.25rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
	}

	.result-you {
		color: var(--text-muted);
	}

	.result-stats {
		display: block;
		font-size: 0.875rem;
		font-weight: normal;
		opacity: 0.8;
	}

	.controls-divider {
		width: 1px;
		height: 1.5rem;
		background: var(--border);
		margin: 0 0.25rem;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		background: hsla(var(--hue), var(--base-s), 15%, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.modal {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 1.5rem;
		min-width: 20rem;
		max-width: 90vw;
	}

	.modal h3 {
		margin-bottom: 0.75rem;
		font-size: 1rem;
	}

	.modal p {
		margin-bottom: 1rem;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.modal-buttons {
		display: flex;
		gap: 0.5rem;
		justify-content: flex-end;
	}

	.room-input {
		width: 100%;
		padding: 0.75rem;
		font-family: var(--font-family-mono);
		font-size: 1.25rem;
		text-align: center;
		text-transform: uppercase;
		letter-spacing: 0.25em;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		background: var(--bg);
		color: var(--text);
		margin-bottom: 1rem;
	}

	.room-input:focus {
		outline: 2px solid var(--text-muted);
		outline-offset: 2px;
	}

	.active-rooms {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.active-rooms-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.no-rooms {
		font-size: 0.75rem;
		color: var(--text-muted);
		text-align: center;
		padding: 0.5rem;
	}

	.room-list {
		list-style: none;
		max-height: 10rem;
		overflow-y: auto;
	}

	.room-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem;
		border-radius: 0.25rem;
		background: var(--bg);
		margin-bottom: 0.375rem;
	}

	.room-item:hover {
		background: var(--border);
	}

	.room-item-code {
		font-family: var(--font-family-mono);
		font-weight: 600;
		font-size: 0.875rem;
	}

	.room-item-players {
		font-size: 0.625rem;
		color: var(--text-muted);
		background: var(--border);
		padding: 0.125rem 0.375rem;
		border-radius: 0.75rem;
	}

	.room-item-host {
		flex: 1;
		font-size: 0.75rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.room-item-kb {
		font-size: 0.625rem;
		color: var(--text-muted);
	}

	/* Parallax - hide animated background elements when disabled (dots stay visible) */
	.app:not(.parallax) .background-lanes,
	.app:not(.parallax) .parallax3d-container {
		display: none;
	}

	.build-date {
		flex-grow: 1;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		min-height: 0;
		font-size: 0.625rem;
		line-height: 1;
		color: var(--text-muted);
		opacity: 0.4;
		font-family: ui-monospace, monospace;
	}
</style>
