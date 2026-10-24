import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'pdf.worker.js',
		// Bundled build output, like the two above it — added when the
		// annotation writer moved into its own worker.
		'annotation-writer.worker.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The plugin's own name, one word with two capitals, which the rule
		// would otherwise lower to "Inklingexpanded". The recommended
		// setting, with the name added to the rule's own list of brands —
		// a list given here replaces that one, so it is extended, not swapped.
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', { enforceCamelCaseLower: true, brands: [...DEFAULT_BRANDS, 'InklingExpanded'] }],
		},
	},
	{
		// The obsidianmd rules encode constraints of the Obsidian *runtime* —
		// use createDiv() rather than document.createElement, prefer the
		// active window to globalThis. Tests run in Node, where none of those
		// helpers exist and globalThis is the only window there is, so the
		// rules would be asking test code to call functions that are not
		// there. The plugin's own sources are still held to all of them.
		files: ['tests/**/*.ts'],
		rules: {
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/no-global-this': 'off',
			// Same reasoning, one rule further on. The harness has to build
			// the scrolling ancestor an IntersectionObserver roots itself at,
			// and a stylesheet is exactly what a test running in Node does not
			// have — the rule is about theming the user's app, which is not
			// what this DOM is.
			'obsidianmd/no-static-styles-assignment': 'off',
			// And the same reasoning again. The rule is about what may ship to
			// a mobile device; tests run in Node and never do. Reading a real
			// library off disk is the whole point of
			// tests/pdf/vaultLibrary.test.ts, and there is no Vault to read it
			// through from a test runner.
			'obsidianmd/no-nodejs-modules': 'off',
		},
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
);
