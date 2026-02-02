<script>
	import { onMount, tick } from 'svelte';
	import { t, getDirection, supportedLanguages } from '$lib/i18n.js';
	import { getRandomTextItem, getTextMeta } from '$lib/texts.js';
	import { buildKeyboard, languageMappings, keyboardGroups, isRTL } from '$lib/keyboards/index.js';
	import {
		loadData,
		saveData,
		addRaceResult,
		updateSettings,
		exportData,
		importData,
		clearHistory,
		resetSettings
	} from '$lib/storage.js';

	const MODES = {
		time: [15, 30, 60, 120],
		text: [1, 3, 5, 10]
	};

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

	// Settings panel toggle
	let showMoreSettings = $state(false);

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
	let keyboard = $derived(buildKeyboard(physicalLayout, keyboardLocale));
	let keyboardMapping = $derived(languageMappings[keyboardLocale]);

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
	// Text content based on keyboard direction (RTL keyboards get FA texts, LTR get EN texts)
	let textLang = $derived(isRTL(keyboardLocale) ? 'fa' : 'en');
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

	function handleInput(e) {
		const value = e.target.value;

		// Check for layout mismatch on new characters - ignore and warn
		if (value.length > userInput.length) {
			const newChar = value[value.length - 1];
			if (checkLayoutMismatch(newChar)) {
				triggerMismatchWarning();
				e.target.value = userInput;
				return;
			}
		}

		if (!startTime && value.length > 0) {
			startTime = Date.now();
			startTimer();
		}

		userInput = value;

		// Text mode: complete when all text is typed
		if (modeType === 'text' && value.length >= targetText.length && !isComplete) {
			completeRace();
		}

		// Time mode: generate more text when running low
		if (modeType === 'time' && !isComplete && targetText.length - value.length < 100) {
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

		if (e.key === 'Enter' && isComplete) {
			e.preventDefault();
			loadNewText();
		}

		if (e.key === 'Escape') {
			e.preventDefault();
			loadNewText();
		}

		// Focus input on any printable key
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && inputElement) {
			inputElement.focus();
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
		inputElement?.focus();
	}

	function changeSetting(key, value) {
		data = updateSettings({ [key]: value });
		if (key === 'keyboardLocale' || key === 'modeType' || key === 'modeValue') {
			loadNewText();
		}
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

	onMount(async () => {
		data = loadData();
		if (!data.settings.uiLanguage) {
			data.settings.uiLanguage = detectLanguage();
			saveData(data);
		}
		if (!data.settings.keyboardLocale) {
			data.settings.keyboardLocale = data.settings.uiLanguage === 'fa' ? 'fa-IR' : 'en-US';
			saveData(data);
		}
		await loadNewText();

		return () => {
			stopTimer();
			stopLaneSpawner();
		};
	});

	// Focus input after render
	$effect(() => {
		if (inputElement && !isComplete) {
			inputElement.focus();
		}
	});

	// Check for time mode completion
	$effect(() => {
		if (modeType === 'time' && startTime && !isComplete && remainingTime === 0) {
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

	// Spawn a single background lane with extreme diversity (log-normal-like distribution)
	function spawnLane(text, direction) {
		// Pareto-like distributions: most small/dim/slow, rare giants/bold/fast
		const sizeRand = Math.random();
		const speedRand = Math.random();
		const opacityRand = Math.random();

		// Size: 0.4rem to 18rem - cubic makes most small, rare giants
		const fontSize = 0.4 + Math.pow(sizeRand, 4) * 17.6;

		// Speed: 20s to 180s - cubic makes most medium-slow, rare glacial
		const duration = 20 + Math.pow(speedRand, 3) * 160;

		// Opacity: 0.02 to 0.35 - cubic makes most faint, rare bold
		const opacity = 0.02 + Math.pow(opacityRand, 3) * 0.33;

		backgroundLanes = [...backgroundLanes, {
			id: laneIdCounter++,
			text,
			direction,
			top: Math.random() * 94 + 3, // 3-97% from top
			fontSize,
			duration,
			opacity
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
		laneSpawnInterval = setInterval(() => {
			if (backgroundLanes.length < LANE_POOL_SIZE) {
				const text = getCurrentLaneText();
				if (text) spawnLane(text, textDir);
			}
		}, 800);
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
</script>

<svelte:head>
	<style>
		@import url('https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600&display=swap');
	</style>
</svelte:head>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} onresize={updateScrollOffset} />

<div
	class="app"
	dir={uiDir}
	style="--hue: {data.settings.hue}; --font-size: {data.settings.fontSize}rem;"
>
	<div class="background-lanes" aria-hidden="true">
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
		<div class="settings-row">
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
				class="mode-btn more-toggle"
				onclick={() => showMoreSettings = !showMoreSettings}
				title="More settings"
			>
				<span class="toggle-arrow" class:open={showMoreSettings} class:rtl={uiDir === 'rtl'}>›</span>
			</button>
		</div>

		<fieldset class="settings-panel" class:open={showMoreSettings}>
			<legend>{tr('settings')}</legend>
			<div class="settings-content">
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

				<div class="setting-item">
					<span class="setting-label">{tr('data')}</span>
					<button class="setting-btn" onclick={handleExport}>{tr('export')}</button>
					<button class="setting-btn" onclick={handleImport}>{tr('import')}</button>
					<button class="setting-btn reset-btn" onclick={handleResetSettings}>{uiDir === 'rtl' ? 'ریسیت' : 'reset'}</button>
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

	<div class="input-area">
		{#if isComplete}
			<div class="complete-message">
				<p>{tr('raceComplete')} {formatNumber(wpm)} {tr('wpm')}, {formatPercent(accuracy)}</p>
				<p class="hint">{tr('pressEnter')}</p>
			</div>
		{/if}
		<textarea
			bind:this={inputElement}
			class="input-field"
			dir="auto"
			placeholder={tr('startTyping')}
			value={userInput}
			oninput={handleInput}
			disabled={isComplete}
			autocomplete="off"
			autocorrect="off"
			autocapitalize="off"
			spellcheck="false"
			rows="3"
		></textarea>
		<div class="controls">
			<button class="btn" onclick={loadNewText}>{tr('newText')}</button>
			<button class="btn" onclick={handleLoadTexts}>{tr('loadText')}</button>
			{#if uploadedTexts}
				<button class="btn" onclick={handleClearTexts}>{tr('clearTexts')}</button>
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
			<button class="btn-small" onclick={handleClearHistory}>{tr('clear')}</button>
		{/if}
	</details>

	</div>

<style>
	/* Background lanes - space invaders parallax effect */
	.background-lanes {
		position: fixed;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: -1;
	}

	.bg-lane {
		position: absolute;
		white-space: nowrap;
		color: hsl(var(--hue), var(--base-s), 50%);
		animation: scroll-ltr linear forwards;
		will-change: transform;
	}

	.bg-lane.rtl {
		animation-name: scroll-rtl;
	}

	/* LTR text moves right-to-left - go fully off-screen before ending */
	@keyframes scroll-ltr {
		from { transform: translateX(100vw); }
		to { transform: translateX(calc(-100% - 10vw)); }
	}

	/* RTL text moves left-to-right - go fully off-screen before ending */
	@keyframes scroll-rtl {
		from { transform: translateX(calc(-100% - 10vw)); }
		to { transform: translateX(100vw); }
	}

	.header {
		display: flex;
		flex-direction: column;
		gap: 0;
		overflow: hidden;
	}

	.settings-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		flex-wrap: wrap;
	}

	.settings-panel {
		max-height: 0;
		overflow: hidden;
		opacity: 0;
		transition: max-height 0.25s ease-out, opacity 0.2s ease-out, margin-top 0.25s ease-out, padding 0.25s ease-out;
		margin: 0;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 0.25rem;
	}

	.settings-panel.open {
		max-height: 10rem;
		opacity: 1;
		margin-top: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-color: var(--border);
	}

	.settings-panel legend {
		font-size: 0.625rem;
		color: var(--text-muted);
		padding: 0 0.25rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.settings-content {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1.5rem;
		max-width: 100%;
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

	.metrics-bar {
		display: flex;
		justify-content: center;
		gap: 2rem;
		padding: 0.5rem 1rem;
		background: hsl(var(--hue), var(--base-s), 100%, 0.85);
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
		min-height: calc(var(--font-size) * 8);
		max-height: 45vh;
		overflow: hidden;
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
		background: hsl(var(--hue), var(--base-s), 100%, 0.85);
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
		background: hsl(var(--hue), var(--base-s), 100%, 0.85);
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

	.hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-top: 0.25rem;
	}

	.history-panel {
		padding: 0.75rem 1rem;
		background: hsl(var(--hue), var(--base-s), 100%, 0.85);
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
		float: inline-end;
		margin-top: 0.5rem;
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
</style>
