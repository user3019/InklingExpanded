import type { ToolType } from './types';

// Which controls the tool strip shows, and in what order.
//
// Kept per device rather than in the plugin's synced settings: a phone in
// portrait and a desktop with a mouse want different strips — the phone
// wants its six most-used tools and nothing else, the desktop has room for
// everything — and a layout that followed the vault from one to the other
// would be wrong on one of them. See main.ts for where it is stored.
//
// Pure data, and nothing here imports Obsidian, so the rules for reading
// back a stored layout can be tested without an app around them.

export type ToolbarItemId =
	| ToolType
	| 'touch-draw'
	| 'colors'
	| 'width'
	| 'undo'
	| 'redo'
	| 'delete'
	| 'clear-page'
	| 'add-page'
	| 'background'
	| 'import'
	| 'invert'
	| 'outline'
	| 'page'
	| 'zoom'
	| 'spacer'
	| 'separator-1'
	| 'separator-2'
	| 'separator-3'
	| 'separator-4';

export interface ToolbarItemSpec {
	id: ToolbarItemId;
	// What the item is called in the layout editor, and the tooltip of the
	// button where the item is one.
	label: string;
	icon: string;
	fallback: string;
}

// Every item, in the order the strip had before it could be rearranged —
// which is also the default layout, so an untouched device looks exactly
// as it always did.
export const TOOLBAR_ITEMS: readonly ToolbarItemSpec[] = [
	{ id: 'select', label: 'Select / lasso', icon: 'lasso', fallback: '⇖' },
	{ id: 'pen', label: 'Pen', icon: 'pencil', fallback: '✏️' },
	{ id: 'highlighter', label: 'Highlighter', icon: 'highlighter', fallback: '🖊️' },
	{ id: 'eraser', label: 'Eraser', icon: 'eraser', fallback: '⌫' },
	{ id: 'note', label: 'Note', icon: 'message-square', fallback: '🗨' },
	{ id: 'line', label: 'Line', icon: 'minus', fallback: '╱' },
	{ id: 'rectangle', label: 'Rectangle', icon: 'square', fallback: '▭' },
	{ id: 'oval', label: 'Oval', icon: 'circle', fallback: '◯' },
	{ id: 'arrow', label: 'Arrow', icon: 'arrow-up-right', fallback: '↗' },
	// Whether a finger draws. Shown only on a screen that takes touch.
	{ id: 'touch-draw', label: 'Draw with finger', icon: 'pointer', fallback: '☝' },
	{ id: 'separator-1', label: 'Divider', icon: 'separator-vertical', fallback: '|' },
	{ id: 'colors', label: 'Colors', icon: 'palette', fallback: '●' },
	{ id: 'separator-2', label: 'Divider', icon: 'separator-vertical', fallback: '|' },
	{ id: 'width', label: 'Stroke width', icon: 'move-horizontal', fallback: '↔' },
	{ id: 'separator-3', label: 'Divider', icon: 'separator-vertical', fallback: '|' },
	{ id: 'undo', label: 'Undo', icon: 'undo', fallback: '↶' },
	{ id: 'redo', label: 'Redo', icon: 'redo', fallback: '↷' },
	{ id: 'separator-4', label: 'Divider', icon: 'separator-vertical', fallback: '|' },
	{ id: 'delete', label: 'Delete selection', icon: 'trash-2', fallback: '␡' },
	{ id: 'clear-page', label: 'Clear page', icon: 'file-x', fallback: '⌧' },
	{ id: 'add-page', label: 'Add page', icon: 'file-plus', fallback: '＋' },
	// Blank, lined or dot grid, for the page in view or every page.
	{ id: 'background', label: 'Page background', icon: 'layout-grid', fallback: '▦' },
	{ id: 'import', label: 'Import a PDF or picture', icon: 'image-plus', fallback: '⤓' },
	{ id: 'invert', label: 'Invert page', icon: 'contrast', fallback: '◐' },
	{ id: 'outline', label: 'Outline and find', icon: 'panel-left', fallback: '☰' },
	// Pushes everything after it to the far end of the strip, which is
	// where the readouts used to sit by fixed rule.
	{ id: 'spacer', label: 'Push the rest to the right', icon: 'move-right', fallback: '⇥' },
	{ id: 'page', label: 'Page number', icon: 'hash', fallback: '#' },
	{ id: 'zoom', label: 'Zoom', icon: 'zoom-in', fallback: '+' },
];

