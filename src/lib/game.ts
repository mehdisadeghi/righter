import {
	BoxGeometry,
	CanvasTexture,
	DoubleSide,
	Mesh,
	MeshBasicMaterial,
	NearestFilter,
	Object3D,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	Vector3,
	type Material
} from 'three';
import { Text } from 'troika-three-text';

const PEN_Y = -380;
const PEN_SPEED = 600;
const BULLET_SPEED = 800;
const FIRE_RATE = 4;
const BULLET_POOL_SIZE = 20;
const PARTICLE_LIFETIME = 0.6;
const INVADER_Z = 0;

const INVADER_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD', 'Space', 'Escape']);

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

interface Bullet {
	mesh: Mesh;
	active: boolean;
}

interface Particle {
	mesh: Mesh;
	velocity: Vector3;
	life: number;
	maxLife: number;
}

const INITIAL_LIVES = 5;
const HIGHSCORE_KEY = 'righter_invader_highscore';

export interface InvaderStats {
	score: number;
	lives: number;
	highScore: number;
	gameOver: boolean;
}

// --- Hit effect system ---

export type HitEffectType = 'oblivion' | 'explode';

interface HitEffect {
	update(dt: number): boolean;  // returns true when finished
}

/** Accelerates lane backward into fog, shrinks and fades */
class OblivionEffect implements HitEffect {
	private _mesh: Object3D;
	private _elapsed: number;
	private _duration: number;
	private _startZ: number;
	private _startScale: number;

	constructor(mesh: Object3D) {
		this._mesh = mesh;
		this._elapsed = 0;
		this._duration = 1.0;
		this._startZ = mesh.position.z;
		this._startScale = mesh.scale.x;
	}

	update(dt: number): boolean {
		this._elapsed += dt;
		const t = Math.min(1, this._elapsed / this._duration);
		// Ease-in: accelerate backward
		const ease = t * t;

		this._mesh.position.z = this._startZ - ease * 2000;

		const scale = this._startScale * (1 - ease * 0.8);
		this._mesh.scale.set(scale, scale, scale);

		this._setOpacity(1 - ease);

		return t >= 1;
	}

	private _setOpacity(opacity: number): void {
		_setMeshTreeOpacity(this._mesh, opacity);
	}
}

/** Spawns explosion particles from hit point, lane removed immediately */
class ExplodeEffect implements HitEffect {
	private _particles: Particle[];
	private _scene: Scene;

	constructor(scene: Scene, position: Vector3, count: number) {
		this._scene = scene;
		this._particles = [];
		for (let i = 0; i < count; i++) {
			const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
			const material = new MeshBasicMaterial({
				color,
				transparent: true,
				opacity: 1.0,
				depthWrite: false
			});
			const mesh = new Mesh(particleGeometry, material);
			mesh.position.copy(position);

			const angle = Math.random() * Math.PI * 2;
			const speed = 100 + Math.random() * 200;
			const velocity = new Vector3(
				Math.cos(angle) * speed,
				Math.sin(angle) * speed * 0.8 + 80,
				(Math.random() - 0.5) * 60
			);

			const life = PARTICLE_LIFETIME * (0.6 + Math.random() * 0.4);
			scene.add(mesh);
			this._particles.push({ mesh, velocity, life, maxLife: life });
		}
	}

	update(dt: number): boolean {
		for (let i = this._particles.length - 1; i >= 0; i--) {
			const p = this._particles[i];
			p.life -= dt;

			if (p.life <= 0) {
				this._scene.remove(p.mesh);
				(p.mesh.material as MeshBasicMaterial).dispose();
				this._particles.splice(i, 1);
				continue;
			}

			p.mesh.position.x += p.velocity.x * dt;
			p.mesh.position.y += p.velocity.y * dt;
			p.mesh.position.z += p.velocity.z * dt;
			p.velocity.y -= 200 * dt;

			const t = p.life / p.maxLife;
			(p.mesh.material as MeshBasicMaterial).opacity = t;
			const scale = 0.5 + t * 0.5;
			p.mesh.scale.set(scale, scale, scale);
		}
		return this._particles.length === 0;
	}
}

// Shared geometry for explosion particles
const PARTICLE_COLORS = [0x1a1a2e, 0x2a2a4e, 0x0a0a1e, 0xc4a35a, 0x3a3a5e, 0x4a2a1e];
const particleGeometry = new PlaneGeometry(4, 4);

