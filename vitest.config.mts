import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['**/*.test.mts'],
		exclude: ['node_modules/**', '.homeybuild/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['**/*.mts'],
			exclude: [
				'**/*.test.mts',
				'node_modules/**',
				'.homeybuild/**',
				'website/**',
				'vitest.config.mts',
				'test/**',
			],
		},
	},
});
