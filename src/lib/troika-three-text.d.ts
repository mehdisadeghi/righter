declare module 'troika-three-text' {
	import { Color, Mesh } from 'three';

	export class Text extends Mesh {
		text: string;
		fontSize: number;
		font: string | undefined;
		anchorX: 'left' | 'center' | 'right' | number;
		anchorY: 'top' | 'top-baseline' | 'middle' | 'bottom-baseline' | 'bottom' | number;
		direction: 'auto' | 'ltr' | 'rtl';

		color: Color | string | number;
		fillOpacity: number;

		outlineWidth: number | string;
		outlineColor: Color | string | number;
		outlineOpacity: number;
		outlineBlur: number | string;

		strokeWidth: number;
		strokeColor: Color | string | number;
		strokeOpacity: number;

		sync(callback?: () => void): void;
		dispose(): void;
	}
}
