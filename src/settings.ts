// Straight from the types module rather than through the ./annotate barrel:
// that barrel re-exports the toolbar, which imports Obsidian, and this
// module has to stay loadable without an app around it — which is what
// makes it testable.
import { ALL_PRESET_COLORS } from './annotate/types';
import { isVaultPath } from './markdown/inkFence';
import { INK_FILE_LOCATIONS, trimFolder, type InkFileLocation } from './markdown/inkFilePath';
import { CANVAS_MODES, TEMPLATE_STYLES, type CanvasMode, type PageSizeName, type TemplateStyle } from './templates';

export type { PageSizeName };

// Everything the tracks introduced as a constant, made a preference.
//
// Every default here reproduces the behaviour that shipped before this
// existed. A settings tab that changes how the plugin works the moment it
// is added is a settings tab that broke something.

export type SaveCadence = 'auto' | 'frequent';
export type ShapeRecognition = 'off' | 'hold';
export type DarkInversion = 'off' | 'on' | 'follow-theme';
// What holding the side button of a stylus does while it draws: a
// temporary eraser, highlighter or lasso, for that stroke, or nothing.
export type PenButtonAction = 'eraser' | 'highlighter' | 'select' | 'none';
export const PEN_BUTTON_ACTIONS: readonly PenButtonAction[] = ['eraser', 'highlighter', 'select', 'none'];

export interface InklingSettings {
	defaultTemplate: TemplateStyle;
	pageSize: PageSizeName;
	// Which paper the new-note dialog opens on. Pages, so the dialog
	// reads as it always did until someone chooses otherwise.
	defaultCanvasMode: CanvasMode;
	saveCadence: SaveCadence;
	shapeRecognition: ShapeRecognition;
	darkInversion: DarkInversion;
	toolbarStartsCollapsed: boolean;
	penButton: PenButtonAction;
	// Whether an ink block offers a caption to write.
	//
	// Off by default and deliberately so: a block that already has one always
	// shows it, whatever this says — hiding text someone wrote would be worse
	// than showing it — so this governs only whether the affordance to add
	// one appears. Off means every existing block renders exactly as before.
	blockCaptions: boolean;
	// Where a newly inserted ink block's file is created. Changing it never
	// moves a file that exists.
	inkFileLocation: InkFileLocation;
	// The folder used when inkFileLocation is 'folder'.
	inkFileFolder: string;
	extractionNotePattern: string;
	// Colour category names, keyed by lowercase hex — so "Yellow =
	// definition, Red = disagree" works without touching code.
	colorLabels: Record<string, string>;
}

function defaultColorLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const { value, label } of ALL_PRESET_COLORS) labels[value.toLowerCase()] = label;
	return labels;
}