const KNOWN_IDS: ReadonlySet<string> = new Set(TOOLBAR_ITEMS.map((item) => item.id));

export function toolbarItemSpec(id: ToolbarItemId): ToolbarItemSpec {
	// Every id is in the table, by construction of the type.
	return TOOLBAR_ITEMS.find((item) => item.id === id) as ToolbarItemSpec;
}

export interface ToolbarLayout {
	// Every item exactly once, in display order.
	order: ToolbarItemId[];
	// Items left out of the strip. Still in `order`, so showing one again
	// puts it back where it was rather than at the end.
	hidden: ToolbarItemId[];
}

export function defaultToolbarLayout(): ToolbarLayout {
	return { order: TOOLBAR_ITEMS.map((item) => item.id), hidden: [] };
}

function knownIds(value: unknown): ToolbarItemId[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const ids: ToolbarItemId[] = [];
	for (const entry of value) {
		if (typeof entry !== 'string' || !KNOWN_IDS.has(entry) || seen.has(entry)) continue;
		seen.add(entry);
		ids.push(entry as ToolbarItemId);
	}
	return ids;
}

// A layout read back from storage, made whole.
//
// Whatever is stored was written by some version of this plugin on this
// device — possibly an older one with fewer items, possibly a newer one
// with items this build has never heard of. Unknown ids are dropped, and an
// item the stored layout does not mention is put back after the item it
// follows by default, so a control added in a later release turns up near
// where it belongs instead of vanishing because a layout predates it.
export function normalizeToolbarLayout(raw: unknown): ToolbarLayout {
	if (typeof raw !== 'object' || raw === null) return defaultToolbarLayout();
	const stored = raw as { order?: unknown; hidden?: unknown };

	const order = knownIds(stored.order);
	if (order.length === 0) return defaultToolbarLayout();

	const defaults = TOOLBAR_ITEMS.map((item) => item.id);
	defaults.forEach((id, defaultIndex) => {
		if (order.includes(id)) return;
		let insertAt = 0;
		for (let previous = defaultIndex - 1; previous >= 0; previous--) {
			const anchor = order.indexOf(defaults[previous] as ToolbarItemId);
			if (anchor >= 0) {
				insertAt = anchor + 1;
				break;
			}
		}
		order.splice(insertAt, 0, id);
	});

	const hidden = new Set(knownIds(stored.hidden));
	return { order, hidden: order.filter((id) => hidden.has(id)) };
}

export function toolbarLayoutsEqual(a: ToolbarLayout, b: ToolbarLayout): boolean {
	return (
		a.order.length === b.order.length &&
		a.order.every((id, index) => b.order[index] === id) &&
		a.hidden.length === b.hidden.length &&
		a.hidden.every((id) => b.hidden.includes(id))
	);
}

// The layout with one item moved to a new position. Used by the editor for
// both a drag and a keyboard move, so the two cannot disagree.
export function moveToolbarItem(layout: ToolbarLayout, id: ToolbarItemId, toIndex: number): ToolbarLayout {
	const from = layout.order.indexOf(id);
	if (from < 0) return layout;
	const order = layout.order.filter((entry) => entry !== id);
	const clamped = Math.max(0, Math.min(order.length, toIndex));
	order.splice(clamped, 0, id);
	return { order, hidden: order.filter((entry) => layout.hidden.includes(entry)) };
}

export function setToolbarItemHidden(layout: ToolbarLayout, id: ToolbarItemId, hidden: boolean): ToolbarLayout {
	const set = new Set(layout.hidden);
	if (hidden) set.add(id);
	else set.delete(id);
	return { order: [...layout.order], hidden: layout.order.filter((entry) => set.has(entry)) };
}