/** Recursively set opacity on all materials in a mesh tree (handles Troika, Groups, standard meshes) */
function _setMeshTreeOpacity(obj: Object3D, opacity: number): void {
	// Troika text
	if ('fillOpacity' in obj) {
		(obj as Text).fillOpacity = opacity;
		if ('outlineOpacity' in obj) (obj as Text).outlineOpacity = opacity * 0.8;
		if ('strokeOpacity' in obj) (obj as Text).strokeOpacity = opacity * 0.8;
	}

	// Standard mesh material
	const m = obj as Mesh;
	if (m.material) {
		if (Array.isArray(m.material)) {
			for (const mat of m.material) {
				mat.transparent = true;
				mat.opacity = opacity;
			}
		} else {
			m.material.transparent = true;
			(m.material as Material & { opacity: number }).opacity = opacity;
		}
	}

	for (const child of obj.children) {
		_setMeshTreeOpacity(child, opacity);
	}
}

// --- Pen texture ---

function createPenTexture(): CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = 32;
	canvas.height = 48;
	const ctx = canvas.getContext('2d')!;

	ctx.clearRect(0, 0, 32, 48);

	const ink = '#1a1a2e';
	const gold = '#c4a35a';
	const darkGold = '#8a7030';
	const highlight = '#2a2a4e';

	// Nib body (tapered upward -- tip at top)
	ctx.fillStyle = ink;
	ctx.beginPath();
	ctx.moveTo(16, 2);
	ctx.lineTo(22, 28);
	ctx.lineTo(24, 40);
	ctx.lineTo(22, 48);
	ctx.lineTo(10, 48);
	ctx.lineTo(8, 40);
	ctx.lineTo(10, 28);
	ctx.closePath();
	ctx.fill();

	ctx.fillStyle = gold;
	ctx.fillRect(9, 42, 14, 4);

	ctx.fillStyle = darkGold;
	ctx.fillRect(9, 42, 14, 1);

	ctx.fillStyle = highlight;
	ctx.beginPath();
	ctx.moveTo(15.5, 8);
	ctx.lineTo(16.5, 8);
	ctx.lineTo(17, 36);
	ctx.lineTo(15, 36);
	ctx.closePath();
	ctx.fill();

	ctx.fillStyle = gold;
	ctx.fillRect(15, 2, 2, 4);

	ctx.fillStyle = '#0a0a1e';
	ctx.beginPath();
	ctx.arc(16, 1.5, 1.5, 0, Math.PI * 2);
	ctx.fill();

	const texture = new CanvasTexture(canvas);
	texture.minFilter = NearestFilter;
	texture.magFilter = NearestFilter;
	return texture;
}

// --- Main game class ---

export class ScriptInvaderGame {
	private _scene: Scene;
	private _camera: PerspectiveCamera;
	private _penMesh: Mesh;
	private _penTexture: CanvasTexture;
	private _bullets: Bullet[];
	private _bulletGeometry: BoxGeometry;
	private _bulletMaterial: MeshBasicMaterial;
	private _keysHeld: Set<string>;
	private _fireCooldown: number;
	private _removeLane: ((id: number) => void) | null;
	private _onExit: (() => void) | null;
	private _boundKeyDown: (e: KeyboardEvent) => void;
	private _boundKeyUp: (e: KeyboardEvent) => void;
	private _boundBlur: () => void;
	private _disposed: boolean;

	// Active hit effects (laneId -> effect). Lanes in this map are excluded from collision.
	private _activeEffects: Map<number, HitEffect>;
	// Lanes whose effect finished and need removal next frame
	private _pendingRemoval: number[];

	hitEffect: HitEffectType;
	score: number;
	lives: number;
	highScore: number;
	gameOver: boolean;

