import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import yaml from '@modyfi/vite-plugin-yaml';

export default defineConfig({
	plugins: [sveltekit(), yaml()],
	define: {
		__BUILD_DATE__: JSON.stringify(new Date().toISOString())
	}
});