export function defaultSettings(): InklingSettings {
	return {
		defaultTemplate: 'blank',
		pageSize: 'letter',
		defaultCanvasMode: 'pages',
		saveCadence: 'auto',
		shapeRecognition: 'hold',
		// Off, not 'follow-theme'. A scan opens looking like the paper it was
		// scanned from; inverting it is a choice about one unreadable document,
		// not something a dark theme should decide on the reader's behalf. The
		// toolbar's contrast button flips it for the session either way.
		darkInversion: 'off',
		toolbarStartsCollapsed: false,
		// The eraser, as on Samsung's own S Pen: hold the button, rub out,
		// let go and write on.
		penButton: 'eraser',
		blockCaptions: false,
		// Wherever the vault's images already go, so ink lands somewhere
		// sensible without anyone configuring anything.
		inkFileLocation: 'attachments',
		inkFileFolder: 'Ink',
		extractionNotePattern: '{folder}/{name} — annotations.md',
		colorLabels: defaultColorLabels(),
	};
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

// loadData() returns whatever is on disk — hand-edited, written by a future
// version, or absent entirely — so this is the boundary that has to be
// defensive. Every field falls back to its default when missing, wrongly
// typed, or out of range, and unknown keys are dropped rather than carried
// into the rest of the plugin.
export function normalizeSettings(raw: unknown): InklingSettings {
	const defaults = defaultSettings();
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaults;
	const source = raw as Record<string, unknown>;

	const labels = defaultColorLabels();
	const rawLabels = source.colorLabels;
	if (typeof rawLabels === 'object' && rawLabels !== null && !Array.isArray(rawLabels)) {
		for (const [color, label] of Object.entries(rawLabels as Record<string, unknown>)) {
			// Only labels for colours we know about: a stray key would become
			// a category that can never be applied to anything.
			if (typeof label === 'string' && label.trim() && color.toLowerCase() in labels) {
				labels[color.toLowerCase()] = label.trim();
			}
		}
	}

	const pattern = source.extractionNotePattern;
	// A pattern with no {name} in it would put every book's annotations in
	// one file, each run wiping the last. That is not a preference anyone
	// means to express.
	const usablePattern =
		typeof pattern === 'string' && pattern.trim().includes('{name}') ? pattern.trim() : defaults.extractionNotePattern;

	// A folder in the vault, never a hidden one: the Vault API cannot see a
	// dot-folder, and ink that silently stops syncing is the worst failure
	// there is.
	const rawFolder = typeof source.inkFileFolder === 'string' ? trimFolder(source.inkFileFolder.trim()) : '';
	const inkFileFolder = rawFolder && isVaultPath(rawFolder) ? rawFolder : defaults.inkFileFolder;

	return {
		defaultTemplate: pick(source.defaultTemplate, TEMPLATE_STYLES, defaults.defaultTemplate),
		pageSize: pick(source.pageSize, ['letter', 'a4'] as const, defaults.pageSize),
		defaultCanvasMode: pick(source.defaultCanvasMode, CANVAS_MODES, defaults.defaultCanvasMode),
		saveCadence: pick(source.saveCadence, ['auto', 'frequent'] as const, defaults.saveCadence),
		shapeRecognition: pick(source.shapeRecognition, ['off', 'hold'] as const, defaults.shapeRecognition),
		darkInversion: pick(source.darkInversion, ['off', 'on', 'follow-theme'] as const, defaults.darkInversion),
		toolbarStartsCollapsed: bool(source.toolbarStartsCollapsed, defaults.toolbarStartsCollapsed),
		penButton: pick(source.penButton, PEN_BUTTON_ACTIONS, defaults.penButton),
		blockCaptions: bool(source.blockCaptions, defaults.blockCaptions),
		inkFileLocation: pick(source.inkFileLocation, INK_FILE_LOCATIONS, defaults.inkFileLocation),
		inkFileFolder,
		extractionNotePattern: usablePattern,
		colorLabels: labels,
	};
}

// ---- One setting at a time, by key ----
//
// How the settings tab reads and writes: Obsidian's declarative settings
// API names each control by a string key and asks the tab for its value, or
// hands it a new one. Flat fields are keyed by name; a colour's category
// label is `colorLabels.<hex>`, since those live one level down.

const COLOR_LABEL_KEY = 'colorLabels.';

export function colorLabelKey(color: string): string {
	return COLOR_LABEL_KEY + color.toLowerCase();
}

export function readSetting(settings: InklingSettings, key: string): unknown {
	if (key.startsWith(COLOR_LABEL_KEY)) return settings.colorLabels[key.slice(COLOR_LABEL_KEY.length)];
	if (key === 'colorLabels' || !(key in settings)) return undefined;
	return settings[key as keyof InklingSettings];
}

// The settings with one value changed, put through normalizeSettings like
// anything read from disk — so a value no control should be able to send
// still cannot get in. A value it refuses leaves the old one in place rather
// than resetting to the default, and an unknown key changes nothing.
export function writeSetting(settings: InklingSettings, key: string, value: unknown): InklingSettings {
	if (key.startsWith(COLOR_LABEL_KEY)) {
		const color = key.slice(COLOR_LABEL_KEY.length);
		if (!(color in settings.colorLabels)) return settings;
		// Cleared, a label goes back to the colour's own name — not to
		// whatever it was, which would make it impossible to clear.
		const labels = { ...settings.colorLabels, [color]: typeof value === 'string' ? value : '' };
		if (!labels[color]?.trim()) delete labels[color];
		return normalizeSettings({ ...settings, colorLabels: labels });
	}
	if (key === 'colorLabels' || !(key in settings)) return settings;

	const candidate = normalizeSettings({ ...settings, [key]: value });
	const kept = candidate[key as keyof InklingSettings];
	// normalizeSettings answers a refused value with the default, which is
	// right for a file on disk and wrong for a control: picking something
	// invalid should not quietly reset a setting that was fine.
	const accepted =
		kept === value ||
		(typeof value === 'string' && kept === value.trim()) ||
		(key === 'inkFileFolder' && typeof value === 'string' && kept === trimFolder(value.trim()));
	return accepted ? candidate : settings;
}
