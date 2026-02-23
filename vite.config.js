import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import yaml from '@modyfi/vite-plugin-yaml';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
let gitHash = '';
try {
	gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

export default defineConfig({
	plugins: [sveltekit(), yaml()],
	define: {
		__BUILD_DATE__: JSON.stringify(new Date().toISOString()),
		__VERSION__: JSON.stringify(pkg.version),
		__GIT_HASH__: JSON.stringify(gitHash)
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes('node_modules/three')) return 'three';
					if (id.includes('node_modules/troika') || id.includes('node_modules/opentype')) return 'troika';
				}
			}
		}
	}
});
