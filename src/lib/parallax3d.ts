import {
	AmbientLight,
	AxesHelper,
	CanvasTexture,
	Color,
	DirectionalLight,
	DoubleSide,
	Fog,
	GridHelper,
	Group,
	LinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	Object3D,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	SphereGeometry,
	SpotLight,
	Vector3,
	WebGLRenderer,
	type LineBasicMaterial
} from 'three';
import { Text } from 'troika-three-text';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import type { Font } from 'three/addons/loaders/FontLoader.js';
import { loadFont as loadOpenTypeFont, createArabicExtrudedText } from './arabic-extrude.js';
import type { Font as OpenTypeFont } from 'opentype.js';
import { ScriptInvaderGame, type HitEffectType } from './game.js';
import type { DebugStats } from './webgl.js';

const FONT_VAZIRMATN = 'fonts/Vazirmatn-Regular.ttf';
const FONT_SYSTEM: undefined = undefined;

const FONT_TYPEFACE_URL = 'fonts/helvetiker_regular.typeface.json';

let loadedFont: Font | null = null;
let fontLoadPromise: Promise<Font> | null = null;

let arabicFont: OpenTypeFont | null = null;
let arabicFontPromise: Promise<OpenTypeFont | null> | null = null;

let canvasFontPromise: Promise<FontFaceSet> | null = null;

function loadCanvasFont(): Promise<FontFaceSet> {
	if (canvasFontPromise) return canvasFontPromise;
	canvasFontPromise = document.fonts.ready;
	return canvasFontPromise;
}

async function loadArabicFont(): Promise<OpenTypeFont | null> {
	if (arabicFont) return arabicFont;
	if (arabicFontPromise) return arabicFontPromise;

	arabicFontPromise = loadOpenTypeFont(FONT_VAZIRMATN)
		.then(font => {
			arabicFont = font;
			console.debug('Arabic OpenType font loaded for 3D extrusion');
			return font;
		})
		.catch(err => {
			console.warn('Failed to load Arabic font for extrusion:', err);
			return null;
		});

	return arabicFontPromise;
}

type EffectType = 'none' | 'outline' | 'shadow' | 'emboss' | 'extrude' | 'neon' | 'random';
type TextureType = 'solid' | 'gradient' | 'metallic' | 'glass' | 'random';

const CONCRETE_EFFECTS: EffectType[] = ['none', 'outline', 'shadow', 'emboss', 'extrude', 'neon'];
const CONCRETE_TEXTURES: TextureType[] = ['solid', 'gradient', 'metallic', 'glass'];

interface RendererOptions {
	intensity?: number;
	hue?: number;
	isDark?: boolean;
	isRTL?: boolean;
	effect?: EffectType;
	texture?: TextureType;
	rainbow?: boolean;
}

interface Lane {
	mesh: Object3D;
	startX: number;
	endX: number;
	startY: number;
	endY: number;
	startTime: number;
	duration: number;
	texture: CanvasTexture | null;
	isTroika: boolean;
	width: number;
	height: number;
}

interface DebugOverrides {
	speedMultiplier: number;
	extrudeMultiplier: number;
}

export type { DebugStats } from './webgl.js';

interface FlyState {
	yaw: number;
	pitch: number;
	roll: number;
	keysHeld: Set<string>;
	speed: number;
	lookVelocityX: number;
	lookVelocityY: number;
	savedOrbit: {
		orbitRadius: number;
		rotationX: number;
		rotationY: number;
		velocityX: number;
		velocityY: number;
	};
}

const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'KeyR']);
const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'KeyR', 'Space']);

export class Parallax3DRenderer {
	container: HTMLElement;
	lanes: Map<number, Lane>;
	laneIdCounter: number;
	intensity: number;
	hue: number;
	isDark: boolean;
	isRTL: boolean;
	effect: EffectType;
	texture: TextureType;
	rainbow: boolean;

	rotationX: number;
	rotationY: number;
	velocityX: number;
	velocityY: number;
	isDragging: boolean;
	lastMouseX: number;
	lastMouseY: number;
	lastDragTime: number;
	_dragButton: number;
	private _orbitRadius: number;
	private _orbitTarget: Vector3;
	private _gameKeysHeld: Set<string>;
	private _gameSpeed: number;

	animationId: number | null;
	disposed: boolean;
	font: Font | null;
	contextLost: boolean;
	gameMode: boolean;
	mouseFollow: boolean;

	fps: number;
	paused: boolean;
	onPauseToggle: ((paused: boolean) => void) | null;
	flyMode: boolean;
	invaderMode: boolean;
	fallingText: boolean;
	noFog: boolean;
	private _fly: FlyState | null;
	private _game: ScriptInvaderGame | null;
	private _lastFrameTime: number;
	private _fpsFrameCount: number;
	private _fpsLastTime: number;
	private _pauseStartTime: number;
	private _debugOverrides: DebugOverrides;
	private _axesGroup: Group | null;
	onScoreChange: ((score: number) => void) | null;
	onInvaderStatsChange: ((stats: import('./game.js').InvaderStats) => void) | null;
	onInvaderExit: (() => void) | null;

	scene!: Scene;
	camera!: PerspectiveCamera;
	renderer!: WebGLRenderer;
	private _ambientLight!: AmbientLight;
	private _debugLightGroup: Group | null;
	private _debugSpot: SpotLight | null;

	private _boundResize!: () => void;
	private _boundMouseDown!: (e: MouseEvent) => void;
	private _boundMouseUp!: () => void;
	private _boundMouseMove!: (e: MouseEvent) => void;
	private _boundWheel!: (e: WheelEvent) => void;
	private _boundFlyKeyDown!: (e: KeyboardEvent) => void;
	private _boundFlyKeyUp!: (e: KeyboardEvent) => void;
	private _boundFlyBlur!: () => void;
	private _boundGameKeyDown!: (e: KeyboardEvent) => void;
	private _boundGameKeyUp!: (e: KeyboardEvent) => void;

	constructor(container: HTMLElement, options: RendererOptions = {}) {
		this.container = container;
		this.lanes = new Map();
		this.laneIdCounter = 0;
		this.intensity = options.intensity ?? 1.0;
		this.hue = options.hue ?? 220;
		this.isDark = options.isDark ?? false;
		this.isRTL = options.isRTL ?? false;
		this.effect = options.effect ?? 'none';
		this.texture = options.texture ?? 'solid';
		this.rainbow = options.rainbow ?? false;

		this.rotationX = 0;
		this.rotationY = 0;
		this.velocityX = 0;
		this.velocityY = 0;
		this.isDragging = false;
		this.lastMouseX = 0;
		this.lastMouseY = 0;
		this.lastDragTime = 0;
		this._dragButton = 0;
		this._orbitRadius = 800;
		this._orbitTarget = new Vector3(0, 0, 0);
		this._gameKeysHeld = new Set();
		this._gameSpeed = 400;

		this.animationId = null;
		this.disposed = false;
		this.font = null;
		this.contextLost = false;
		this.gameMode = false;
		this.mouseFollow = false;

		this.fps = 0;
		this.paused = false;
		this.onPauseToggle = null;
		this.flyMode = false;
		this.invaderMode = false;
		this.fallingText = false;
		this.noFog = false;
		this._fly = null;
		this._game = null;
		this._lastFrameTime = performance.now();
		this._fpsFrameCount = 0;
		this._fpsLastTime = performance.now();
		this._pauseStartTime = 0;
		this._debugOverrides = { speedMultiplier: 1, extrudeMultiplier: 0.1 };
		this._axesGroup = null;
		this._debugLightGroup = null;
		this._debugSpot = null;
		this.onScoreChange = null;
		this.onInvaderStatsChange = null;
		this.onInvaderExit = null;

		this._init();
		this._loadFont();
		if (this.isRTL) {
			loadCanvasFont();
			loadArabicFont();
		}
	}

