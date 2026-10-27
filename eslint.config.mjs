// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['widgets/**/*.js', 'widgets/**/*.mjs', 'website/**', 'node_modules/**', '.homeybuild/**', 'coverage/**', 'eslint.config.mjs'],
	},
	{
		files: ['**/*.mts'],
		extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.test.json',
				sourceType: 'module',
			},
		},
		rules: {
			'no-unused-vars': 'off', // Disable the base rule as it can report incorrect errors
			'@typescript-eslint/no-unused-vars': [
				// Error on unused variables
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/explicit-function-return-type': 'error', // Enforce explicit return type
			'@typescript-eslint/no-floating-promises': 'error', // Enforce awaiting async functions,
			'@typescript-eslint/no-explicit-any': 'warn', // Warn on explicit any
			indent: ['error', 'tab', { SwitchCase: 1 }],
			'@typescript-eslint/naming-convention': 'error', // Enforce naming conventions
		},
	},
);
