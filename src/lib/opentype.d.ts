declare module 'opentype.js' {
	interface PathCommand {
		type: 'M' | 'L' | 'Q' | 'C' | 'Z';
		x?: number;
		y?: number;
		x1?: number;
		y1?: number;
		x2?: number;
		y2?: number;
	}

	interface BoundingBox {
		x1: number;
		y1: number;
		x2: number;
		y2: number;
	}

	interface Path {
		commands: PathCommand[];
		getBoundingBox(): BoundingBox;
	}

	interface Font {
		unitsPerEm: number;
		getPath(text: string, x: number, y: number, fontSize: number): Path;
	}

	function load(
		url: string,
		callback: (err: Error | null, font?: Font) => void
	): void;

	export default { load };
	export { Font, Path, PathCommand, BoundingBox };
}
