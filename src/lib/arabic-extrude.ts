import * as THREE from 'three';
import opentype from 'opentype.js';
import type { Font, PathCommand } from 'opentype.js';

interface BBox {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

interface SegmentPath {
	text: string;
	path: { commands: PathCommand[]; getBoundingBox(): BBox };
	width: number;
	bbox: BBox;
}

interface PathLike {
	commands: PathCommand[];
	getBoundingBox(): BBox;
}

interface ContourBBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface ProcessedContour {
	contour: PathCommand[];
	area: number;
	isClockwise: boolean;
}

interface ExtrudeOptions {
	bevelEnabled?: boolean;
	bevelThickness?: number;
	bevelSize?: number;
	bevelSegments?: number;
	curveSegments?: number;
}

const fontCache = new Map<string, Font>();
let fontLoadPromise: Promise<Font> | null = null;

/**
 * Handle text with ZWNJ by processing segments with correct RTL positioning
 * OpenType.js has bidi issues with ZWNJ that cause segments to appear in wrong order
 */
function getPathWithZWNJ(font: Font, text: string, fontSize: number): PathLike {
	const segments = text.split('\u200C');

	const segmentPaths: SegmentPath[] = segments.map(seg => {
		const path = font.getPath(seg, 0, 0, fontSize);
		const bbox = path.getBoundingBox();
		return {
			text: seg,
			path,
			width: bbox.x2 - bbox.x1,
			bbox
		};
	});

	const totalWidth = segmentPaths.reduce((sum, sp) => sum + sp.width, 0);

	let xPos = totalWidth;

	const combinedCommands: PathCommand[] = [];

	for (const sp of segmentPaths) {
		const offsetX = xPos - sp.bbox.x2;

		for (const cmd of sp.path.commands) {
			const newCmd = { ...cmd };
			if (newCmd.x !== undefined) newCmd.x += offsetX;
			if (newCmd.x1 !== undefined) newCmd.x1 += offsetX;
			if (newCmd.x2 !== undefined) newCmd.x2 += offsetX;
			combinedCommands.push(newCmd);
		}

		xPos -= sp.width;
	}

	return {
		commands: combinedCommands,
		getBoundingBox: (): BBox => {
			let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
			for (const cmd of combinedCommands) {
				if (cmd.x !== undefined) { x1 = Math.min(x1, cmd.x); x2 = Math.max(x2, cmd.x); }
				if (cmd.y !== undefined) { y1 = Math.min(y1, cmd.y); y2 = Math.max(y2, cmd.y); }
				if (cmd.x1 !== undefined) { x1 = Math.min(x1, cmd.x1); x2 = Math.max(x2, cmd.x1); }
				if (cmd.y1 !== undefined) { y1 = Math.min(y1, cmd.y1); y2 = Math.max(y2, cmd.y1); }
				if (cmd.x2 !== undefined) { x1 = Math.min(x1, cmd.x2); x2 = Math.max(x2, cmd.x2); }
				if (cmd.y2 !== undefined) { y1 = Math.min(y1, cmd.y2); y2 = Math.max(y2, cmd.y2); }
			}
			return { x1, y1, x2, y2 };
		}
	};
}

export async function loadFont(url: string): Promise<Font> {
	const cached = fontCache.get(url);
	if (cached) {
		return cached;
	}

	if (fontLoadPromise) {
		return fontLoadPromise;
	}

	fontLoadPromise = new Promise<Font>((resolve, reject) => {
		opentype.load(url, (err: Error | null, font?: Font) => {
			if (err || !font) {
				console.error('Failed to load font:', err);
				reject(err);
				return;
			}
			fontCache.set(url, font);
			resolve(font);
		});
	});

	return fontLoadPromise;
}

function pathToShape(path: PathLike, scale: number, offsetX: number, offsetY: number): THREE.Shape | null {
	const shape = new THREE.Shape();
	const commands = path.commands;

	if (!commands || commands.length === 0) {
		return null;
	}

	for (let i = 0; i < commands.length; i++) {
		const cmd = commands[i];
		const x = (cmd.x ?? 0) * scale + offsetX;
		const y = (cmd.y ?? 0) * scale + offsetY;

		switch (cmd.type) {
			case 'M':
				shape.moveTo(x, y);
				break;
			case 'L':
				shape.lineTo(x, y);
				break;
			case 'Q':
				shape.quadraticCurveTo(
					cmd.x1! * scale + offsetX,
					cmd.y1! * scale + offsetY,
					x, y
				);
				break;
			case 'C':
				shape.bezierCurveTo(
					cmd.x1! * scale + offsetX,
					cmd.y1! * scale + offsetY,
					cmd.x2! * scale + offsetX,
					cmd.y2! * scale + offsetY,
					x, y
				);
				break;
			case 'Z':
				shape.closePath();
				break;
		}
	}

	return shape;
}

export function createArabicExtrudedText(
	font: Font,
	text: string,
	fontSize: number,
	depth: number,
	options: ExtrudeOptions = {}
): THREE.ExtrudeGeometry | null {
	const {
		bevelEnabled = true,
		bevelThickness = fontSize * 0.05,
		bevelSize = fontSize * 0.04,
		bevelSegments = 3,
		curveSegments = 6
	} = options;

	const scale = fontSize / font.unitsPerEm;

	let path: PathLike;
	if (text.includes('\u200C')) {
		path = getPathWithZWNJ(font, text, fontSize);
	} else {
		path = font.getPath(text, 0, 0, fontSize);
	}

	const shapes = pathToShapes(path);

	if (shapes.length === 0) {
		return null;
	}

	const extrudeSettings: THREE.ExtrudeGeometryOptions = {
		depth: depth,
		bevelEnabled: bevelEnabled,
		bevelThickness: bevelThickness,
		bevelSize: bevelSize,
		bevelSegments: bevelSegments,
		curveSegments: curveSegments
	};

	const geometry = new THREE.ExtrudeGeometry(shapes, extrudeSettings);

	geometry.computeBoundingBox();
	const center = new THREE.Vector3();
	geometry.boundingBox!.getCenter(center);
	geometry.translate(-center.x, -center.y, -depth / 2);

	return geometry;
}

function pathToShapes(path: PathLike): THREE.Shape[] {
	const shapes: THREE.Shape[] = [];
	const commands = path.commands;

	if (!commands || commands.length === 0) {
		return shapes;
	}

	const contours: PathCommand[][] = [];
	let currentContour: PathCommand[] = [];

	for (let i = 0; i < commands.length; i++) {
		const cmd = commands[i];

		if (cmd.type === 'M') {
			if (currentContour.length > 0) {
				contours.push(currentContour);
			}
			currentContour = [cmd];
		} else {
			currentContour.push(cmd);
		}
	}

	if (currentContour.length > 0) {
		contours.push(currentContour);
	}

	const processedContours: ProcessedContour[] = contours.map(contour => {
		const points: { x: number; y: number }[] = [];
		for (const cmd of contour) {
			if (cmd.x !== undefined && cmd.y !== undefined) {
				points.push({ x: cmd.x, y: cmd.y });
			}
		}
		const area = calculateArea(points);
		return {
			contour,
			area,
			isClockwise: area < 0
		};
	});

	const outerContours: ProcessedContour[] = [];
	const holeContours: ProcessedContour[] = [];

	for (const pc of processedContours) {
		if (pc.isClockwise) {
			outerContours.push(pc);
		} else {
			holeContours.push(pc);
		}
	}

	const sortedForHoles = [...outerContours].sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
	const holeAssignments = new Map<ProcessedContour, ProcessedContour[]>();

	for (const hole of holeContours) {
		const holeBbox = getContourBBox(hole.contour);
		for (const outer of sortedForHoles) {
			const outerBbox = getContourBBox(outer.contour);
			if (bboxContains(outerBbox, holeBbox)) {
				if (!holeAssignments.has(outer)) {
					holeAssignments.set(outer, []);
				}
				holeAssignments.get(outer)!.push(hole);
				break;
			}
		}
	}

	for (const outer of outerContours) {
		const shape = contourToShape(outer.contour);
		if (shape) {
			const holes = holeAssignments.get(outer) || [];
			for (const hole of holes) {
				const holePath = contourToPath(hole.contour);
				if (holePath) {
					shape.holes.push(holePath);
				}
			}
			shapes.push(shape);
		}
	}

	if (shapes.length === 0) {
		for (const pc of processedContours) {
			const shape = contourToShape(pc.contour);
			if (shape) {
				shapes.push(shape);
			}
		}
	}

	return shapes;
}

function contourToShape(contour: PathCommand[]): THREE.Shape | null {
	const shape = new THREE.Shape();
	let hasContent = false;

	for (const cmd of contour) {
		switch (cmd.type) {
			case 'M':
				shape.moveTo(cmd.x!, -cmd.y!);
				hasContent = true;
				break;
			case 'L':
				shape.lineTo(cmd.x!, -cmd.y!);
				break;
			case 'Q':
				shape.quadraticCurveTo(cmd.x1!, -cmd.y1!, cmd.x!, -cmd.y!);
				break;
			case 'C':
				shape.bezierCurveTo(cmd.x1!, -cmd.y1!, cmd.x2!, -cmd.y2!, cmd.x!, -cmd.y!);
				break;
			case 'Z':
				shape.closePath();
				break;
		}
	}

	return hasContent ? shape : null;
}

function contourToPath(contour: PathCommand[]): THREE.Path {
	const path = new THREE.Path();

	for (const cmd of contour) {
		switch (cmd.type) {
			case 'M':
				path.moveTo(cmd.x!, -cmd.y!);
				break;
			case 'L':
				path.lineTo(cmd.x!, -cmd.y!);
				break;
			case 'Q':
				path.quadraticCurveTo(cmd.x1!, -cmd.y1!, cmd.x!, -cmd.y!);
				break;
			case 'C':
				path.bezierCurveTo(cmd.x1!, -cmd.y1!, cmd.x2!, -cmd.y2!, cmd.x!, -cmd.y!);
				break;
			case 'Z':
				path.closePath();
				break;
		}
	}

	return path;
}

function calculateArea(points: { x: number; y: number }[]): number {
	let area = 0;
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += points[i].x * points[j].y;
		area -= points[j].x * points[i].y;
	}
	return area / 2;
}

