import * as THREE from 'three';
import opentype from 'opentype.js';

// Cache for loaded fonts
const fontCache = new Map();
let fontLoadPromise = null;

/**
 * Handle text with ZWNJ by processing segments with correct RTL positioning
 * OpenType.js has bidi issues with ZWNJ that cause segments to appear in wrong order
 */
function getPathWithZWNJ(font, text, fontSize) {
	// Split at ZWNJ while keeping track of positions
	const segments = text.split('\u200C');

	// For RTL: calculate total width first, then position segments right-to-left
	const segmentPaths = segments.map(seg => ({
		text: seg,
		path: font.getPath(seg, 0, 0, fontSize),
	}));

	// Calculate widths
	segmentPaths.forEach(sp => {
		const bbox = sp.path.getBoundingBox();
		sp.width = bbox.x2 - bbox.x1;
		sp.bbox = bbox;
	});

	// Total width (sum of all segments)
	const totalWidth = segmentPaths.reduce((sum, sp) => sum + sp.width, 0);

	// Position segments RTL: first segment on right, subsequent to the left
	// Start from right edge (totalWidth) and work left
	let xPos = totalWidth;

	// Combine all commands with adjusted X positions
	const combinedCommands = [];

	for (const sp of segmentPaths) {
		// Position this segment: its right edge should be at xPos
		const offsetX = xPos - sp.bbox.x2;

		for (const cmd of sp.path.commands) {
			const newCmd = { ...cmd };
			if (newCmd.x !== undefined) newCmd.x += offsetX;
			if (newCmd.x1 !== undefined) newCmd.x1 += offsetX;
			if (newCmd.x2 !== undefined) newCmd.x2 += offsetX;
			combinedCommands.push(newCmd);
		}

		// Move left for next segment
		xPos -= sp.width;
	}

	// Return a path-like object with combined commands
	return {
		commands: combinedCommands,
		getBoundingBox: () => {
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

/**
 * Load an OpenType font from URL
 */
export async function loadFont(url) {
	if (fontCache.has(url)) {
		return fontCache.get(url);
	}

	if (fontLoadPromise) {
		return fontLoadPromise;
	}

	fontLoadPromise = new Promise((resolve, reject) => {
		opentype.load(url, (err, font) => {
			if (err) {
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

/**
 * Convert an OpenType path to a Three.js Shape
 * OpenType uses a different coordinate system and command format
 */
function pathToShape(path, scale, offsetX, offsetY) {
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
			case 'M': // moveTo
				shape.moveTo(x, y);
				break;
			case 'L': // lineTo
				shape.lineTo(x, y);
				break;
			case 'Q': // quadratic curve
				shape.quadraticCurveTo(
					cmd.x1 * scale + offsetX,
					cmd.y1 * scale + offsetY,
					x, y
				);
				break;
			case 'C': // cubic bezier
				shape.bezierCurveTo(
					cmd.x1 * scale + offsetX,
					cmd.y1 * scale + offsetY,
					cmd.x2 * scale + offsetX,
					cmd.y2 * scale + offsetY,
					x, y
				);
				break;
			case 'Z': // closePath
				shape.closePath();
				break;
		}
	}

	return shape;
}

/**
 * Create extruded 3D text geometry for Arabic/RTL text
 * Uses opentype.js for proper text shaping
 */
export function createArabicExtrudedText(font, text, fontSize, depth, options = {}) {
	const {
		bevelEnabled = true,
		bevelThickness = fontSize * 0.05,
		bevelSize = fontSize * 0.04,
		bevelSegments = 3,
		curveSegments = 6
	} = options;

	// Scale factor: opentype uses font units, we want pixels
	const scale = fontSize / font.unitsPerEm;

	// Handle ZWNJ: OpenType.js has bidi issues with ZWNJ, so we process segments
	// and combine them with correct RTL positioning
	let path;
	if (text.includes('\u200C')) {
		path = getPathWithZWNJ(font, text, fontSize);
	} else {
		path = font.getPath(text, 0, 0, fontSize);
	}

	// Convert the full path to shapes
	const shapes = pathToShapes(path);

	if (shapes.length === 0) {
		return null;
	}

	// Create extrude geometry from all shapes
	const extrudeSettings = {
		depth: depth,
		bevelEnabled: bevelEnabled,
		bevelThickness: bevelThickness,
		bevelSize: bevelSize,
		bevelSegments: bevelSegments,
		curveSegments: curveSegments
	};

	const geometry = new THREE.ExtrudeGeometry(shapes, extrudeSettings);

	// Center the geometry
	geometry.computeBoundingBox();
	const center = new THREE.Vector3();
	geometry.boundingBox.getCenter(center);
	geometry.translate(-center.x, -center.y, -depth / 2);

	return geometry;
}

/**
 * Convert OpenType path to array of Three.js Shapes
 * Handles multiple contours (separate shapes/holes)
 */
function pathToShapes(path) {
	const shapes = [];
	const commands = path.commands;

	if (!commands || commands.length === 0) {
		return shapes;
	}

	let currentShape = null;
	let currentPath = null;
	let contours = [];
	let currentContour = [];

	// First, split into contours
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

	// Convert contours to shapes
	// Determine which contours are outer shapes vs holes by winding direction
	const processedContours = contours.map(contour => {
		const points = [];
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

	// Separate into outer shapes (clockwise after Y-flip) and potential holes
	// Dots are small outer contours - do NOT filter by area
	const outerContours = [];
	const holeContours = [];

	for (const pc of processedContours) {
		// After Y-flip: clockwise = filled shapes, counter-clockwise = holes
		if (pc.isClockwise) {
			outerContours.push(pc);
		} else {
			holeContours.push(pc);
		}
	}

	// Create a lookup for hole assignment (sorted by area, largest first)
	const sortedForHoles = [...outerContours].sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
	const holeAssignments = new Map();

	// Assign holes to their containing shapes (largest shape wins)
	for (const hole of holeContours) {
		const holeBbox = getContourBBox(hole.contour);
		for (const outer of sortedForHoles) {
			const outerBbox = getContourBBox(outer.contour);
			if (bboxContains(outerBbox, holeBbox)) {
				if (!holeAssignments.has(outer)) {
					holeAssignments.set(outer, []);
				}
				holeAssignments.get(outer).push(hole);
				break; // Assign to first (largest) containing shape
			}
		}
	}

	// Create shapes preserving original contour order (important for text layout)
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

	// If no outer contours found, treat all as shapes (fallback)
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

function contourToShape(contour) {
	const shape = new THREE.Shape();
	let hasContent = false;

	// Flip Y axis (OpenType Y goes up, we need to invert for correct orientation)
	for (const cmd of contour) {
		switch (cmd.type) {
			case 'M':
				shape.moveTo(cmd.x, -cmd.y);
				hasContent = true;
				break;
			case 'L':
				shape.lineTo(cmd.x, -cmd.y);
				break;
			case 'Q':
				shape.quadraticCurveTo(cmd.x1, -cmd.y1, cmd.x, -cmd.y);
				break;
			case 'C':
				shape.bezierCurveTo(cmd.x1, -cmd.y1, cmd.x2, -cmd.y2, cmd.x, -cmd.y);
				break;
			case 'Z':
				shape.closePath();
				break;
		}
	}

	return hasContent ? shape : null;
}

function contourToPath(contour) {
	const path = new THREE.Path();

	// Flip Y axis to match contourToShape
	for (const cmd of contour) {
		switch (cmd.type) {
			case 'M':
				path.moveTo(cmd.x, -cmd.y);
				break;
			case 'L':
				path.lineTo(cmd.x, -cmd.y);
				break;
			case 'Q':
				path.quadraticCurveTo(cmd.x1, -cmd.y1, cmd.x, -cmd.y);
				break;
			case 'C':
				path.bezierCurveTo(cmd.x1, -cmd.y1, cmd.x2, -cmd.y2, cmd.x, -cmd.y);
				break;
			case 'Z':
				path.closePath();
				break;
		}
	}

	return path;
}

function calculateArea(points) {
	let area = 0;
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const j = (i + 1) % n;
		area += points[i].x * points[j].y;
		area -= points[j].x * points[i].y;
	}
	return area / 2;
}

function getContourBBox(contour) {
	let minX = Infinity, minY = Infinity;
	let maxX = -Infinity, maxY = -Infinity;

	// Use flipped Y for consistency with shape creation
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

function bboxContains(outer, inner) {
	return inner.minX >= outer.minX &&
		inner.maxX <= outer.maxX &&
		inner.minY >= outer.minY &&
		inner.maxY <= outer.maxY;
}
