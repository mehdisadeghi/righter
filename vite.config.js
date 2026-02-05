import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import yaml from '@modyfi/vite-plugin-yaml';

export default defineConfig({
	plugins: [sveltekit(), yaml()],
	define: {
		__BUILD_DATE__: JSON.stringify(new Date().toISOString())
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