function getContourBBox(contour: PathCommand[]): ContourBBox {
	let minX = Infinity, minY = Infinity;
	let maxX = -Infinity, maxY = -Infinity;

	for (const cmd of contour) {
		if (cmd.x !== undefined) {
			minX = Math.min(minX, cmd.x);
			maxX = Math.max(maxX, cmd.x);
		}
		if (cmd.y !== undefined) {
			minY = Math.min(minY, -cmd.y);
			maxY = Math.max(maxY, -cmd.y);
		}
		if (cmd.x1 !== undefined) {
			minX = Math.min(minX, cmd.x1);
			maxX = Math.max(maxX, cmd.x1);
		}
		if (cmd.y1 !== undefined) {
			minY = Math.min(minY, -cmd.y1);
			maxY = Math.max(maxY, -cmd.y1);
		}
		if (cmd.x2 !== undefined) {
			minX = Math.min(minX, cmd.x2);
			maxX = Math.max(maxX, cmd.x2);
		}
		if (cmd.y2 !== undefined) {
			minY = Math.min(minY, -cmd.y2);
			maxY = Math.max(maxY, -cmd.y2);
		}
	}

	return { minX, minY, maxX, maxY };
}

function bboxContains(outer: ContourBBox, inner: ContourBBox): boolean {
	return inner.minX >= outer.minX &&
		inner.maxX <= outer.maxX &&
		inner.minY >= outer.minY &&
		inner.maxY <= outer.maxY;
}
