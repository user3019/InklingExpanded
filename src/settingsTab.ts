import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from 'obsidian';
import { ALL_PRESET_COLORS } from './annotate';
import { CANVAS_MODES, CANVAS_MODE_LABELS, TEMPLATE_STYLES, TEMPLATE_STYLE_LABELS } from './templates';
import { colorLabelKey, defaultSettings, readSetting, writeSetting, type InklingSettings } from './settings';

// The Obsidian-facing half of the settings. The pure half — the shape,
// the defaults, the defensive read of whatever loadData() returns, and
// reading or writing one setting by key — lives in ./settings so it can be
// tested without standing up an app.
export interface SettingsHost extends Plugin {
	settings: InklingSettings;
	saveSettings(): Promise<void>;
}

// Described declaratively, with Obsidian 1.13's settings API: the tab says
// what its settings are and Obsidian draws them, which is also what puts
// every one of them in Obsidian's settings search. minAppVersion is 1.13.0
// for this; an older app would load the plugin with an empty tab.
export class InklingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: SettingsHost,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const defaults = defaultSettings();

		return [
			{
				type: 'group',
				heading: 'New handwritten notes',
				items: [
					{
						name: 'Paper',
						desc: 'Pages of a fixed size, or one infinite canvas that grows as you write.',
						aliases: ['infinite', 'canvas', 'whiteboard'],
						control: {
							type: 'dropdown',
							key: 'defaultCanvasMode',
							defaultValue: defaults.defaultCanvasMode,
							options: Object.fromEntries(CANVAS_MODES.map((mode) => [mode, CANVAS_MODE_LABELS[mode]])),
						},
					},
					{
						name: 'Background',
						desc: 'Blank, lined or dot grid. The new-note dialog opens on this; you can still pick another there.',
						aliases: ['template', 'ruling'],
						control: {
							type: 'dropdown',
							key: 'defaultTemplate',
							defaultValue: defaults.defaultTemplate,
							options: Object.fromEntries(TEMPLATE_STYLES.map((style) => [style, TEMPLATE_STYLE_LABELS[style]])),
						},
					},
					{
						name: 'Page size',
						desc: 'For new notes made of pages, and for pages added to them.',
						control: { type: 'dropdown', key: 'pageSize', defaultValue: defaults.pageSize, options: { letter: 'Letter', a4: 'A4' } },
					},
				],
			},
			{
				type: 'group',
				heading: 'Pen and stylus',
				items: [
					{
						name: 'Stylus side button',
						desc: 'What holding the side button does — S Pen and most Android, Windows and Wacom pens. Letting go gives the tool you had back. On Android, press it with the pen just above the screen, then touch down. An eraser end always erases. Apple Pencil’s gestures are not available to apps here.',
						aliases: ['s pen', 'barrel', 'eraser', 'stylus button'],
						control: {
							type: 'dropdown',
							key: 'penButton',
							defaultValue: defaults.penButton,
							options: { eraser: 'Erase', highlighter: 'Highlight', select: 'Lasso', none: 'Nothing' },
						},
					},
					{
						name: 'Shape recognition',
						desc: 'Hold the pen still at the end of a stroke to turn a rough line, box or circle into a clean one.',
						control: {
							type: 'dropdown',
							key: 'shapeRecognition',
							defaultValue: defaults.shapeRecognition,
							options: { hold: 'Hold to snap', off: 'Off' },
						},
					},
					{
						name: 'Pens, pressure and drawing with a finger',
						desc: 'Set in the toolbar and kept for each device: press the pen again for the round or sharp pen and its pressure switch, and use the finger button on a touch screen.',
					},
				],
			},
			{
				type: 'group',
				heading: 'PDFs',
				items: [
					{
						name: 'Dark pages',
						desc: 'Darken PDF pages in a dark theme, keeping ink readable. The toolbar’s contrast button flips one document either way.',
						aliases: ['dark mode', 'night', 'invert'],
						control: {
							type: 'dropdown',
							key: 'darkInversion',
							defaultValue: defaults.darkInversion,
							options: { off: 'Never', 'follow-theme': 'Follow theme', on: 'Always' },
						},
					},
					{
						name: 'Saving',
						desc: 'Automatic saves large textbooks less often. Frequent saves every ten seconds whatever the size.',
						control: { type: 'dropdown', key: 'saveCadence', defaultValue: defaults.saveCadence, options: { auto: 'Automatic', frequent: 'Frequent' } },
					},
					{
						name: 'Start with the toolbar collapsed',
						desc: 'Leaves more of a phone’s screen for the page.',
						control: { type: 'toggle', key: 'toolbarStartsCollapsed', defaultValue: defaults.toolbarStartsCollapsed },
					},
				],
			},
			{
				type: 'group',
				heading: 'Ink blocks in notes',
				items: [
					{
						name: 'Captions',
						desc: 'A line under each block for a short description, which search and screen readers can use. A caption already written always shows.',
						control: { type: 'toggle', key: 'blockCaptions', defaultValue: defaults.blockCaptions },
					},
					{
						name: 'Where ink files go',
						desc: 'Each note keeps its blocks’ drawings in one .ink file. Changing this never moves an existing file.',
						aliases: ['ink file', 'attachments'],
						control: {
							type: 'dropdown',
							key: 'inkFileLocation',
							defaultValue: defaults.inkFileLocation,
							options: { attachments: 'With attachments', 'beside-note': 'Beside the note', folder: 'In a folder of their own' },
						},
					},
					{
						name: 'Ink file folder',
						desc: 'Exclude it under Files and links to keep ink files out of search and the graph.',
						visible: () => this.plugin.settings.inkFileLocation === 'folder',
						control: { type: 'folder', key: 'inkFileFolder', defaultValue: defaults.inkFileFolder, placeholder: defaults.inkFileFolder },
					},
				],
			},
			{
				type: 'group',
				heading: 'Extracting annotations',
				items: [
					{
						name: 'Note path',
						desc: 'Where an extracted note goes. {folder} and {name} come from the PDF; {name} is required.',
						control: {
							type: 'text',
							key: 'extractionNotePattern',
							defaultValue: defaults.extractionNotePattern,
							placeholder: defaults.extractionNotePattern,
							// Refused rather than saved: a path with no {name} would
							// put every book's annotations in one file, each run
							// wiping the last.
							validate: (value) => (value.includes('{name}') ? undefined : 'Must contain {name}, or every PDF would share one note.'),
						},
					},
					{
						name: 'What each colour means',
						desc: 'For pen and highlighter alike. They become the headings of an extracted note.',
					},
					...ALL_PRESET_COLORS.map(({ value, label }) => ({
						name: label,
						aliases: [value],
						control: { type: 'text' as const, key: colorLabelKey(value), defaultValue: label, placeholder: label },
					})),
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return readSetting(this.plugin.settings, key);
	}

	// In place: the views, commands and ink blocks each hold a getter over
	// this one object, so replacing it would leave them reading the old one.
	async setControlValue(key: string, value: unknown): Promise<void> {
		Object.assign(this.plugin.settings, writeSetting(this.plugin.settings, key, value));
		await this.plugin.saveSettings();
		// The folder setting shows only for one location.
		if (key === 'inkFileLocation') this.refreshDomState();
	}
}
