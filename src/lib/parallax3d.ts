import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import type { Font } from 'three/addons/loaders/FontLoader.js';
import { loadFont as loadOpenTypeFont, createArabicExtrudedText } from './arabic-extrude.js';
import type { Font as OpenTypeFont } from 'opentype.js';

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

let webglSupported: boolean | null = null;

export function isWebGLAvailable(): boolean {
	if (webglSupported !== null) return webglSupported;

	try {
		const canvas = document.createElement('canvas');
		const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
		webglSupported = !!gl;
		if (gl) {
			const ext = gl.getExtension('WEBGL_lose_context');
			if (ext) ext.loseContext();
		}
	} catch {
		webglSupported = false;
	}
	return webglSupported!;
}

type EffectType = 'none' | 'outline' | 'shadow' | 'emboss' | 'extrude' | 'neon';
type TextureType = 'solid' | 'gradient' | 'metallic' | 'glass';

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
	mesh: THREE.Object3D;
	startX: number;
	endX: number;
	startTime: number;
	duration: number;
	texture: THREE.CanvasTexture | null;
	isTroika: boolean;
}

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

	animationId: number | null;
	disposed: boolean;
	font: Font | null;
	contextLost: boolean;

	scene!: THREE.Scene;
	camera!: THREE.PerspectiveCamera;
	renderer!: THREE.WebGLRenderer;

	private _boundResize!: () => void;
	private _boundMouseDown!: (e: MouseEvent) => void;
	private _boundMouseUp!: () => void;
	private _boundMouseMove!: (e: MouseEvent) => void;
	private _boundWheel!: (e: WheelEvent) => void;

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

		this.animationId = null;
		this.disposed = false;
		this.font = null;
		this.contextLost = false;

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

		this.scene = new THREE.Scene();

		this._updateFog();

		const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
		this.scene.add(ambientLight);

		const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
		directionalLight.position.set(1, 1, 1);
		this.scene.add(directionalLight);

		const backLight = new THREE.DirectionalLight(0xffffff, 0.3);
		backLight.position.set(-1, -1, -1);
		this.scene.add(backLight);

		this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 50000);
		this.camera.position.z = 800;

		this.renderer = new THREE.WebGLRenderer({
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
		const target = e.target as HTMLElement;
		const isInteractive = target.closest('button, input, select, textarea, a, label, .settings-panel, .metrics-bar, .text-display, .input-area, .controls, .keyboard-container, .results-panel, .multiplayer-panel');
		if (isInteractive) return;

		e.preventDefault();

		this.isDragging = true;
		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = performance.now();
		this.velocityX = 0;
		this.velocityY = 0;
		document.body.style.userSelect = 'none';
	}

	_onMouseUp(): void {
		if (this.isDragging) {
			document.body.style.userSelect = '';
		}
		this.isDragging = false;
	}

	_onMouseMove(e: MouseEvent): void {
		if (!this.isDragging) return;

		const now = performance.now();
		const dt = Math.max(1, now - this.lastDragTime);
		const deltaX = e.clientX - this.lastMouseX;
		const deltaY = e.clientY - this.lastMouseY;

		const sensitivity = 0.003;

		this.rotationY -= deltaX * sensitivity;
		this.rotationX -= deltaY * sensitivity;

		const maxRotation = 0.8;
		this.rotationX = Math.max(-maxRotation, Math.min(maxRotation, this.rotationX));
		this.rotationY = Math.max(-maxRotation, Math.min(maxRotation, this.rotationY));

		this.velocityX = (-deltaY * sensitivity) / dt;
		this.velocityY = (-deltaX * sensitivity) / dt;

		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = now;
	}

	_onWheel(e: WheelEvent): void {
		if (!e.ctrlKey) return;

		e.preventDefault();

		const zoomSpeed = 100;
		const delta = e.deltaY > 0 ? zoomSpeed : -zoomSpeed;

		this.camera.position.z = Math.max(50, Math.min(15000, this.camera.position.z + delta));
	}

	_updateFog(): void {
		const fogL = this.isDark ? 10 : 97;
		const fogColor = new THREE.Color(`hsl(${this.hue}, 10%, ${fogL}%)`);

		const viewportSize = Math.max(window.innerWidth, window.innerHeight);
		const fogNear = viewportSize * 0.8;
		const fogFar = viewportSize * 1.2;

		this.scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
	}

	_createTextTexture(text: string, fontSize: number): { texture: THREE.CanvasTexture; width: number; height: number } {
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

		const texture = new THREE.CanvasTexture(canvas);
		texture.minFilter = THREE.LinearFilter;
		texture.magFilter = THREE.LinearFilter;

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

	_createTroikaText(text: string, fontSize: number, opacity: number): THREE.Object3D {
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
				textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
				textMesh.fillOpacity = finalOpacity;
		}

		textMesh.sync();
		return textMesh;
	}

	_createRainbowTroikaText(text: string, fontSize: number, finalOpacity: number, l: number, s: number): THREE.Group {
		const group = new THREE.Group();
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
					textMesh.color = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
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
		textMesh.color = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);

		switch (this.effect) {
			case 'outline': {
				const outlineL = this.isDark ? 30 : 70;
				textMesh.outlineWidth = fontSize * 0.06;
				textMesh.outlineColor = new THREE.Color(`hsl(${hue}, 60%, ${outlineL}%)`);
				textMesh.outlineOpacity = finalOpacity * 0.8;
				break;
			}
			case 'neon': {
				const glowL = this.isDark ? 60 : 50;
				const coreL = this.isDark ? 90 : 95;
				textMesh.color = new THREE.Color(`hsl(${hue}, 80%, ${coreL}%)`);
				textMesh.outlineWidth = fontSize * 0.2;
				textMesh.outlineColor = new THREE.Color(`hsl(${hue}, 100%, ${glowL}%)`);
				textMesh.outlineOpacity = finalOpacity * 0.4;
				textMesh.outlineBlur = fontSize * 0.15;
				textMesh.strokeWidth = fontSize * 0.04;
				textMesh.strokeColor = new THREE.Color(`hsl(${hue}, 90%, ${glowL + 10}%)`);
				textMesh.strokeOpacity = finalOpacity * 0.8;
				break;
			}
		}

		textMesh.sync();
		return textMesh;
	}

	_applyOutlineEffectWithHue(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, hue: number): void {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new THREE.Color(`hsl(${hue}, 60%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffectWithHue(textMesh: Text, fontSize: number, opacity: number, l: number, hue: number): void {
		const glowL = this.isDark ? 60 : 50;
		const coreL = this.isDark ? 90 : 95;
		textMesh.color = new THREE.Color(`hsl(${hue}, 80%, ${coreL}%)`);
		textMesh.fillOpacity = opacity * 1.2;
		textMesh.outlineWidth = fontSize * 0.2;
		textMesh.outlineColor = new THREE.Color(`hsl(${hue}, 100%, ${glowL}%)`);
		textMesh.outlineOpacity = opacity * 0.4;
		textMesh.outlineBlur = fontSize * 0.15;
		textMesh.strokeWidth = fontSize * 0.04;
		textMesh.strokeColor = new THREE.Color(`hsl(${hue}, 90%, ${glowL + 10}%)`);
		textMesh.strokeOpacity = opacity * 0.8;
	}

	_create3DDepthText(text: string, fontSize: number, opacity: number, l: number, s: number): THREE.Object3D {
		if (this.effect === 'extrude') {
			if (this.isRTL && arabicFont) {
				const mesh = this._createArabicExtrudedText(text, fontSize, opacity, l, s);
				if (mesh) return mesh;
			} else if (!this.isRTL && this.font) {
				return this._createExtrudedText(text, fontSize, opacity, l, s);
			}
		}

		const group = new THREE.Group();
		group.userData.isTroikaGroup = true;
		group.userData.textMeshes = [];

		const depthLayers = 10;
		const depthStep = fontSize * 0.25;

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

	_createExtrudedText(text: string, fontSize: number, opacity: number, l: number, s: number): THREE.Object3D {
		const depth = fontSize * 2;
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

		const frontColor = new THREE.Color(`hsl(${this.hue}, ${s + 10}%, ${l}%)`);
		const sideL = this.isDark ? Math.max(10, l - 25) : Math.min(90, l + 20);
		const sideColor = new THREE.Color(`hsl(${this.hue}, ${s}%, ${sideL}%)`);

		const materials = [
			new THREE.MeshStandardMaterial({
				color: frontColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.2 : 0.7
			}),
			new THREE.MeshStandardMaterial({
				color: sideColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.3 : 0.8
			})
		];

		const mesh = new THREE.Mesh(geometry, materials);
		mesh.userData.isExtrudedText = true;
		mesh.userData.geometry = geometry;
		mesh.userData.materials = materials;

		return mesh;
	}

	_createArabicExtrudedText(text: string, fontSize: number, opacity: number, l: number, s: number): THREE.Mesh | null {
		const depth = fontSize * 2;
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

		const frontColor = new THREE.Color(`hsl(${this.hue}, ${s + 10}%, ${l}%)`);
		const sideL = this.isDark ? Math.max(10, l - 25) : Math.min(90, l + 20);
		const sideColor = new THREE.Color(`hsl(${this.hue}, ${s}%, ${sideL}%)`);

		let finalFrontColor = frontColor;
		let finalSideColor = sideColor;
		if (this.rainbow) {
			const hue = Math.random() * 360;
			finalFrontColor = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
			const rainbowSideL = this.isDark ? Math.max(15, l - 20) : Math.min(90, l + 20);
			finalSideColor = new THREE.Color(`hsl(${hue}, 60%, ${rainbowSideL}%)`);
		}

		const materials = [
			new THREE.MeshStandardMaterial({
				color: finalFrontColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.2 : 0.7
			}),
			new THREE.MeshStandardMaterial({
				color: finalSideColor,
				transparent: isTransparent,
				opacity: finalOpacity,
				metalness: this.texture === 'metallic' ? 0.8 : 0.1,
				roughness: this.texture === 'metallic' ? 0.3 : 0.8
			})
		];

		const mesh = new THREE.Mesh(geometry, materials);
		mesh.userData.isExtrudedText = true;
		mesh.userData.geometry = geometry;
		mesh.userData.materials = materials;

		return mesh;
	}

	_createRainbowExtrudedText(text: string, fontSize: number, depth: number, finalOpacity: number, isTransparent: boolean, l: number, s: number): THREE.Group {
		const group = new THREE.Group();
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
			const frontColor = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
			const sideL = this.isDark ? Math.max(15, l - 20) : Math.min(90, l + 20);
			const sideColor = new THREE.Color(`hsl(${hue}, 60%, ${sideL}%)`);

			const materials = [
				new THREE.MeshStandardMaterial({
					color: frontColor,
					transparent: isTransparent,
					opacity: finalOpacity,
					metalness: this.texture === 'metallic' ? 0.8 : 0.1,
					roughness: this.texture === 'metallic' ? 0.2 : 0.6
				}),
				new THREE.MeshStandardMaterial({
					color: sideColor,
					transparent: isTransparent,
					opacity: finalOpacity,
					metalness: this.texture === 'metallic' ? 0.8 : 0.1,
					roughness: this.texture === 'metallic' ? 0.3 : 0.7
				})
			];

			const charMesh = new THREE.Mesh(charGeometry, materials);
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

		textMesh.color = new THREE.Color(`hsl(${this.hue}, ${Math.max(5, layerSat)}%, ${layerL}%)`);
		textMesh.fillOpacity = layerOpacity;

		if (isFront) {
			textMesh.strokeWidth = fontSize * 0.02;
			textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, ${s}%, ${this.isDark ? 95 : 10}%)`);
			textMesh.strokeOpacity = opacity * 0.5;
		}
	}

	_styleShadowLayer(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, progress: number, isFront: boolean): void {
		if (isFront) {
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
		} else {
			const shadowL = this.isDark ? 8 : 15;
			textMesh.color = new THREE.Color(`hsl(${this.hue}, 5%, ${shadowL}%)`);
			textMesh.fillOpacity = opacity * (0.7 - progress * 0.5);
			textMesh.position.x = progress * fontSize * 0.3;
			textMesh.position.y = -progress * fontSize * 0.3;
		}
	}

	_styleEmbossLayer(textMesh: Text, fontSize: number, opacity: number, l: number, s: number, progress: number, isFront: boolean): void {
		if (isFront) {
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
			textMesh.strokeWidth = fontSize * 0.025;
			textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, ${s - 10}%, ${this.isDark ? 90 : 98}%)`);
			textMesh.strokeOpacity = opacity * 0.6;
		} else {
			const backL = this.isDark ? Math.max(5, l - 30 - progress * 25) : Math.min(90, l + 20 + progress * 15);
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${Math.max(5, s - 10)}%, ${backL}%)`);
			textMesh.fillOpacity = opacity * (0.9 - progress * 0.5);
		}
	}

	_applyOutlineEffect(textMesh: Text, fontSize: number, opacity: number, l: number, s: number): void {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new THREE.Color(`hsl(${this.hue}, ${s - 5}%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffect(textMesh: Text, fontSize: number, opacity: number, l: number, s: number): void {
		const glowL = this.isDark ? 60 : 50;
		const coreL = this.isDark ? 90 : 95;
		textMesh.color = new THREE.Color(`hsl(${this.hue}, 80%, ${coreL}%)`);
		textMesh.fillOpacity = opacity * 1.2;
		textMesh.outlineWidth = fontSize * 0.2;
		textMesh.outlineColor = new THREE.Color(`hsl(${this.hue}, 100%, ${glowL}%)`);
		textMesh.outlineOpacity = opacity * 0.4;
		textMesh.outlineBlur = fontSize * 0.15;
		textMesh.strokeWidth = fontSize * 0.04;
		textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, 90%, ${glowL + 10}%)`);
		textMesh.strokeOpacity = opacity * 0.8;
	}

	async spawnLane(text: string, direction: 'ltr' | 'rtl', initialProgress = 0): Promise<number> {
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

		let mesh: THREE.Object3D;
		let texture: THREE.CanvasTexture | null = null;
		let estimatedWidth: number;

		if (useTroika) {
			mesh = this._createTroikaText(text, fontSize, opacity);
			estimatedWidth = text.length * fontSize * 0.6;
		} else {
			const result = this._createTextTexture(text, fontSize);
			texture = result.texture;

			const geometry = new THREE.PlaneGeometry(result.width, result.height);
			const material = new THREE.MeshBasicMaterial({
				map: texture,
				transparent: true,
				opacity: opacity,
				depthWrite: false,
				side: THREE.DoubleSide
			});

			mesh = new THREE.Mesh(geometry, material);
			estimatedWidth = result.width;
		}

		const z = -100 - depthRand * 600 * intensity;
		const y = (Math.random() - 0.5) * 800;

		const cameraZ = this.camera.position.z;
		const distanceFromCamera = cameraZ - z;
		const referenceDistance = cameraZ + 100;
		const perspectiveScale = distanceFromCamera / referenceDistance;

		const viewportSize = Math.max(window.innerWidth, window.innerHeight);
		const baseSpawnOffset = viewportSize * 1.3 + estimatedWidth;
		const baseDeleteOffset = viewportSize * 1.3 + estimatedWidth;

		const spawnOffset = baseSpawnOffset * perspectiveScale;
		const deleteOffset = baseDeleteOffset * perspectiveScale;

		const startX = direction === 'rtl' ? -spawnOffset : spawnOffset;
		const endX = direction === 'rtl' ? deleteOffset : -deleteOffset;

		const totalDistance = Math.abs(endX - startX);
		const baseSpeed = (250 + Math.pow(speedRand, 2) * 400) * intensity;
		const sizeFactor = 1 / (1 + fontSize / 150);
		const duration = totalDistance / (baseSpeed * sizeFactor);

		const initialX = startX + (endX - startX) * initialProgress;
		mesh.position.set(initialX, y, z);

		const now = performance.now();
		const adjustedStartTime = now - (initialProgress * duration * 1000);

		const id = this.laneIdCounter++;
		this.lanes.set(id, {
			mesh,
			startX,
			endX,
			startTime: adjustedStartTime,
			duration: duration * 1000,
			texture,
			isTroika: useTroika
		});

		this.scene.add(mesh);
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

	_disposeMesh(mesh: THREE.Object3D): void {
		if (mesh.children?.length) {
			for (const child of [...mesh.children]) {
				this._disposeMesh(child);
			}
		}

		const m = mesh as THREE.Mesh;
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

	_animate(): void {
		if (this.disposed) return;

		this.animationId = requestAnimationFrame(() => this._animate());

		if (this.contextLost) return;

		const now = performance.now();

		if (!this.isDragging) {
			const dt = 16;
			const friction = 0.92;

			this.rotationX += this.velocityX * dt;
			this.rotationY += this.velocityY * dt;

			this.velocityX *= friction;
			this.velocityY *= friction;

			if (Math.abs(this.velocityX) < 0.00001) this.velocityX = 0;
			if (Math.abs(this.velocityY) < 0.00001) this.velocityY = 0;

			const maxRotation = 0.8;
			this.rotationX = Math.max(-maxRotation, Math.min(maxRotation, this.rotationX));
			this.rotationY = Math.max(-maxRotation, Math.min(maxRotation, this.rotationY));
		}

		this.scene.rotation.x = this.rotationX;
		this.scene.rotation.y = this.rotationY;
		const toRemove: number[] = [];

		for (const [id, lane] of this.lanes) {
			const elapsed = now - lane.startTime;
			const progress = elapsed / lane.duration;

			if (progress >= 1) {
				toRemove.push(id);
			} else {
				lane.mesh.position.x = lane.startX + (lane.endX - lane.startX) * progress;
			}
		}

		for (const id of toRemove) {
			this.removeLane(id);
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

		window.removeEventListener('resize', this._boundResize);
		window.removeEventListener('mousedown', this._boundMouseDown);
		window.removeEventListener('mouseup', this._boundMouseUp);
		window.removeEventListener('mousemove', this._boundMouseMove);
		window.removeEventListener('wheel', this._boundWheel);

		this.clearAllLanes();

		this.renderer.dispose();

		if (this.renderer.domElement?.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
	}
}
