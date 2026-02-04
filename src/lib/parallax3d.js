import * as THREE from 'three';
import { Text } from 'troika-three-text';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';

// Font URLs for Troika (loaded on demand)
// Bundled locally with fallback to Google Fonts if local fails
const FONT_VAZIRMATN = '/fonts/Vazirmatn-Regular.ttf';
const FONT_SYSTEM = undefined; // Use Troika's default

// Typeface JSON fonts for TextGeometry (3D extrusion)
// Bundled locally for offline use
const FONT_TYPEFACE_URL = '/fonts/helvetiker_regular.typeface.json';

// Cache for loaded fonts
let loadedFont = null;
let fontLoadPromise = null;

// Canvas font ready promise (Vazirmatn loaded via CSS @import)
let canvasFontPromise = null;

function loadCanvasFont() {
	if (canvasFontPromise) return canvasFontPromise;
	// Font is loaded via CSS @import, just wait for it to be ready
	canvasFontPromise = document.fonts.ready;
	return canvasFontPromise;
}

let webglSupported = null;

export function isWebGLAvailable() {
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
	return webglSupported;
}

// Effect types: 'none', 'outline', 'shadow', 'emboss', 'extrude', 'neon'
// Texture types: 'solid', 'gradient', 'metallic', 'glass'

export class Parallax3DRenderer {
	constructor(container, options = {}) {
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

		// Camera rotation state
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

		this._init();
		this._loadFont();
		if (this.isRTL) {
			loadCanvasFont();
		}
	}

