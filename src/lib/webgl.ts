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

export interface DebugStats {
	fps: number;
	laneCount: number;
	rendererInfo: string;
	flySpeed?: number;
	cameraPos?: string;
	invaderScore?: number;
	invaderLives?: number;
	invaderHighScore?: number;
	invaderGameOver?: boolean;
}