	async _loadFont(): Promise<void> {
		if (loadedFont) {
			this.font = loadedFont;
			console.debug('3D font: using cached');
			return;
		}

		if (!fontLoadPromise) {
			fontLoadPromise = new Promise<Font>((resolve, reject) => {
				const loader = new FontLoader();
				loader.load(
					FONT_TYPEFACE_URL,
					(font: Font) => {
						console.debug('3D font: loaded');
						loadedFont = font;
						resolve(font);
					},
					undefined,
					(err: unknown) => {
						console.debug('3D font: load failed', err);
						reject(err);
					}
				);
			});
		}

		try {
			this.font = await fontLoadPromise;
		} catch (e) {
			console.debug('3D font: fallback to flat text', e);
		}
	}

	_init(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;

		this.scene = new Scene();

		this._updateFog();

		this._ambientLight = new AmbientLight(0xffffff, 0.6);
		this.scene.add(this._ambientLight);

		const directionalLight = new DirectionalLight(0xffffff, 0.8);
		directionalLight.position.set(1, 1, 1);
		this.scene.add(directionalLight);

		const backLight = new DirectionalLight(0xffffff, 0.3);
		backLight.position.set(-1, -1, -1);
		this.scene.add(backLight);

		this.camera = new PerspectiveCamera(60, width / height, 1, 50000);
		this.camera.position.z = 800;

		this.renderer = new WebGLRenderer({
			antialias: true,
			alpha: true,
			powerPreference: 'high-performance'
		});
		this.renderer.setSize(width, height);
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.setClearColor(0x000000, 0);

		this.container.appendChild(this.renderer.domElement);
		this.renderer.domElement.style.position = 'fixed';
		this.renderer.domElement.style.inset = '0';
		this.renderer.domElement.style.zIndex = '-1';
		this.renderer.domElement.style.pointerEvents = 'none';

		this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
			console.debug('WebGL: context lost');
			e.preventDefault();
			this.contextLost = true;
		});
		this.renderer.domElement.addEventListener('webglcontextrestored', () => {
			console.debug('WebGL: context restored');
			this.contextLost = false;
		});

		this._boundResize = this._onResize.bind(this);
		this._boundMouseDown = this._onMouseDown.bind(this);
		this._boundMouseUp = this._onMouseUp.bind(this);
		this._boundMouseMove = this._onMouseMove.bind(this);
		this._boundWheel = this._onWheel.bind(this);
		this._boundFlyKeyDown = this._onFlyKeyDown.bind(this);
		this._boundFlyKeyUp = this._onFlyKeyUp.bind(this);
		this._boundFlyBlur = () => { if (this._fly) this._fly.keysHeld.clear(); };
		this._boundGameKeyDown = this._onGameKeyDown.bind(this);
		this._boundGameKeyUp = this._onGameKeyUp.bind(this);

		window.addEventListener('resize', this._boundResize);
		window.addEventListener('mousedown', this._boundMouseDown);
		window.addEventListener('mouseup', this._boundMouseUp);
		window.addEventListener('mousemove', this._boundMouseMove);
		window.addEventListener('wheel', this._boundWheel, { passive: false });

		this._animate();
	}

	_onResize(): void {
		const width = window.innerWidth;
		const height = window.innerHeight;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
		this._updateFog();
	}

	_onMouseDown(e: MouseEvent): void {
		if (e.button === 2) return;

		const target = e.target as HTMLElement;
		const isInteractive = target.closest('button, input, select, textarea, a, label, .settings-panel, .metrics-bar, .text-display, .input-area, .controls, .keyboard-container, .results-panel, .multiplayer-panel');
		if (isInteractive) return;

		e.preventDefault();
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}

		this._dragButton = e.button;
		this.isDragging = true;
		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = performance.now();
		if (e.button === 0) {
			this.velocityX = 0;
			this.velocityY = 0;
		}
		document.body.style.userSelect = 'none';
	}

	_onMouseUp(): void {
		if (this.isDragging) {
			document.body.style.userSelect = '';
		}
		this.isDragging = false;
		this._dragButton = 0;
	}

	_onMouseMove(e: MouseEvent): void {
		// In game mode with mouse follow, mouse controls camera direction without dragging
		if (this.gameMode && this.mouseFollow && !this.isDragging) {
			const deltaX = e.clientX - this.lastMouseX;
			const deltaY = e.clientY - this.lastMouseY;
			const sensitivity = 0.002;
			this.rotationY -= deltaX * sensitivity;
			this.rotationX -= deltaY * sensitivity;
			// Clamp to avoid flipping at poles
			this.rotationX = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.rotationX));
			this.lastMouseX = e.clientX;
			this.lastMouseY = e.clientY;
			return;
		}

		if (!this.isDragging) return;

		const now = performance.now();
		const dt = Math.max(1, now - this.lastDragTime);
		const deltaX = e.clientX - this.lastMouseX;
		const deltaY = e.clientY - this.lastMouseY;

		if (this._dragButton === 1 && this.flyMode && this._fly) {
			this._panCamera(deltaX, deltaY);
		} else if (this.flyMode && this._fly) {
			const sensitivity = 0.003;
			this._fly.yaw -= deltaX * sensitivity;
			this._fly.pitch -= deltaY * sensitivity;
			this._fly.lookVelocityX = (-deltaY * sensitivity) / dt;
			this._fly.lookVelocityY = (-deltaX * sensitivity) / dt;
		} else if (this._dragButton === 0) {
			this._panOrbitTarget(deltaX, deltaY);
		} else {
			const sensitivity = 0.003;
			this.rotationY -= deltaX * sensitivity;
			this.rotationX -= deltaY * sensitivity;
			// Clamp to avoid flipping at poles
			this.rotationX = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.rotationX));

			this.velocityX = (-deltaY * sensitivity) / dt;
			this.velocityY = (-deltaX * sensitivity) / dt;
		}

		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = now;
	}

	_onWheel(e: WheelEvent): void {
		if (this.flyMode && this._fly) {
			e.preventDefault();
			const factor = e.deltaY > 0 ? 0.85 : 1.18;
			this._fly.speed = Math.max(20, Math.min(10000, this._fly.speed * factor));
			return;
		}

		if (this.gameMode && e.ctrlKey) {
			e.preventDefault();
			const factor = e.deltaY > 0 ? 0.85 : 1.18;
			this._gameSpeed = Math.max(20, Math.min(10000, this._gameSpeed * factor));
			return;
		}

		if (!e.ctrlKey && !this.gameMode) return;

		e.preventDefault();

		const zoomSpeed = 100;
		const delta = e.deltaY > 0 ? zoomSpeed : -zoomSpeed;

		this._orbitRadius = Math.max(1, this._orbitRadius + delta);
	}

	_updateFog(): void {
		if (this.noFog) {
			this.scene.fog = null;
			return;
		}
		const fogL = this.isDark ? 10 : 97;
		const fogColor = new Color(`hsl(${this.hue}, 10%, ${fogL}%)`);

		const viewportSize = Math.max(window.innerWidth, window.innerHeight);
		const fogNear = viewportSize * 0.8;
		const fogFar = viewportSize * 1.2;

		this.scene.fog = new Fog(fogColor, fogNear, fogFar);
	}

	_createTextTexture(text: string, fontSize: number): { texture: CanvasTexture; width: number; height: number } {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d')!;

		const fontFamily = this.isRTL
			? "'Vazirmatn', 'Tahoma', system-ui, sans-serif"
			: "system-ui, -apple-system, sans-serif";
		const font = `${fontSize}px ${fontFamily}`;
		ctx.font = font;
		const metrics = ctx.measureText(text);

		const padding = 20;
		canvas.width = Math.ceil(metrics.width) + padding * 2;
		canvas.height = Math.ceil(fontSize * 1.5) + padding * 2;

		const centerX = canvas.width / 2;
		const centerY = canvas.height / 2;
		const lightness = this.isDark ? 70 : 35;
		const baseColor = `hsl(${this.hue}, 15%, ${lightness}%)`;

		ctx.font = font;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = baseColor;
		ctx.fillText(text, centerX, centerY);

		const texture = new CanvasTexture(canvas);
		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;

		return { texture, width: canvas.width, height: canvas.height };
	}

	_getTextureColor(baseL: number, baseSat: number): { l: number; s: number } {
		switch (this.texture) {
			case 'gradient':
				return { l: baseL, s: baseSat + 15 };
			case 'metallic':
				return { l: this.isDark ? baseL + 10 : baseL - 5, s: baseSat + 25 };
			case 'glass':
				return { l: baseL, s: Math.max(5, baseSat - 10) };
			default:
				return { l: baseL, s: baseSat };
		}
	}

	_getTextureOpacity(baseOpacity: number): number {
		switch (this.texture) {
			case 'solid':
				return Math.min(1, baseOpacity * 3);
			case 'glass':
				return baseOpacity * 0.8;
			case 'metallic':
				return Math.min(1, baseOpacity * 2.5);
			default:
				return baseOpacity;
		}
	}

	_createTroikaText(text: string, fontSize: number, opacity: number): Object3D {
		const baseL = this.isDark ? 70 : 35;
		const baseSat = 20;
		const { l, s } = this._getTextureColor(baseL, baseSat);
		const finalOpacity = this._getTextureOpacity(opacity);

		const needs3DDepth = ['extrude', 'shadow', 'emboss'].includes(this.effect);

		if (needs3DDepth) {
			return this._create3DDepthText(text, fontSize, finalOpacity, l, s);
		}

		if (this.rainbow) {
			if (this.isRTL) {
				return this._createRainbowTroikaTextRTL(text, fontSize, finalOpacity, l, s);
			}
			return this._createRainbowTroikaText(text, fontSize, finalOpacity, l, s);
		}

		const textMesh = new Text();
		textMesh.text = text;
		textMesh.fontSize = fontSize;
		textMesh.font = this.isRTL ? FONT_VAZIRMATN : FONT_SYSTEM;
		textMesh.anchorX = 'center';
		textMesh.anchorY = 'middle';
		textMesh.direction = this.isRTL ? 'rtl' : 'ltr';

		switch (this.effect) {
			case 'outline':
				this._applyOutlineEffect(textMesh, fontSize, finalOpacity, l, s);
				break;
			case 'neon':
				this._applyNeonEffect(textMesh, fontSize, finalOpacity, l, s);
				break;
			default:
				textMesh.color = new Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
				textMesh.fillOpacity = finalOpacity;
		}

		textMesh.sync();
		return textMesh;
	}

	_createRainbowTroikaText(text: string, fontSize: number, finalOpacity: number, l: number, s: number): Group {
		const group = new Group();
		group.userData.isTroikaGroup = true;
		group.userData.textMeshes = [];

		const chars = [...text];
		const charWidth = fontSize * 0.6;
		const totalWidth = chars.length * charWidth;
		let xOffset = -totalWidth / 2;

		chars.forEach((char, i) => {
			if (char === ' ') {
				xOffset += charWidth * 0.5;
				return;
			}

			const hue = (i * 360 / Math.max(chars.length, 1)) % 360;

			const textMesh = new Text();
			textMesh.text = char;
			textMesh.fontSize = fontSize;
			textMesh.font = this.isRTL ? FONT_VAZIRMATN : FONT_SYSTEM;
			textMesh.anchorX = 'center';
			textMesh.anchorY = 'middle';
			textMesh.position.x = xOffset + charWidth / 2;

			switch (this.effect) {
				case 'outline':
					this._applyOutlineEffectWithHue(textMesh, fontSize, finalOpacity, l, s, hue);
					break;
				case 'neon':
					this._applyNeonEffectWithHue(textMesh, fontSize, finalOpacity, l, hue);
					break;
				default:
					textMesh.color = new Color(`hsl(${hue}, 70%, ${l}%)`);
					textMesh.fillOpacity = finalOpacity;
			}

			textMesh.sync();
			group.add(textMesh);
			group.userData.textMeshes.push(textMesh);

			xOffset += charWidth;
		});

		return group;
	}

	_createRainbowTroikaTextRTL(text: string, fontSize: number, finalOpacity: number, l: number, s: number): Text {
		const textMesh = new Text();
		textMesh.text = text;
		textMesh.fontSize = fontSize;
		textMesh.font = FONT_VAZIRMATN;
		textMesh.anchorX = 'center';
		textMesh.anchorY = 'middle';
		textMesh.direction = 'rtl';
		textMesh.fillOpacity = finalOpacity;

		const hue = Math.random() * 360;
		textMesh.color = new Color(`hsl(${hue}, 70%, ${l}%)`);

		switch (this.effect) {
			case 'outline': {
				const outlineL = this.isDark ? 30 : 70;
				textMesh.outlineWidth = fontSize * 0.06;
				textMesh.outlineColor = new Color(`hsl(${hue}, 60%, ${outlineL}%)`);
				textMesh.outlineOpacity = finalOpacity * 0.8;
				break;
			}
			case 'neon': {
				const glowL = this.isDark ? 60 : 50;
				const coreL = this.isDark ? 90 : 95;
				textMesh.color = new Color(`hsl(${hue}, 80%, ${coreL}%)`);
				textMesh.outlineWidth = fontSize * 0.2;
				textMesh.outlineColor = new Color(`hsl(${hue}, 100%, ${glowL}%)`);
				textMesh.outlineOpacity = finalOpacity * 0.4;
				textMesh.outlineBlur = fontSize * 0.15;
				textMesh.strokeWidth = fontSize * 0.04;
				textMesh.strokeColor = new Color(`hsl(${hue}, 90%, ${glowL + 10}%)`);
				textMesh.strokeOpacity = finalOpacity * 0.8;
				break;
			}
		}

		textMesh.sync();
		return textMesh;
	}

	_applyOutlineEffectWithHue(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, hue: number): void {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new Color(`hsl(${hue}, 70%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new Color(`hsl(${hue}, 60%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffectWithHue(textMesh: Text, fontSize: number, opacity: number, l: number, hue: number): void {
		const glowL = this.isDark ? 60 : 50;
		const coreL = this.isDark ? 90 : 95;
		textMesh.color = new Color(`hsl(${hue}, 80%, ${coreL}%)`);
		textMesh.fillOpacity = opacity * 1.2;
		textMesh.outlineWidth = fontSize * 0.2;
		textMesh.outlineColor = new Color(`hsl(${hue}, 100%, ${glowL}%)`);
		textMesh.outlineOpacity = opacity * 0.4;
		textMesh.outlineBlur = fontSize * 0.15;
		textMesh.strokeWidth = fontSize * 0.04;
		textMesh.strokeColor = new Color(`hsl(${hue}, 90%, ${glowL + 10}%)`);
		textMesh.strokeOpacity = opacity * 0.8;
	}

	_create3DDepthText(text: string, fontSize: number, opacity: number, l: number, s: number): Object3D {
		if (this.effect === 'extrude') {
			if (this.isRTL && arabicFont) {
				const mesh = this._createArabicExtrudedText(text, fontSize, opacity, l, s);
				if (mesh) return mesh;
			} else if (!this.isRTL && this.font) {
				return this._createExtrudedText(text, fontSize, opacity, l, s);
			}
		}

		const group = new Group();
		group.userData.isTroikaGroup = true;
		group.userData.textMeshes = [];

		const depthLayers = 10;
		const depthStep = fontSize * 0.25 * this._debugOverrides.extrudeMultiplier;

		for (let i = 0; i < depthLayers; i++) {
			const textMesh = new Text();
			textMesh.text = text;
			textMesh.fontSize = fontSize;
			textMesh.font = this.isRTL ? FONT_VAZIRMATN : FONT_SYSTEM;
			textMesh.anchorX = 'center';
			textMesh.anchorY = 'middle';
			textMesh.direction = this.isRTL ? 'rtl' : 'ltr';

			const zPos = -i * depthStep;
			textMesh.position.z = zPos;

			const layerProgress = i / (depthLayers - 1);

			switch (this.effect) {
				case 'extrude':
					this._styleExtrudeLayer(textMesh, fontSize, opacity, l, s, layerProgress, i === 0);
					break;
				case 'shadow':
					this._styleShadowLayer(textMesh, fontSize, opacity, l, s, layerProgress, i === 0);
					break;
				case 'emboss':
					this._styleEmbossLayer(textMesh, fontSize, opacity, l, s, layerProgress, i === 0);
					break;
			}

			textMesh.sync();
			group.add(textMesh);
			group.userData.textMeshes.push(textMesh);
		}

		return group;
	}

	_createExtrudedText(text: string, fontSize: number, opacity: number, l: number, s: number): Object3D {
		const depth = fontSize * 2 * this._debugOverrides.extrudeMultiplier;
		const finalOpacity = this.texture === 'solid' ? Math.min(1, opacity * 4) : opacity;
		const isTransparent = finalOpacity < 0.99;

		if (this.rainbow && !this.isRTL) {
			return this._createRainbowExtrudedText(text, fontSize, depth, finalOpacity, isTransparent, l, s);
		}

		const geometry = new TextGeometry(text, {
			font: this.font!,
			size: fontSize,
			depth: depth,
			curveSegments: 6,
			bevelEnabled: true,
			bevelThickness: fontSize * 0.05,
			bevelSize: fontSize * 0.04,
			bevelSegments: 3
		});

		geometry.computeBoundingBox();
		geometry.center();

		const frontColor = new Color(`hsl(${this.hue}, ${s + 10}%, ${l}%)`);
		const sideL = this.isDark ? Math.max(10, l - 25) : Math.min(90, l + 20);
		const sideColor = new Color(`hsl(${this.hue}, ${s}%, ${sideL}%)`);

		const materials = [
			new MeshStandardMaterial({
				color: frontColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.2 : 0.7
			}),
			new MeshStandardMaterial({
				color: sideColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.3 : 0.8
			})
		];

		const mesh = new Mesh(geometry, materials);
		mesh.userData.isExtrudedText = true;
		mesh.userData.geometry = geometry;
		mesh.userData.materials = materials;

		return mesh;
	}

	_createArabicExtrudedText(text: string, fontSize: number, opacity: number, l: number, s: number): Mesh | null {
		const depth = fontSize * 2 * this._debugOverrides.extrudeMultiplier;
		const finalOpacity = this.texture === 'solid' ? Math.min(1, opacity * 4) : opacity;
		const isTransparent = finalOpacity < 0.99;

		const geometry = createArabicExtrudedText(arabicFont!, text, fontSize, depth, {
			bevelEnabled: true,
			bevelThickness: fontSize * 0.05,
			bevelSize: fontSize * 0.04,
			bevelSegments: 3,
			curveSegments: 6
		});

		if (!geometry) {
			return null;
		}

		const frontColor = new Color(`hsl(${this.hue}, ${s + 10}%, ${l}%)`);
		const sideL = this.isDark ? Math.max(10, l - 25) : Math.min(90, l + 20);
		const sideColor = new Color(`hsl(${this.hue}, ${s}%, ${sideL}%)`);

		let finalFrontColor = frontColor;
		let finalSideColor = sideColor;
		if (this.rainbow) {
			const hue = Math.random() * 360;
			finalFrontColor = new Color(`hsl(${hue}, 70%, ${l}%)`);
			const rainbowSideL = this.isDark ? Math.max(15, l - 20) : Math.min(90, l + 20);
			finalSideColor = new Color(`hsl(${hue}, 60%, ${rainbowSideL}%)`);
		}

		const materials = [
			new MeshStandardMaterial({
				color: finalFrontColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.2 : 0.7
			}),
			new MeshStandardMaterial({
				color: finalSideColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.3 : 0.8
			})
		];

		const mesh = new Mesh(geometry, materials);
		mesh.userData.isExtrudedText = true;
		mesh.userData.geometry = geometry;
		mesh.userData.materials = materials;

		return mesh;
	}

	_createRainbowExtrudedText(text: string, fontSize: number, depth: number, finalOpacity: number, isTransparent: boolean, l: number, s: number): Group {
		const group = new Group();
		group.userData.isExtrudedText = true;
		group.userData.geometries = [];
		group.userData.materials = [];

		const chars = [...text];
		let xOffset = 0;

		chars.forEach((char, i) => {
			if (char === ' ') {
				xOffset += fontSize * 0.3;
				return;
			}

			const charGeometry = new TextGeometry(char, {
				font: this.font!,
				size: fontSize,
				depth: depth,
				curveSegments: 4,
				bevelEnabled: true,
				bevelThickness: fontSize * 0.04,
				bevelSize: fontSize * 0.03,
				bevelSegments: 2
			});

			charGeometry.computeBoundingBox();
			const charWidth = charGeometry.boundingBox!.max.x - charGeometry.boundingBox!.min.x;

			const hue = (i * 360 / Math.max(chars.length, 1)) % 360;
			const frontColor = new Color(`hsl(${hue}, 70%, ${l}%)`);
			const sideL = this.isDark ? Math.max(15, l - 20) : Math.min(90, l + 20);
			const sideColor = new Color(`hsl(${hue}, 60%, ${sideL}%)`);

			const materials = [
				new MeshStandardMaterial({
					color: frontColor,
					transparent: isTransparent,
					opacity: finalOpacity,
					metalness: this.texture === 'metallic' ? 0.8 : 0.1,
					roughness: this.texture === 'metallic' ? 0.2 : 0.6
				}),
				new MeshStandardMaterial({
					color: sideColor,
					transparent: isTransparent,
					opacity: finalOpacity,
					metalness: this.texture === 'metallic' ? 0.8 : 0.1,
					roughness: this.texture === 'metallic' ? 0.3 : 0.7
				})
			];

			const charMesh = new Mesh(charGeometry, materials);
			charMesh.position.x = xOffset;

			group.add(charMesh);
			group.userData.geometries.push(charGeometry);
			group.userData.materials.push(...materials);

			xOffset += charWidth + fontSize * 0.05;
		});

		const totalWidth = xOffset;
		group.children.forEach(child => {
			child.position.x -= totalWidth / 2;
			child.position.y -= fontSize / 2;
			child.position.z -= depth / 2;
		});

		return group;
	}

	_styleExtrudeLayer(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, progress: number, isFront: boolean): void {
		const layerL = isFront ? l : Math.max(5, l - progress * 50);
		const layerSat = isFront ? s + 10 : Math.max(5, s - progress * 15);
		const layerOpacity = isFront ? opacity : opacity * (1.0 - progress * 0.4);

		textMesh.color = new Color(`hsl(${this.hue}, ${Math.max(5, layerSat)}%, ${layerL}%)`);
		textMesh.fillOpacity = layerOpacity;

		if (isFront) {
			textMesh.strokeWidth = fontSize * 0.02;
			textMesh.strokeColor = new Color(`hsl(${this.hue}, ${s}%, ${this.isDark ? 95 : 10}%)`);
			textMesh.strokeOpacity = opacity * 0.5;
		}
	}

	_styleShadowLayer(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, progress: number, isFront: boolean): void {
		if (isFront) {
			textMesh.color = new Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
		} else {
			const shadowL = this.isDark ? 8 : 15;
			textMesh.color = new Color(`hsl(${this.hue}, 5%, ${shadowL}%)`);
			textMesh.fillOpacity = opacity * (0.7 - progress * 0.5);
			textMesh.position.x = progress * fontSize * 0.3;
			textMesh.position.y = -progress * fontSize * 0.3;
		}
	}

	_styleEmbossLayer(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, progress: number, isFront: boolean): void {
		if (isFront) {
			textMesh.color = new Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
			textMesh.strokeWidth = fontSize * 0.025;
			textMesh.strokeColor = new Color(`hsl(${this.hue}, ${s - 10}%, ${this.isDark ? 90 : 98}%)`);
			textMesh.strokeOpacity = opacity * 0.6;
		} else {
			const backL = this.isDark ? Math.max(5, l - 30 - progress * 25) : Math.min(90, l + 20 + progress * 15);
			textMesh.color = new Color(`hsl(${this.hue}, ${Math.max(5, s - 10)}%, ${backL}%)`);
			textMesh.fillOpacity = opacity * (0.9 - progress * 0.5);
		}
	}

	_applyOutlineEffect(textMesh: Text, fontSize: number, opacity: number, l: number, s: number): void {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new Color(`hsl(${this.hue}, ${s - 5}%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffect(textMesh: Text, fontSize: number, opacity: number, l: number, s: number): void {
		const glowL = this.isDark ? 60 : 50;
		const coreL = this.isDark ? 90 : 95;
		textMesh.color = new Color(`hsl(${this.hue}, 80%, ${coreL}%)`);
		textMesh.fillOpacity = opacity * 1.2;
		textMesh.outlineWidth = fontSize * 0.2;
		textMesh.outlineColor = new Color(`hsl(${this.hue}, 100%, ${glowL}%)`);
		textMesh.outlineOpacity = opacity * 0.4;
		textMesh.outlineBlur = fontSize * 0.15;
		textMesh.strokeWidth = fontSize * 0.04;
		textMesh.strokeColor = new Color(`hsl(${this.hue}, 90%, ${glowL + 10}%)`);
		textMesh.strokeOpacity = opacity * 0.8;
	}

	async spawnLane(text: string, direction: 'ltr' | 'rtl', initialProgress = 0): Promise<number> {
		const savedEffect = this.effect;
		const savedTexture = this.texture;
		if (this.effect === 'random') this.effect = CONCRETE_EFFECTS[Math.floor(Math.random() * CONCRETE_EFFECTS.length)];
		if (this.texture === 'random') this.texture = CONCRETE_TEXTURES[Math.floor(Math.random() * CONCRETE_TEXTURES.length)];

		if (this.effect === 'extrude' && !this.font && fontLoadPromise) {
			try {
				this.font = await fontLoadPromise;
			} catch {
				// Font failed, will use fallback
			}
		}

		const useTroika = this.effect !== 'none' || this.texture !== 'solid';
		if (this.isRTL && !useTroika && canvasFontPromise) {
			await canvasFontPromise;
		}

		const intensity = this.intensity;

		const sizeRand = Math.random();
		const speedRand = Math.random();
		const opacityRand = Math.random();
		const depthRand = Math.random();

		const fontSize = 20 + Math.pow(sizeRand, 2) * 80 * intensity;
		const opacityMultiplier = this.isDark ? 1 : 2.5;
		const opacity = (0.03 + Math.pow(opacityRand, 2) * 0.2) * intensity * opacityMultiplier;

		let mesh: Object3D;
		let texture: CanvasTexture | null = null;
		let estimatedWidth: number;

		if (useTroika) {
			mesh = this._createTroikaText(text, fontSize, opacity);
			estimatedWidth = text.length * fontSize * 0.6;
		} else {
			const result = this._createTextTexture(text, fontSize);
			texture = result.texture;

			const geometry = new PlaneGeometry(result.width, result.height);
			const material = new MeshStandardMaterial({
				map: texture,
				transparent: true,
				opacity: opacity,
				depthWrite: false,
				side: DoubleSide,
				roughness: 0.9,
				metalness: 0
			});

			mesh = new Mesh(geometry, material);
			estimatedWidth = result.width;
		}

		const z = -100 - depthRand * 600 * intensity;

		const distanceFromCamera = this._orbitRadius - z;
		const referenceDistance = this._orbitRadius + 100;
		const perspectiveScale = distanceFromCamera / referenceDistance;

		const viewportSize = Math.max(window.innerWidth, window.innerHeight);

		let startX: number, endX: number, startY: number, endY: number;

		if (this.fallingText) {
			// Top-to-bottom: Y moves, X is random and fixed
			const halfW = window.innerWidth * 0.5 * perspectiveScale;
			const x = (Math.random() - 0.5) * halfW * 2;
			startX = x;
			endX = x;

			const baseSpawnY = viewportSize * 0.8 + fontSize * 1.4;
			const spawnY = baseSpawnY * perspectiveScale;
			startY = spawnY;
			endY = -spawnY;
		} else {
			// Horizontal: X moves, Y is random and fixed
			const y = (Math.random() - 0.5) * 800;
			startY = y;
			endY = y;

			const baseSpawnOffset = viewportSize * 1.3 + estimatedWidth;
			const baseDeleteOffset = viewportSize * 1.3 + estimatedWidth;
			const spawnOffset = baseSpawnOffset * perspectiveScale;
			const deleteOffset = baseDeleteOffset * perspectiveScale;
			startX = direction === 'rtl' ? -spawnOffset : spawnOffset;
			endX = direction === 'rtl' ? deleteOffset : -deleteOffset;
		}

		const totalDistanceX = Math.abs(endX - startX);
		const totalDistanceY = Math.abs(endY - startY);
		const totalDistance = Math.max(totalDistanceX, totalDistanceY);
		const baseSpeed = (250 + Math.pow(speedRand, 2) * 400) * intensity * this._debugOverrides.speedMultiplier;
		const sizeFactor = 1 / (1 + fontSize / 150);
		const duration = totalDistance / (baseSpeed * sizeFactor);

		const initialX = startX + (endX - startX) * initialProgress;
		const initialY = startY + (endY - startY) * initialProgress;
		mesh.position.set(initialX, initialY, z);

		const now = performance.now();
		const adjustedStartTime = now - (initialProgress * duration * 1000);

		const id = this.laneIdCounter++;
		this.lanes.set(id, {
			mesh,
			startX,
			endX,
			startY,
			endY,
			startTime: adjustedStartTime,
			duration: duration * 1000,
			texture,
			isTroika: useTroika,
			width: estimatedWidth,
			height: fontSize * 1.4
		});

		this.scene.add(mesh);

		if (this._debugLightGroup) {
			mesh.castShadow = true;
			mesh.traverse(child => { child.castShadow = true; });
		}

		this.effect = savedEffect;
		this.texture = savedTexture;
		return id;
	}

	removeLane(id: number): void {
		const lane = this.lanes.get(id);
		if (lane) {
			this.scene.remove(lane.mesh);
			this._disposeMesh(lane.mesh);
			if (lane.texture) {
				lane.texture.dispose();
			}
			this.lanes.delete(id);
		}
	}

	_disposeMesh(mesh: Object3D): void {
		if (mesh.children?.length) {
			for (const child of [...mesh.children]) {
				this._disposeMesh(child);
			}
		}

		const m = mesh as Mesh;
		if (m.geometry) {
			m.geometry.dispose();
		}

		if (m.material) {
			if (Array.isArray(m.material)) {
				for (const mat of m.material) {
					mat.dispose();
				}
			} else {
				m.material.dispose();
			}
		}

		if (typeof (mesh as { dispose?: () => void }).dispose === 'function') {
			(mesh as { dispose: () => void }).dispose();
		}
	}

	updateSettings(options: RendererOptions): void {
		const themeChanged =
			(options.hue !== undefined && options.hue !== this.hue) ||
			(options.isDark !== undefined && options.isDark !== this.isDark);

		if (options.intensity !== undefined) this.intensity = options.intensity;
		if (options.hue !== undefined) this.hue = options.hue;
		if (options.isDark !== undefined) this.isDark = options.isDark;
		if (options.isRTL !== undefined) {
			this.isRTL = options.isRTL;
			if (options.isRTL) {
				loadCanvasFont();
				loadArabicFont();
			}
		}
		if (options.effect !== undefined) this.effect = options.effect;
		if (options.texture !== undefined) this.texture = options.texture;
		if (options.rainbow !== undefined) this.rainbow = options.rainbow;

		if (themeChanged) {
			this._updateFog();
		}
	}

	getLaneCount(): number {
		return this.lanes.size;
	}

	setGameMode(enabled: boolean): void {
		if (enabled && !this.gameMode) {
			this._gameKeysHeld.clear();
			window.addEventListener('keydown', this._boundGameKeyDown, { capture: true });
			window.addEventListener('keyup', this._boundGameKeyUp, { capture: true });
		} else if (!enabled && this.gameMode) {
			window.removeEventListener('keydown', this._boundGameKeyDown, { capture: true });
			window.removeEventListener('keyup', this._boundGameKeyUp, { capture: true });
			this._gameKeysHeld.clear();
			this._orbitTarget.set(0, 0, 0);
			this._gameSpeed = 400;
		}
		this.gameMode = enabled;
	}

	setFlyMode(enabled: boolean): void {
		if (enabled && !this.flyMode) {
			this._fly = {
				yaw: 0,
				pitch: 0,
				roll: 0,
				keysHeld: new Set(),
				speed: 400,
				lookVelocityX: 0,
				lookVelocityY: 0,
				savedOrbit: {
					orbitRadius: this._orbitRadius,
					rotationX: this.rotationX,
					rotationY: this.rotationY,
					velocityX: this.velocityX,
					velocityY: this.velocityY
				}
			};
			this.camera.rotation.order = 'YXZ';
			this.isDragging = false;
			document.body.style.userSelect = '';
			window.addEventListener('keydown', this._boundFlyKeyDown, { capture: true });
			window.addEventListener('keyup', this._boundFlyKeyUp, { capture: true });
			window.addEventListener('blur', this._boundFlyBlur);
			this.flyMode = true;
		} else if (!enabled && this.flyMode && this._fly) {
			window.removeEventListener('keydown', this._boundFlyKeyDown, { capture: true });
			window.removeEventListener('keyup', this._boundFlyKeyUp, { capture: true });
			window.removeEventListener('blur', this._boundFlyBlur);
			const saved = this._fly.savedOrbit;
			this._orbitRadius = saved.orbitRadius;
			this.camera.rotation.set(0, 0, 0);
			this.camera.rotation.order = 'XYZ';
			this.rotationX = saved.rotationX;
			this.rotationY = saved.rotationY;
			this.velocityX = saved.velocityX;
			this.velocityY = saved.velocityY;
			this.isDragging = false;
			document.body.style.userSelect = '';
			this._fly = null;
			this.flyMode = false;
		}
	}

	setInvaderHitEffect(effect: HitEffectType): void {
		if (this._game) {
			this._game.hitEffect = effect;
		}
	}

	setFallingText(enabled: boolean): void {
		this.fallingText = enabled;
	}

	setLights(enabled: boolean, intensity: number): void {
		if (enabled && !this._debugLightGroup) {
			this.renderer.shadowMap.enabled = true;
			this.renderer.shadowMap.type = PCFSoftShadowMap;
			this._ambientLight.intensity = 0.15;

			this._debugLightGroup = new Group();

			const spot = new SpotLight(0xffffff, intensity * 20);
			spot.position.set(600, 900, 800);
			spot.angle = Math.PI / 4;
			spot.penumbra = 0.3;
			spot.decay = 0.2;
			spot.castShadow = true;
			spot.shadow.mapSize.width = 2048;
			spot.shadow.mapSize.height = 2048;
			spot.shadow.camera.near = 100;
			spot.shadow.camera.far = 4000;
			spot.target.position.set(0, 0, 0);
			this._debugSpot = spot;

			this._debugLightGroup.add(spot);
			this._debugLightGroup.add(spot.target);

			const bulbGeo = new SphereGeometry(12, 8, 8);
			const bulbMat = new MeshBasicMaterial({ color: 0xffffcc });
			const bulb = new Mesh(bulbGeo, bulbMat);
			bulb.position.copy(spot.position);
			this._debugLightGroup.add(bulb);

			const groundGeo = new PlaneGeometry(500000, 500000);
			const groundMat = new MeshStandardMaterial({
				color: 0x888888,
				transparent: true,
				opacity: 0.12,
				roughness: 0.9
			});
			const ground = new Mesh(groundGeo, groundMat);
			ground.rotation.x = -Math.PI / 2;
			ground.position.y = -500;
			ground.receiveShadow = true;
			this._debugLightGroup.add(ground);

			this.scene.add(this._debugLightGroup);
			this._setLaneShadows(true);

		} else if (!enabled && this._debugLightGroup) {
			this.scene.remove(this._debugLightGroup);
			this._disposeMesh(this._debugLightGroup);
			this._debugLightGroup = null;
			this._debugSpot = null;
			this._ambientLight.intensity = 0.6;
			this.renderer.shadowMap.enabled = false;
			this._setLaneShadows(false);

		} else if (enabled && this._debugSpot) {
			this._debugSpot.intensity = intensity * 20;
		}
	}

	private _setLaneShadows(cast: boolean): void {
		for (const lane of this.lanes.values()) {
			lane.mesh.castShadow = cast;
			lane.mesh.traverse(child => { child.castShadow = cast; });
		}
	}

	setNoFog(enabled: boolean): void {
		this.noFog = enabled;
		this._updateFog();
	}

	resetInvaderGame(): void {
		if (this._game) {
			this._game.reset();
			this.clearAllLanes();
		}
	}

	setInvaderMode(enabled: boolean): void {
		if (enabled && !this.invaderMode) {
			if (this.flyMode) this.setFlyMode(false);
			this._game = new ScriptInvaderGame(this.scene, this.camera, this.isDark);
			this._game.setRemoveLane(this.removeLane.bind(this));
			this._game.setOnExit(() => {
				if (this.onInvaderExit) this.onInvaderExit();
			});
			this.invaderMode = true;
		} else if (!enabled && this.invaderMode) {
			if (this._game) {
				this._game.dispose();
				this._game = null;
			}
			this.invaderMode = false;
		}
	}

	_onFlyKeyDown(e: KeyboardEvent): void {
		if (!this._fly || !FLY_KEYS.has(e.code)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.code === 'KeyR') {
			this._resetFlyView();
			return;
		}
		if (e.code === 'Space') {
			this.setPaused(!this.paused);
			if (this.onPauseToggle) this.onPauseToggle(this.paused);
			return;
		}
		this._fly.keysHeld.add(e.code);
	}

	_onFlyKeyUp(e: KeyboardEvent): void {
		if (!this._fly || !FLY_KEYS.has(e.code)) return;
		e.preventDefault();
		e.stopPropagation();
		this._fly.keysHeld.delete(e.code);
	}

	_onGameKeyDown(e: KeyboardEvent): void {
		if (!GAME_KEYS.has(e.code)) return;
		// When invader mode is active, let its handler own Space
		if (e.code === 'Space' && this.invaderMode) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.code === 'KeyR') {
			this._resetGameView();
			return;
		}
		if (e.code === 'Space') {
			this.setPaused(!this.paused);
			if (this.onPauseToggle) this.onPauseToggle(this.paused);
			return;
		}
		this._gameKeysHeld.add(e.code);
	}

	_onGameKeyUp(e: KeyboardEvent): void {
		if (!GAME_KEYS.has(e.code)) return;
		if (e.code === 'Space' && this.invaderMode) return;
		e.preventDefault();
		e.stopPropagation();
		this._gameKeysHeld.delete(e.code);
	}

	_updateFlyMovement(dt: number): void {
		const fly = this._fly!;
		const move = new Vector3(0, 0, 0);

		if (fly.keysHeld.has('KeyW')) move.z -= 1;
		if (fly.keysHeld.has('KeyS')) move.z += 1;
		if (fly.keysHeld.has('KeyA')) move.x -= 1;
		if (fly.keysHeld.has('KeyD')) move.x += 1;
		if (fly.keysHeld.has('ShiftLeft') || fly.keysHeld.has('ShiftRight')) move.y -= 1;

		if (move.lengthSq() > 0) {
			move.normalize();
			move.multiplyScalar(fly.speed * dt);
			move.applyQuaternion(this.camera.quaternion);
			this.camera.position.add(move);
		}

		if (fly.keysHeld.has('KeyQ')) fly.roll -= 1.5 * dt;
		if (fly.keysHeld.has('KeyE')) fly.roll += 1.5 * dt;
	}

	_updateFlyLook(dt: number): void {
		const fly = this._fly!;
		const friction = 0.92;

		fly.yaw += fly.lookVelocityY * dt * 1000;
		fly.pitch += fly.lookVelocityX * dt * 1000;

		fly.lookVelocityX *= friction;
		fly.lookVelocityY *= friction;
		if (Math.abs(fly.lookVelocityX) < 0.00001) fly.lookVelocityX = 0;
		if (Math.abs(fly.lookVelocityY) < 0.00001) fly.lookVelocityY = 0;

		fly.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, fly.pitch));
		this.camera.rotation.set(fly.pitch, fly.yaw, fly.roll, 'YXZ');
	}

	_panCamera(deltaX: number, deltaY: number): void {
		const panScale = this._fly ? this._fly.speed * 0.001 : Math.max(0.5, Math.abs(this.camera.position.z) * 0.0005);
		const right = new Vector3();
		const up = new Vector3();
		this.camera.updateMatrixWorld();
		right.setFromMatrixColumn(this.camera.matrixWorld, 0);
		up.setFromMatrixColumn(this.camera.matrixWorld, 1);
		this.camera.position.addScaledVector(right, -deltaX * panScale);
		this.camera.position.addScaledVector(up, deltaY * panScale);
	}

	_panOrbitTarget(deltaX: number, deltaY: number): void {
		const panScale = this._orbitRadius * 0.003;
		const right = new Vector3();
		const up = new Vector3();
		this.camera.updateMatrixWorld();
		right.setFromMatrixColumn(this.camera.matrixWorld, 0);
		up.setFromMatrixColumn(this.camera.matrixWorld, 1);
		this._orbitTarget.addScaledVector(right, -deltaX * panScale);
		this._orbitTarget.addScaledVector(up, deltaY * panScale);
	}

	_resetFlyView(): void {
		if (!this._fly) return;
		const saved = this._fly.savedOrbit;
		this.camera.position.set(0, 0, saved.orbitRadius);
		this._fly.yaw = 0;
		this._fly.pitch = 0;
		this._fly.roll = 0;
		this._fly.lookVelocityX = 0;
		this._fly.lookVelocityY = 0;
		this._fly.speed = 400;
		this.camera.rotation.set(0, 0, 0, 'YXZ');
	}

	_resetGameView(): void {
		this._orbitTarget.set(0, 0, 0);
		this._orbitRadius = 800;
		this.rotationX = 0;
		this.rotationY = 0;
		this.velocityX = 0;
		this.velocityY = 0;
		this._gameSpeed = 400;
	}

	showAxes(visible: boolean): void {
		if (visible && !this._axesGroup) {
			this._axesGroup = new Group();

			const axes = new AxesHelper(1500);
			this._axesGroup.add(axes);

			const grid = new GridHelper(6000, 30, 0x666666, 0x333333);
			const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
			for (const m of mats) {
				(m as LineBasicMaterial).opacity = 0.35;
				(m as LineBasicMaterial).transparent = true;
			}
			this._axesGroup.add(grid);

			this.scene.add(this._axesGroup);
		} else if (!visible && this._axesGroup) {
			this.scene.remove(this._axesGroup);
			this._disposeMesh(this._axesGroup);
			this._axesGroup = null;
		}
	}

	setPaused(paused: boolean): void {
		if (paused && !this.paused) {
			this._pauseStartTime = performance.now();
		} else if (!paused && this.paused) {
			const pausedDuration = performance.now() - this._pauseStartTime;
			for (const lane of this.lanes.values()) {
				lane.startTime += pausedDuration;
			}
		}
		this.paused = paused;
	}

	setDebugOverrides(overrides: Partial<DebugOverrides>): void {
		if (overrides.speedMultiplier !== undefined) this._debugOverrides.speedMultiplier = overrides.speedMultiplier;
		if (overrides.extrudeMultiplier !== undefined) this._debugOverrides.extrudeMultiplier = overrides.extrudeMultiplier;
	}

	getDebugStats(): DebugStats {
		let rendererInfo = '';
		try {
			const gl = this.renderer.getContext();
			const ext = gl.getExtension('WEBGL_debug_renderer_info');
			if (ext) {
				rendererInfo = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
			}
		} catch {
			// Extension not available
		}
		const stats: DebugStats = {
			fps: this.fps,
			laneCount: this.lanes.size,
			rendererInfo
		};
		if (this.flyMode && this._fly) {
			stats.flySpeed = Math.round(this._fly.speed);
			const p = this.camera.position;
			stats.cameraPos = `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
		} else if (this.gameMode) {
			stats.flySpeed = Math.round(this._gameSpeed);
			const p = this.camera.position;
			stats.cameraPos = `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
		}
		if (this.invaderMode && this._game) {
			stats.invaderScore = this._game.score;
			stats.invaderLives = this._game.lives;
			stats.invaderHighScore = this._game.highScore;
			stats.invaderGameOver = this._game.gameOver;
		}
		return stats;
	}

	_animate(): void {
		if (this.disposed) return;

		this.animationId = requestAnimationFrame(() => this._animate());

		if (this.contextLost) return;

		const now = performance.now();
		const flyDt = Math.min((now - this._lastFrameTime) / 1000, 0.1);
		this._lastFrameTime = now;

		this._fpsFrameCount++;
		if (now - this._fpsLastTime >= 1000) {
			this.fps = this._fpsFrameCount;
			this._fpsFrameCount = 0;
			this._fpsLastTime = now;
		}

		if (this.flyMode && this._fly) {
			this._updateFlyMovement(flyDt);
			if (!this.isDragging) {
				this._updateFlyLook(flyDt);
			}
		} else {
			if (!this.isDragging) {
				const dt = 16;
				const friction = 0.92;

				this.rotationX += this.velocityX * dt;
				this.rotationY += this.velocityY * dt;
				// Clamp to avoid flipping at poles
				this.rotationX = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.rotationX));

				this.velocityX *= friction;
				this.velocityY *= friction;

				if (Math.abs(this.velocityX) < 0.00001) this.velocityX = 0;
				if (Math.abs(this.velocityY) < 0.00001) this.velocityY = 0;
			}

			// WASD movement in game mode: shift the orbit target
			if (this.gameMode && this._gameKeysHeld.size > 0) {
				const move = new Vector3(0, 0, 0);
				const speed = this._gameSpeed * flyDt;
				if (this._gameKeysHeld.has('KeyW')) move.z -= 1;
				if (this._gameKeysHeld.has('KeyS')) move.z += 1;
				if (this._gameKeysHeld.has('KeyA')) move.x -= 1;
				if (this._gameKeysHeld.has('KeyD')) move.x += 1;
				if (this._gameKeysHeld.has('ShiftLeft') || this._gameKeysHeld.has('ShiftRight')) move.y -= 1;
				if (move.lengthSq() > 0) {
					move.normalize().multiplyScalar(speed);
					move.applyQuaternion(this.camera.quaternion);
					this._orbitTarget.add(move);
				}
			}

			// Orbit camera: position camera on a sphere around the target
			const phi = Math.PI / 2 - this.rotationX;
			const theta = this.rotationY;
			this.camera.position.x = this._orbitTarget.x + this._orbitRadius * Math.sin(phi) * Math.sin(theta);
			this.camera.position.y = this._orbitTarget.y + this._orbitRadius * Math.cos(phi);
			this.camera.position.z = this._orbitTarget.z + this._orbitRadius * Math.sin(phi) * Math.cos(theta);
			this.camera.lookAt(this._orbitTarget);
		}

		if (this.invaderMode && this._game && !this.paused) {
			this._game.update(flyDt, this.lanes);
			if (this.onScoreChange) {
				this.onScoreChange(this._game.score);
			}
			if (this.onInvaderStatsChange) {
				this.onInvaderStatsChange(this._game.getStats());
			}
		}

		if (!this.paused) {
			const toRemove: number[] = [];

			for (const [id, lane] of this.lanes) {
				const elapsed = now - lane.startTime;
				const progress = elapsed / lane.duration;

				if (progress >= 1) {
					toRemove.push(id);
				} else {
					lane.mesh.position.x = lane.startX + (lane.endX - lane.startX) * progress;
					lane.mesh.position.y = lane.startY + (lane.endY - lane.startY) * progress;
				}
			}

			for (const id of toRemove) {
				this.removeLane(id);
			}
		}

		this.renderer.render(this.scene, this.camera);
	}

	clearAllLanes(): void {
		const laneIds = [...this.lanes.keys()];
		for (const id of laneIds) {
			this.removeLane(id);
		}
	}

	dispose(): void {
		this.disposed = true;

		if (this.animationId) {
			cancelAnimationFrame(this.animationId);
			this.animationId = null;
		}

		if (this.flyMode) {
			window.removeEventListener('keydown', this._boundFlyKeyDown, { capture: true });
			window.removeEventListener('keyup', this._boundFlyKeyUp, { capture: true });
			window.removeEventListener('blur', this._boundFlyBlur);
		}

		if (this.gameMode) {
			window.removeEventListener('keydown', this._boundGameKeyDown, { capture: true });
			window.removeEventListener('keyup', this._boundGameKeyUp, { capture: true });
		}

		if (this.invaderMode && this._game) {
			this._game.dispose();
			this._game = null;
			this.invaderMode = false;
		}

		window.removeEventListener('resize', this._boundResize);
		window.removeEventListener('mousedown', this._boundMouseDown);
		window.removeEventListener('mouseup', this._boundMouseUp);
		window.removeEventListener('mousemove', this._boundMouseMove);
		window.removeEventListener('wheel', this._boundWheel);

		if (this._debugLightGroup) {
			this.setLights(false, 0);
		}
		this.showAxes(false);
		this.clearAllLanes();

		this.renderer.dispose();

		if (this.renderer.domElement?.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
	}
}
