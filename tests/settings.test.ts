import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/settings';

// loadData() returns whatever is on disk — hand-edited, written by a future
// version of the plugin, or absent entirely — so this is the boundary that
// has to be defensive. None of it may throw, and nothing unrecognised may
// reach the rest of the plugin.
describe('normalizeSettings', () => {
	it('produces the defaults from nothing at all', () => {
		expect(normalizeSettings(undefined)).toEqual(defaultSettings());
		expect(normalizeSettings(null)).toEqual(defaultSettings());
		expect(normalizeSettings({})).toEqual(defaultSettings());
	});

	it('produces the defaults from something that is not settings', () => {
		expect(normalizeSettings('nonsense')).toEqual(defaultSettings());
		expect(normalizeSettings(42)).toEqual(defaultSettings());
		expect(normalizeSettings([1, 2, 3])).toEqual(defaultSettings());
	});

	it('keeps values it recognises', () => {
		const settings = normalizeSettings({
			defaultTemplate: 'dot-grid',
			pageSize: 'a4',
			saveCadence: 'frequent',
			blockCaptions: true,
			shapeRecognition: 'off',
			darkInversion: 'on',
			toolbarStartsCollapsed: true,
		});
		expect(settings.defaultTemplate).toBe('dot-grid');
		expect(settings.pageSize).toBe('a4');
		expect(settings.saveCadence).toBe('frequent');
		expect(settings.blockCaptions).toBe(true);
		expect(settings.shapeRecognition).toBe('off');
		expect(settings.darkInversion).toBe('on');
		expect(settings.toolbarStartsCollapsed).toBe(true);
	});

	it('falls back for a value outside the allowed set', () => {
		const settings = normalizeSettings({ defaultTemplate: 'graph-paper', darkInversion: 'maybe', pageSize: 'legal' });
		expect(settings.defaultTemplate).toBe('blank');
		expect(settings.darkInversion).toBe('off');
		expect(settings.pageSize).toBe('letter');
	});

	it('opens a PDF looking like the paper it came from', () => {
		// This followed the theme, so a dark theme inverted every scan
		// without being asked and there was no way to see one as printed
		// short of changing a setting. Inverting is an answer to one
		// unreadable document, so it belongs on the toolbar button, which
		// flips it for the session either way.
		expect(defaultSettings().darkInversion).toBe('off');
	});

	it('falls back for a value of the wrong type', () => {
		const settings = normalizeSettings({ blockCaptions: 'yes', toolbarStartsCollapsed: 1, defaultTemplate: 7 });
		expect(settings.blockCaptions).toBe(false);
		expect(settings.toolbarStartsCollapsed).toBe(false);
		expect(settings.defaultTemplate).toBe('blank');
	});

	it('drops keys it does not know', () => {
		// `pressure` and `smoothing` included: both were settings once — the
		// one is a per-pen switch in the pen picker now, the other was never
		// wired to anything — so a data.json from before carries them.
		const settings = normalizeSettings({ blockCaptions: true, pressure: false, smoothing: false, somethingFromTheFuture: { deeply: 'nested' } });
		expect(settings).toEqual({ ...defaultSettings(), blockCaptions: true });
	});

	it('refuses an extraction pattern that would collapse every book into one note', () => {
		// Each run would wipe the last. Nobody means to express that.
		expect(normalizeSettings({ extractionNotePattern: 'Annotations.md' }).extractionNotePattern).toBe(
			defaultSettings().extractionNotePattern,
		);
		expect(normalizeSettings({ extractionNotePattern: '   ' }).extractionNotePattern).toBe(
			defaultSettings().extractionNotePattern,
		);
	});

	it('keeps an extraction pattern that names the book', () => {
		expect(normalizeSettings({ extractionNotePattern: 'Reading/{name}.md' }).extractionNotePattern).toBe('Reading/{name}.md');
	});

	it('accepts a renamed colour category', () => {
		const settings = normalizeSettings({ colorLabels: { '#e03131': 'Disagree' } });
		expect(settings.colorLabels['#e03131']).toBe('Disagree');
		// The ones not mentioned keep their names rather than vanishing.
		expect(settings.colorLabels['#2f9e44']).toBe('Green');
	});

	it('matches a colour category whatever case it was stored in', () => {
		expect(normalizeSettings({ colorLabels: { '#E03131': 'Disagree' } }).colorLabels['#e03131']).toBe('Disagree');
	});

	it('ignores a label for a colour that is not in the palette', () => {
		// It would become a category nothing could ever be filed under.
		const settings = normalizeSettings({ colorLabels: { '#abcdef': 'Ghost' } });
		expect(settings.colorLabels['#abcdef']).toBeUndefined();
	});

	it('ignores an empty or non-string label', () => {
		const settings = normalizeSettings({ colorLabels: { '#e03131': '   ', '#2f9e44': 5 } });
		expect(settings.colorLabels['#e03131']).toBe('Red');
		expect(settings.colorLabels['#2f9e44']).toBe('Green');
	});

	it('never returns the same object twice, so one vault cannot edit another’s defaults', () => {
		const first = normalizeSettings({});
		const second = normalizeSettings({});
		first.colorLabels['#e03131'] = 'Changed';
		expect(second.colorLabels['#e03131']).toBe('Red');
	});

	it('puts new ink files with attachments unless told otherwise', () => {
		expect(defaultSettings().inkFileLocation).toBe('attachments');
		expect(defaultSettings().inkFileFolder).toBe('Ink');
	});

	it('keeps an ink file location and folder it recognises', () => {
		const settings = normalizeSettings({ inkFileLocation: 'folder', inkFileFolder: 'Blocks/Ink' });
		expect(settings.inkFileLocation).toBe('folder');
		expect(settings.inkFileFolder).toBe('Blocks/Ink');
	});

	it('refuses an ink file folder that is not a folder in the vault', () => {
		expect(normalizeSettings({ inkFileFolder: '.inkling' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileFolder: '../outside' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileFolder: '' }).inkFileFolder).toBe('Ink');
		expect(normalizeSettings({ inkFileLocation: 'cloud' }).inkFileLocation).toBe('attachments');
	});

	it('takes a folder with slashes around it as the folder', () => {
		expect(normalizeSettings({ inkFileFolder: '/Ink/' }).inkFileFolder).toBe('Ink');
	});
});

describe('block captions', () => {
	it('are off until asked for', () => {
		// A setting that changes how the plugin works the moment it is added
		// is a setting that broke something. Every block in the vault renders
		// exactly as it did before this existed.
		expect(defaultSettings().blockCaptions).toBe(false);
	});

	it('fall back to off when the stored value is not a boolean', () => {
		expect(normalizeSettings({ blockCaptions: 'yes' }).blockCaptions).toBe(false);
	});

	it('are kept when they were turned on', () => {
		expect(normalizeSettings({ blockCaptions: true }).blockCaptions).toBe(true);
	});
});