	async _loadFont() {
		// Use cached font if available
		if (loadedFont) {
			this.font = loadedFont;
			console.debug('3D font: using cached');
			return;
		}

		// Share the loading promise to avoid duplicate loads
		if (!fontLoadPromise) {
			fontLoadPromise = new Promise((resolve, reject) => {
				const loader = new FontLoader();
				loader.load(
					FONT_TYPEFACE_URL,
					(font) => {
						console.debug('3D font: loaded');
						loadedFont = font;
						resolve(font);
					},
					undefined,
					(err) => {
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

	_init() {
		const width = window.innerWidth;
		const height = window.innerHeight;

		this.scene = new THREE.Scene();

		// Add fog to hide spawn boundaries - lines fade in from edges
		this._updateFog();

		// Add lighting for 3D geometry
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

		// Handle WebGL context loss/restore
		this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
			console.debug('WebGL: context lost');
			e.preventDefault();
			this.contextLost = true;
		});
		this.renderer.domElement.addEventListener('webglcontextrestored', () => {
			console.debug('WebGL: context restored');
			this.contextLost = false;
		});
		this.contextLost = false;

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

	_onResize() {
		const width = window.innerWidth;
		const height = window.innerHeight;
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(width, height);
		this._updateFog();
	}

	_onMouseDown(e) {
		// Only start drag if clicking on background, not UI elements
		const target = e.target;
		const isInteractive = target.closest('button, input, select, textarea, a, label, .settings-panel, .metrics-bar, .text-display, .input-area, .controls, .keyboard-container, .results-panel, .multiplayer-panel');
		if (isInteractive) return;

		// Prevent text selection during drag
		e.preventDefault();

		this.isDragging = true;
		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = performance.now();
		// Kill velocity when grabbing to stop momentum
		this.velocityX = 0;
		this.velocityY = 0;
		document.body.style.userSelect = 'none';
	}

	_onMouseUp() {
		if (this.isDragging) {
			document.body.style.userSelect = '';
		}
		this.isDragging = false;
		// Velocity is already set from the last mouse move, momentum continues
	}

	_onMouseMove(e) {
		if (!this.isDragging) return;

		const now = performance.now();
		const dt = Math.max(1, now - this.lastDragTime); // ms since last move
		const deltaX = e.clientX - this.lastMouseX;
		const deltaY = e.clientY - this.lastMouseY;

		// Sensitivity: radians per pixel
		const sensitivity = 0.003;

		// Apply rotation directly while dragging (immediate response)
		this.rotationY -= deltaX * sensitivity;
		this.rotationX -= deltaY * sensitivity;

		// Clamp rotation
		const maxRotation = 0.8;
		this.rotationX = Math.max(-maxRotation, Math.min(maxRotation, this.rotationX));
		this.rotationY = Math.max(-maxRotation, Math.min(maxRotation, this.rotationY));

		// Track velocity for momentum (radians per ms)
		this.velocityX = (-deltaY * sensitivity) / dt;
		this.velocityY = (-deltaX * sensitivity) / dt;

		this.lastMouseX = e.clientX;
		this.lastMouseY = e.clientY;
		this.lastDragTime = now;
	}

	_onWheel(e) {
		// Ctrl+scroll for zoom
		if (!e.ctrlKey) return;

		e.preventDefault();

		const zoomSpeed = 100;
		const delta = e.deltaY > 0 ? zoomSpeed : -zoomSpeed;

		// Adjust camera Z position (zoom) - very deep range
		this.camera.position.z = Math.max(50, Math.min(15000, this.camera.position.z + delta));
	}

	_updateFog() {
		// Fog color based on theme
		const fogL = this.isDark ? 10 : 97;
		const fogColor = new THREE.Color(`hsl(${this.hue}, 10%, ${fogL}%)`);

		// Fog far enough that camera rotation doesn't push visible lines into it
		const viewportSize = Math.max(window.innerWidth, window.innerHeight);
		const fogNear = viewportSize * 0.8;
		const fogFar = viewportSize * 1.2;

		this.scene.fog = new THREE.Fog(fogColor, fogNear, fogFar);
	}

	_createTextTexture(text, fontSize) {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');

		// Use Vazirmatn for RTL text, system fonts for LTR
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
		const lightness = this.isDark ? 70 : 40;
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

	_getTextureColor(baseL, baseSat) {
		// Returns color based on texture setting
		switch (this.texture) {
			case 'gradient':
				// Slightly more saturated for gradient effect
				return { l: baseL, s: baseSat + 15 };
			case 'metallic':
				// Higher saturation, adjusted lightness for metallic sheen
				return { l: this.isDark ? baseL + 10 : baseL - 5, s: baseSat + 25 };
			case 'glass':
				// Lower saturation for glass/frosted look
				return { l: baseL, s: Math.max(5, baseSat - 10) };
			default: // solid
				return { l: baseL, s: baseSat };
		}
	}

	_getTextureOpacity(baseOpacity) {
		switch (this.texture) {
			case 'solid':
				return Math.min(1, baseOpacity * 3); // Much more opaque for solid
			case 'glass':
				return baseOpacity * 0.8; // Slightly transparent
			case 'metallic':
				return Math.min(1, baseOpacity * 2.5); // More opaque for metallic
			default:
				return baseOpacity;
		}
	}

	_createTroikaText(text, fontSize, opacity) {
		const baseL = this.isDark ? 70 : 40;
		const baseSat = 20;
		const { l, s } = this._getTextureColor(baseL, baseSat);
		const finalOpacity = this._getTextureOpacity(opacity);

		// Effects that need actual 3D depth (Z-stacked layers)
		const needs3DDepth = ['extrude', 'shadow', 'emboss'].includes(this.effect);

		if (needs3DDepth) {
			return this._create3DDepthText(text, fontSize, finalOpacity, l, s);
		}

		// Rainbow mode for 2D effects
		if (this.rainbow) {
			// For RTL, use colorRanges to preserve connected letters
			// For LTR, use per-character meshes for better effect control
			if (this.isRTL) {
				return this._createRainbowTroikaTextRTL(text, fontSize, finalOpacity, l, s);
			}
			return this._createRainbowTroikaText(text, fontSize, finalOpacity, l, s);
		}

		// 2D effects use single text mesh
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
			default: // 'none' - flat text with texture color
				textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
				textMesh.fillOpacity = finalOpacity;
		}

		textMesh.sync();
		return textMesh;
	}

	_createRainbowTroikaText(text, fontSize, finalOpacity, l, s) {
		const group = new THREE.Group();
		group.userData.isTroikaGroup = true;
		group.userData.textMeshes = [];

		const chars = [...text];
		const charWidth = fontSize * 0.6; // Approximate character width
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

	_createRainbowTroikaTextRTL(text, fontSize, finalOpacity, l, s) {
		// For RTL, use a random rainbow hue per line (can't do per-char without breaking shaping)
		const textMesh = new Text();
		textMesh.text = text;
		textMesh.fontSize = fontSize;
		textMesh.font = FONT_VAZIRMATN;
		textMesh.anchorX = 'center';
		textMesh.anchorY = 'middle';
		textMesh.direction = 'rtl';
		textMesh.fillOpacity = finalOpacity;

		// Random rainbow hue for this line
		const hue = Math.random() * 360;
		textMesh.color = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);

		// Apply effects with matching hue
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

	_applyOutlineEffectWithHue(textMesh, fontSize, opacity, l, s, hue) {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new THREE.Color(`hsl(${hue}, 60%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffectWithHue(textMesh, fontSize, opacity, l, hue) {
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

	_create3DDepthText(text, fontSize, opacity, l, s) {
		// For extrude effect with loaded font, use real 3D TextGeometry
		// But only for LTR - the Helvetiker font doesn't support Persian/Arabic
		if (this.effect === 'extrude' && this.font && !this.isRTL) {
			return this._createExtrudedText(text, fontSize, opacity, l, s);
		}

		// Layered approach for shadow/emboss effects
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
					// Fallback when font not loaded
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

	_createExtrudedText(text, fontSize, opacity, l, s) {
		const depth = fontSize * 2;
		const finalOpacity = this.texture === 'solid' ? Math.min(1, opacity * 4) : opacity;
		const isTransparent = finalOpacity < 0.99;

		// Rainbow mode: create separate mesh per character
		// Skip for RTL - Arabic/Persian script requires connected letters
		if (this.rainbow && !this.isRTL) {
			return this._createRainbowExtrudedText(text, fontSize, depth, finalOpacity, isTransparent, l, s);
		}

		// Standard single-color extruded text
		const geometry = new TextGeometry(text, {
			font: this.font,
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
		const sideColor = new THREE.Color(`hsl(${this.hue}, ${s}%, ${Math.max(10, l - 25)}%)`);

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

	_createRainbowExtrudedText(text, fontSize, depth, finalOpacity, isTransparent, l, s) {
		const group = new THREE.Group();
		group.userData.isExtrudedText = true;
		group.userData.geometries = [];
		group.userData.materials = [];

		const chars = [...text]; // Handle unicode properly
		let xOffset = 0;

		chars.forEach((char, i) => {
			if (char === ' ') {
				xOffset += fontSize * 0.3;
				return;
			}

			const charGeometry = new TextGeometry(char, {
				font: this.font,
				size: fontSize,
				depth: depth,
				curveSegments: 4,
				bevelEnabled: true,
				bevelThickness: fontSize * 0.04,
				bevelSize: fontSize * 0.03,
				bevelSegments: 2
			});

			charGeometry.computeBoundingBox();
			const charWidth = charGeometry.boundingBox.max.x - charGeometry.boundingBox.min.x;

			// Rainbow hue based on character position
			const hue = (i * 360 / Math.max(chars.length, 1)) % 360;
			const frontColor = new THREE.Color(`hsl(${hue}, 70%, ${l}%)`);
			const sideColor = new THREE.Color(`hsl(${hue}, 60%, ${Math.max(15, l - 20)}%)`);

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

		// Center the group
		const totalWidth = xOffset;
		group.children.forEach(child => {
			child.position.x -= totalWidth / 2;
			child.position.y -= fontSize / 2;
			child.position.z -= depth / 2;
		});

		return group;
	}

	_styleExtrudeLayer(textMesh, fontSize, opacity, l, s, progress, isFront) {
		// Front face is brightest, back layers get progressively darker (like a 3D block)
		const layerL = isFront ? l : Math.max(5, l - progress * 50);
		const layerSat = isFront ? s + 10 : Math.max(5, s - progress * 15);
		// Keep back layers fairly opaque so they're visible as depth
		const layerOpacity = isFront ? opacity : opacity * (1.0 - progress * 0.4);

		textMesh.color = new THREE.Color(`hsl(${this.hue}, ${Math.max(5, layerSat)}%, ${layerL}%)`);
		textMesh.fillOpacity = layerOpacity;

		// Front layer gets a stroke for definition
		if (isFront) {
			textMesh.strokeWidth = fontSize * 0.02;
			textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, ${s}%, ${this.isDark ? 95 : 10}%)`);
			textMesh.strokeOpacity = opacity * 0.5;
		}
	}

	_styleShadowLayer(textMesh, fontSize, opacity, l, s, progress, isFront) {
		if (isFront) {
			// Front is the main text
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
		} else {
			// Shadow layers: very dark, offset diagonally for 3D shadow
			const shadowL = this.isDark ? 8 : 15;
			textMesh.color = new THREE.Color(`hsl(${this.hue}, 5%, ${shadowL}%)`);
			textMesh.fillOpacity = opacity * (0.7 - progress * 0.5);
			// Offset shadow layers diagonally for directional depth
			textMesh.position.x = progress * fontSize * 0.3;
			textMesh.position.y = -progress * fontSize * 0.3;
		}
	}

	_styleEmbossLayer(textMesh, fontSize, opacity, l, s, progress, isFront) {
		if (isFront) {
			// Main text with highlight
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
			textMesh.fillOpacity = opacity;
			textMesh.strokeWidth = fontSize * 0.025;
			textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, ${s - 10}%, ${this.isDark ? 90 : 98}%)`);
			textMesh.strokeOpacity = opacity * 0.6;
		} else {
			// Back layers create embossed depth - darker toward back
			const backL = this.isDark ? Math.max(5, l - 30 - progress * 25) : Math.min(90, l + 20 + progress * 15);
			textMesh.color = new THREE.Color(`hsl(${this.hue}, ${Math.max(5, s - 10)}%, ${backL}%)`);
			textMesh.fillOpacity = opacity * (0.9 - progress * 0.5);
		}
	}

	_applyOutlineEffect(textMesh, fontSize, opacity, l, s) {
		const outlineL = this.isDark ? 30 : 70;
		textMesh.color = new THREE.Color(`hsl(${this.hue}, ${s}%, ${l}%)`);
		textMesh.fillOpacity = opacity;
		textMesh.outlineWidth = fontSize * 0.06;
		textMesh.outlineColor = new THREE.Color(`hsl(${this.hue}, ${s - 5}%, ${outlineL}%)`);
		textMesh.outlineOpacity = opacity * 0.8;
	}

	_applyNeonEffect(textMesh, fontSize, opacity, l, s) {
		// Neon: bright core with glowing outline
		const glowL = this.isDark ? 60 : 50;
		const coreL = this.isDark ? 90 : 95;
		textMesh.color = new THREE.Color(`hsl(${this.hue}, 80%, ${coreL}%)`);
		textMesh.fillOpacity = opacity * 1.2;
		// Glow layers
		textMesh.outlineWidth = fontSize * 0.2;
		textMesh.outlineColor = new THREE.Color(`hsl(${this.hue}, 100%, ${glowL}%)`);
		textMesh.outlineOpacity = opacity * 0.4;
		textMesh.outlineBlur = fontSize * 0.15;
		// Inner glow
		textMesh.strokeWidth = fontSize * 0.04;
		textMesh.strokeColor = new THREE.Color(`hsl(${this.hue}, 90%, ${glowL + 10}%)`);
		textMesh.strokeOpacity = opacity * 0.8;
	}

	async spawnLane(text, direction, initialProgress = 0) {
		// Wait for font if using extrude effect
		if (this.effect === 'extrude' && !this.font && fontLoadPromise) {
			try {
				this.font = await fontLoadPromise;
			} catch (e) {
				// Font failed, will use fallback
			}
		}

		// Wait for canvas font if RTL and using canvas texture
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
		const opacity = (0.03 + Math.pow(opacityRand, 2) * 0.2) * intensity;

		let mesh;
		let texture = null;
		let estimatedWidth;

		if (useTroika) {
			// Use Troika for 3D effects/textures
			mesh = this._createTroikaText(text, fontSize, opacity);
			estimatedWidth = text.length * fontSize * 0.6;
		} else {
			// Use canvas texture for flat text
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

		// Perspective-correct spawn: lines converge to vanishing point
		// Further lines (more negative Z) spawn closer to center
		const cameraZ = this.camera.position.z;
		const distanceFromCamera = cameraZ - z;
		const referenceDistance = cameraZ + 100; // reference plane
		const perspectiveScale = distanceFromCamera / referenceDistance;

		// Use viewport size for consistent behavior across window sizes
		const viewportSize = Math.max(window.innerWidth, window.innerHeight);
		// Spawn behind fog (fog far is at 1.2x viewport)
		const baseSpawnOffset = viewportSize * 1.3 + estimatedWidth;
		const baseDeleteOffset = viewportSize * 1.3 + estimatedWidth;

		// Scale by perspective - far lines spawn closer to center
		const spawnOffset = baseSpawnOffset * perspectiveScale;
		const deleteOffset = baseDeleteOffset * perspectiveScale;

		const startX = direction === 'rtl' ? -spawnOffset : spawnOffset;
		const endX = direction === 'rtl' ? deleteOffset : -deleteOffset;

		// Duration based on total travel distance - faster speeds so lines reach view quickly
		const totalDistance = Math.abs(endX - startX);
		const baseSpeed = (250 + Math.pow(speedRand, 2) * 400) * intensity; // pixels per second
		const sizeFactor = 1 / (1 + fontSize / 150); // larger = slower (reduced impact)
		const duration = totalDistance / (baseSpeed * sizeFactor);

		// Apply initial progress (for burst spawns that start mid-flight)
		const initialX = startX + (endX - startX) * initialProgress;
		mesh.position.set(initialX, y, z);

		// Adjust start time so animation continues from initial progress
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

	removeLane(id) {
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

	_disposeMesh(mesh) {
		// Recursively dispose all children first
		if (mesh.children?.length) {
			for (const child of [...mesh.children]) {
				this._disposeMesh(child);
			}
		}

		// Dispose geometry
		if (mesh.geometry) {
			mesh.geometry.dispose();
		}

		// Dispose material(s)
		if (mesh.material) {
			if (Array.isArray(mesh.material)) {
				for (const mat of mesh.material) {
					mat.dispose();
				}
			} else {
				mesh.material.dispose();
			}
		}

		// Troika text has its own dispose
		if (typeof mesh.dispose === 'function') {
			mesh.dispose();
		}
	}

	updateSettings(options) {
		// Just update settings - existing lanes continue with old style,
		// new lanes will use new settings
		const themeChanged =
			(options.hue !== undefined && options.hue !== this.hue) ||
			(options.isDark !== undefined && options.isDark !== this.isDark);

		if (options.intensity !== undefined) this.intensity = options.intensity;
		if (options.hue !== undefined) this.hue = options.hue;
		if (options.isDark !== undefined) this.isDark = options.isDark;
		if (options.isRTL !== undefined) {
			this.isRTL = options.isRTL;
			if (options.isRTL) loadCanvasFont();
		}
		if (options.effect !== undefined) this.effect = options.effect;
		if (options.texture !== undefined) this.texture = options.texture;
		if (options.rainbow !== undefined) this.rainbow = options.rainbow;

		// Update fog color when theme changes
		if (themeChanged) {
			this._updateFog();
		}
	}

	getLaneCount() {
		return this.lanes.size;
	}

	_animate() {
		if (this.disposed) return;

		this.animationId = requestAnimationFrame(() => this._animate());

		// Skip rendering if context lost
		if (this.contextLost) return;

		const now = performance.now();

		// Physics-based camera movement
		if (!this.isDragging) {
			// Apply momentum when not dragging
			const dt = 16; // Assume ~60fps frame time
			const friction = 0.92; // Damping factor (lower = more friction)

			// Apply velocity to rotation
			this.rotationX += this.velocityX * dt;
			this.rotationY += this.velocityY * dt;

			// Apply friction to velocity
			this.velocityX *= friction;
			this.velocityY *= friction;

			// Stop very small velocities to prevent drift
			if (Math.abs(this.velocityX) < 0.00001) this.velocityX = 0;
			if (Math.abs(this.velocityY) < 0.00001) this.velocityY = 0;

			// Clamp rotation
			const maxRotation = 0.8;
			this.rotationX = Math.max(-maxRotation, Math.min(maxRotation, this.rotationX));
			this.rotationY = Math.max(-maxRotation, Math.min(maxRotation, this.rotationY));
		}

		// Apply rotation to scene
		this.scene.rotation.x = this.rotationX;
		this.scene.rotation.y = this.rotationY;
		const toRemove = [];

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

	clearAllLanes() {
		const laneIds = [...this.lanes.keys()];
		for (const id of laneIds) {
			this.removeLane(id);
		}
	}

	dispose() {
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

		// Clear references
		this.scene = null;
		this.camera = null;
		this.renderer = null;
		this.lanes = null;
	}
}