	constructor(scene: Scene, camera: PerspectiveCamera, isDark: boolean) {
		this._scene = scene;
		this._camera = camera;
		this._disposed = false;
		this.score = 0;
		this.lives = INITIAL_LIVES;
		this.gameOver = false;
		this.hitEffect = 'oblivion';

		let saved = 0;
		try { saved = parseInt(localStorage.getItem(HIGHSCORE_KEY) || '0', 10) || 0; } catch {}
		this.highScore = saved;
		this._fireCooldown = 0;
		this._removeLane = null;
		this._onExit = null;
		this._keysHeld = new Set();
		this._activeEffects = new Map();
		this._pendingRemoval = [];

		// Pen mesh
		this._penTexture = createPenTexture();
		const penGeometry = new PlaneGeometry(40, 60);
		const penMaterial = new MeshBasicMaterial({
			map: this._penTexture,
			transparent: true,
			depthWrite: false,
			side: DoubleSide
		});
		this._penMesh = new Mesh(penGeometry, penMaterial);
		this._penMesh.position.set(0, PEN_Y, INVADER_Z);
		this._scene.add(this._penMesh);

		// Bullet pool
		this._bulletGeometry = new BoxGeometry(4, 12, 2);
		this._bulletMaterial = new MeshBasicMaterial({ color: isDark ? 0xc0c8e0 : 0x1a1a3e });
		this._bullets = [];
		for (let i = 0; i < BULLET_POOL_SIZE; i++) {
			const mesh = new Mesh(this._bulletGeometry, this._bulletMaterial);
			mesh.visible = false;
			this._scene.add(mesh);
			this._bullets.push({ mesh, active: false });
		}

		// Keyboard
		this._boundKeyDown = this._onKeyDown.bind(this);
		this._boundKeyUp = this._onKeyUp.bind(this);
		this._boundBlur = () => { this._keysHeld.clear(); };
		window.addEventListener('keydown', this._boundKeyDown, { capture: true });
		window.addEventListener('keyup', this._boundKeyUp, { capture: true });
		window.addEventListener('blur', this._boundBlur);
	}

	setRemoveLane(fn: (id: number) => void): void {
		this._removeLane = fn;
	}

	setOnExit(fn: () => void): void {
		this._onExit = fn;
	}

	private _onKeyDown(e: KeyboardEvent): void {
		if (this._disposed) return;
		if (!INVADER_KEYS.has(e.code)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.code === 'Escape') {
			if (this._onExit) this._onExit();
			return;
		}
		this._keysHeld.add(e.code);
	}

	private _onKeyUp(e: KeyboardEvent): void {
		if (this._disposed) return;
		if (!INVADER_KEYS.has(e.code)) return;
		e.preventDefault();
		e.stopPropagation();
		this._keysHeld.delete(e.code);
	}

	update(dt: number, lanes: Map<number, Lane>): void {
		if (this._disposed) return;

		// Update active hit effects even when game over (finish animations)
		for (const [id, effect] of this._activeEffects) {
			const done = effect.update(dt);
			if (done) {
				this._pendingRemoval.push(id);
			}
		}

		// Remove lanes whose effects finished last frame
		for (const id of this._pendingRemoval) {
			if (this._removeLane) this._removeLane(id);
			this._activeEffects.delete(id);
		}
		this._pendingRemoval = [];

		if (this.gameOver) return;

		// Pen movement
		const halfWidth = window.innerWidth * 0.6;
		let moving = 0;
		if (this._keysHeld.has('ArrowLeft') || this._keysHeld.has('KeyA')) {
			this._penMesh.position.x -= PEN_SPEED * dt;
			moving = -1;
		}
		if (this._keysHeld.has('ArrowRight') || this._keysHeld.has('KeyD')) {
			this._penMesh.position.x += PEN_SPEED * dt;
			moving = 1;
		}
		this._penMesh.position.x = Math.max(-halfWidth, Math.min(halfWidth, this._penMesh.position.x));

		const targetTilt = moving * 0.2;
		this._penMesh.rotation.z += (targetTilt - this._penMesh.rotation.z) * Math.min(1, dt * 10);

		// Shooting
		this._fireCooldown -= dt;
		if (this._keysHeld.has('Space') && this._fireCooldown <= 0) {
			const bullet = this._bullets.find(b => !b.active);
			if (bullet) {
				bullet.active = true;
				bullet.mesh.visible = true;
				bullet.mesh.position.set(
					this._penMesh.position.x,
					this._penMesh.position.y + 35,
					INVADER_Z
				);
				this._fireCooldown = 1 / FIRE_RATE;
			}
		}

		// Bullet update + collision using stored lane dimensions
		const ceiling = window.innerHeight * 0.6;

		for (const bullet of this._bullets) {
			if (!bullet.active) continue;

			bullet.mesh.position.y += BULLET_SPEED * dt;

			if (bullet.mesh.position.y > ceiling) {
				bullet.active = false;
				bullet.mesh.visible = false;
				continue;
			}

			const bx = bullet.mesh.position.x;
			const by = bullet.mesh.position.y;
			const bHalfW = 2;
			const bHalfH = 6;

			let hitLaneId: number | null = null;
			let hitLane: Lane | null = null;

			for (const [id, lane] of lanes) {
				// Skip lanes already playing a hit effect
				if (this._activeEffects.has(id)) continue;

				// Use stored dimensions centered on mesh position
				const lx = lane.mesh.position.x;
				const ly = lane.mesh.position.y;
				const halfW = lane.width / 2;
				const halfH = lane.height / 2;

				if (bx + bHalfW >= lx - halfW && bx - bHalfW <= lx + halfW &&
					by + bHalfH >= ly - halfH && by - bHalfH <= ly + halfH) {
					hitLaneId = id;
					hitLane = lane;
					break;
				}
			}

			if (hitLaneId !== null && hitLane !== null) {
				bullet.active = false;
				bullet.mesh.visible = false;
				this.score++;
				this._updateHighScore();

				const hitPos = new Vector3(bx, by, hitLane.mesh.position.z);
				this._applyHitEffect(hitLaneId, hitLane, hitPos);
			}
		}

		// Falling lanes that reach the pen count as hits
		const penY = this._penMesh.position.y;
		const penHalfW = 20;
		const penHalfH = 30;
		const penX = this._penMesh.position.x;

		for (const [id, lane] of lanes) {
			if (this._activeEffects.has(id)) continue;
			// Only check lanes that are falling (endY < startY)
			if (lane.endY >= lane.startY) continue;

			const ly = lane.mesh.position.y;
			const lx = lane.mesh.position.x;
			const halfW = lane.width / 2;
			const halfH = lane.height / 2;

			// Lane overlaps the pen
			if (ly - halfH <= penY + penHalfH && ly + halfH >= penY - penHalfH &&
				lx + halfW >= penX - penHalfW && lx - halfW <= penX + penHalfW) {
				this.lives--;
				const hitPos = new Vector3(lx, ly, lane.mesh.position.z);
				this._applyHitEffect(id, lane, hitPos);
				if (this.lives <= 0) {
					this.gameOver = true;
					this._updateHighScore();
					return;
				}
			}
		}
	}

