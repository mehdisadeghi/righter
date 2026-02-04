import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: null,
			precompress: false,
			strict: true
		}),
		paths: {
			// Set via BASE_PATH env var for subpath hosting: make build BASE=/righter
			base: process.env.BASE_PATH || ''
		}
	}
};

export default config;
