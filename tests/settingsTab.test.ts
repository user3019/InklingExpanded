import { describe, expect, it, vi } from 'vitest';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { ALL_PRESET_COLORS } from '../src/annotate/types';
import { defaultSettings, type InklingSettings } from '../src/settings';
import { InklingSettingTab } from '../src/settingsTab';

// The tab describes its settings declaratively (Obsidian 1.13's settings
// API), which is what puts them in Obsidian's settings search. Obsidian
// renders the controls and reads and writes each one by key through
// getControlValue / setControlValue — so those two, and the keys the
// definitions name, are the whole contract.

function openTab(stored: Partial<InklingSettings> = {}) {
	const plugin = {
		settings: { ...defaultSettings(), ...stored },
		saveSettings: vi.fn(async () => {}),
	};
	const tab = new InklingSettingTab({} as never, plugin as never);
	return { tab, plugin };
}

function flatten(items: SettingDefinitionItem[]): SettingDefinition[] {
	return items.flatMap((item) => ('items' in item && item.items ? flatten(item.items) : [item as SettingDefinition]));
}

function controls(tab: InklingSettingTab) {
	return flatten(tab.getSettingDefinitions()).flatMap((def) => (def.control ? [def.control] : []));
}

describe('the settings tab', () => {
	it('offers the ink file folder only when ink files go in a folder', () => {
		const { tab, plugin } = openTab();
		const folder = flatten(tab.getSettingDefinitions()).find((def) => def.control?.key === 'inkFileFolder');
		const visible = folder?.visible;
		if (typeof visible !== 'function') throw new Error('the ink file folder should decide its own visibility');

		expect(visible()).toBe(false);
		plugin.settings.inkFileLocation = 'folder';
		expect(visible()).toBe(true);
	});

	it('describes every setting there is, once', () => {
		const { tab } = openTab();
		const keys = controls(tab).map((c) => c.key);

		const expected = [
			...Object.keys(defaultSettings()).filter((key) => key !== 'colorLabels'),
			...ALL_PRESET_COLORS.map(({ value }) => `colorLabels.${value.toLowerCase()}`),
		];
		expect([...keys].sort()).toEqual([...new Set(expected)].sort());
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('shows what is stored', () => {
		const { tab } = openTab({ pageSize: 'a4', blockCaptions: true, colorLabels: { ...defaultSettings().colorLabels, '#e03131': 'Exam' } });

		expect(tab.getControlValue('pageSize')).toBe('a4');
		expect(tab.getControlValue('blockCaptions')).toBe(true);
		expect(tab.getControlValue('colorLabels.#e03131')).toBe('Exam');
	});

	it('saves a change', async () => {
		const { tab, plugin } = openTab();

		await tab.setControlValue('pageSize', 'a4');

		expect(plugin.settings.pageSize).toBe('a4');
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
	});

	it('changes the settings object the rest of the plugin already holds', async () => {
		const { tab, plugin } = openTab();
		const held = plugin.settings;

		await tab.setControlValue('blockCaptions', true);

		expect(held.blockCaptions).toBe(true);
	});

	it('refuses a value no option offers', async () => {
		const { tab, plugin } = openTab({ darkInversion: 'on' });

		await tab.setControlValue('darkInversion', 'sideways');

		expect(plugin.settings.darkInversion).toBe('on');
	});

	it('names a colour, and puts its own name back when the name is cleared', async () => {
		const { tab, plugin } = openTab();

		await tab.setControlValue('colorLabels.#e03131', 'Definitions');
		expect(plugin.settings.colorLabels['#e03131']).toBe('Definitions');

		await tab.setControlValue('colorLabels.#e03131', '   ');
		expect(plugin.settings.colorLabels['#e03131']).toBe(defaultSettings().colorLabels['#e03131']);
	});

	it('ignores a key it does not know', async () => {
		const { tab, plugin } = openTab();
		const before = structuredClone(plugin.settings);

		await tab.setControlValue('somethingElse', 'x');

		expect(plugin.settings).toEqual(before);
	});

	it('says why an extraction path without {name} cannot be used', async () => {
		const { tab } = openTab();
		const pattern = controls(tab).find((c) => c.key === 'extractionNotePattern');

		expect(await pattern?.validate?.('{folder}/annotations.md' as never)).toMatch(/\{name\}/);
		expect(await pattern?.validate?.('{folder}/{name} notes.md' as never)).toBeFalsy();
	});
});