	private _applyHitEffect(laneId: number, lane: Lane, hitPos: Vector3): void {
		let effect: HitEffect;

		switch (this.hitEffect) {
			case 'explode':
				effect = new ExplodeEffect(this._scene, hitPos, 8 + Math.floor(Math.random() * 5));
				// For explode, remove the lane immediately and only track the particle effect
				if (this._removeLane) this._removeLane(laneId);
				// Track particles under a synthetic negative id so they don't collide with anything
				this._activeEffects.set(-(laneId + 1), effect);
				return;

			case 'oblivion':
			default:
				effect = new OblivionEffect(lane.mesh);
				break;
		}

		this._activeEffects.set(laneId, effect);
	}

	private _updateHighScore(): void {
		if (this.score > this.highScore) {
			this.highScore = this.score;
			try { localStorage.setItem(HIGHSCORE_KEY, String(this.highScore)); } catch {}
		}
	}

	getStats(): InvaderStats {
		return { score: this.score, lives: this.lives, highScore: this.highScore, gameOver: this.gameOver };
	}

	reset(): void {
		this.score = 0;
		this.lives = INITIAL_LIVES;
		this.gameOver = false;
		this._fireCooldown = 0;
		this._keysHeld.clear();
		this._penMesh.position.set(0, PEN_Y, INVADER_Z);
		this._penMesh.rotation.z = 0;
		for (const bullet of this._bullets) {
			bullet.active = false;
			bullet.mesh.visible = false;
		}
		this._activeEffects.clear();
		this._pendingRemoval = [];
	}

	dispose(): void {
		this._disposed = true;

		window.removeEventListener('keydown', this._boundKeyDown, { capture: true });
		window.removeEventListener('keyup', this._boundKeyUp, { capture: true });
		window.removeEventListener('blur', this._boundBlur);

		this._scene.remove(this._penMesh);
		this._penMesh.geometry.dispose();
		(this._penMesh.material as MeshBasicMaterial).dispose();
		this._penTexture.dispose();

		for (const bullet of this._bullets) {
			this._scene.remove(bullet.mesh);
		}
		this._bulletGeometry.dispose();
		this._bulletMaterial.dispose();
		this._bullets = [];

		this._activeEffects.clear();
		this._pendingRemoval = [];
		this._keysHeld.clear();
	}
}
