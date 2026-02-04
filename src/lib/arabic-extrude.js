import * as THREE from 'three';
import opentype from 'opentype.js';

// Cache for loaded fonts
const fontCache = new Map();
let fontLoadPromise = null;

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

	// Get the full path for the text (opentype handles Arabic shaping internally)
	const path = font.getPath(text, 0, 0, fontSize);

	// Get bounding box for centering
	const bbox = path.getBoundingBox();
	const textWidth = bbox.x2 - bbox.x1;
	const textHeight = bbox.y2 - bbox.y1;

	// Convert the full path to shapes
	// For complex scripts, we need to handle the path as a whole
	const shapes = pathToShapes(path);

	if (shapes.length === 0) {
		console.warn('No shapes generated for text:', text);
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

	// Separate into outer shapes (clockwise after Y-flip) and potential holes (counter-clockwise)
	// Dots are small clockwise contours - do NOT filter by area
	const outerContours = [];
	const holeContours = [];

	for (const pc of processedContours) {
		// After Y-flip: clockwise = filled shapes (letters + dots), counter-clockwise = holes
		if (pc.isClockwise) {
			outerContours.push(pc);
		} else {
			holeContours.push(pc);
		}
	}

	// Sort outer contours by area (largest first) for hole assignment
	outerContours.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

	// Create shapes from all outer contours (including small dots)
	for (const outer of outerContours) {
		const shape = contourToShape(outer.contour);
		if (shape) {
			// Find holes that belong to this shape (counter-clockwise contours inside this one)
			const bbox = getContourBBox(outer.contour);
			for (const hole of holeContours) {
				const holeBbox = getContourBBox(hole.contour);
				if (bboxContains(bbox, holeBbox)) {
					const holePath = contourToPath(hole.contour);
					if (holePath) {
						shape.holes.push(holePath);
					}
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
