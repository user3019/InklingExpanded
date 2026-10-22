import { describe, expect, it } from 'vitest';
import {
	TOOLBAR_ITEMS,
	defaultToolbarLayout,
	moveToolbarItem,
	normalizeToolbarLayout,
	setToolbarItemHidden,
	toolbarLayoutsEqual,
	type ToolbarItemId,
} from '../../src/annotate/toolbarLayout';
import { ToolState, type ToolStateChange } from '../../src/annotate/toolState';

const ALL = TOOLBAR_ITEMS.map((item) => item.id);

describe('normalizeToolbarLayout', () => {
	it('gives the default for nothing stored', () => {
		for (const raw of [null, undefined, 'pen', 42, {}, { order: [] }, { order: 'pen' }]) {
			expect(normalizeToolbarLayout(raw)).toEqual(defaultToolbarLayout());
		}
	});

	it('keeps a complete stored order as it is', () => {
		const order = [...ALL].reverse();
		expect(normalizeToolbarLayout({ order, hidden: ['pen'] })).toEqual({ order, hidden: ['pen'] });
	});

	it('drops ids this build does not know, and repeats', () => {
		const layout = normalizeToolbarLayout({ order: ['laser-pointer', ...ALL, 'pen'], hidden: ['laser-pointer', 'pen', 'pen'] });
		expect(layout.order).toEqual(ALL);
		expect(layout.hidden).toEqual(['pen']);
	});

	// A layout saved before a control existed must not lose that control.
	it('puts an item the stored layout never mentioned back after its default neighbour', () => {
		const order = ALL.filter((id) => id !== 'invert');
		const moved = [...order.filter((id) => id !== 'clear-page' && id !== 'add-page'), 'clear-page', 'add-page'] as ToolbarItemId[];
		const layout = normalizeToolbarLayout({ order: moved, hidden: [] });
		expect(layout.order).toHaveLength(ALL.length);
		// Whatever comes before it by default, wherever that has moved to.
		const neighbour = ALL[ALL.indexOf('invert') - 1] as ToolbarItemId;
		expect(layout.order.indexOf('invert')).toBe(layout.order.indexOf(neighbour) + 1);
	});

	it('puts a missing first item at the start', () => {
		const layout = normalizeToolbarLayout({ order: ALL.filter((id) => id !== 'select') });
		expect(layout.order[0]).toBe('select');
	});

	it('lists hidden items in display order', () => {
		const layout = normalizeToolbarLayout({ order: ALL, hidden: ['zoom', 'pen'] });
		expect(layout.hidden).toEqual(['pen', 'zoom']);
	});
});

describe('moveToolbarItem', () => {
	it('moves an item to the index it is given', () => {
		const layout = moveToolbarItem(defaultToolbarLayout(), 'zoom', 0);
		expect(layout.order[0]).toBe('zoom');
		expect(layout.order).toHaveLength(ALL.length);
	});

	it('clamps an index past either end', () => {
		expect(moveToolbarItem(defaultToolbarLayout(), 'pen', 99).order.at(-1)).toBe('pen');
		expect(moveToolbarItem(defaultToolbarLayout(), 'zoom', -5).order[0]).toBe('zoom');
	});

	it('keeps an item hidden when it moves', () => {
		const hidden = setToolbarItemHidden(defaultToolbarLayout(), 'eraser', true);
		expect(moveToolbarItem(hidden, 'eraser', 0).hidden).toEqual(['eraser']);
	});
});

describe('setToolbarItemHidden', () => {
	it('hides and shows again without moving the item', () => {
		const hidden = setToolbarItemHidden(defaultToolbarLayout(), 'note', true);
		expect(hidden.hidden).toEqual(['note']);
		const shown = setToolbarItemHidden(hidden, 'note', false);
		expect(toolbarLayoutsEqual(shown, defaultToolbarLayout())).toBe(true);
	});
});

describe('ToolState toolbar layout', () => {
	it('tells listeners when the layout changes, as a layout change', () => {
		const state = new ToolState();
		const changes: ToolStateChange[] = [];
		state.subscribe((change) => changes.push(change));
		state.setToolbarLayout(moveToolbarItem(defaultToolbarLayout(), 'zoom', 0));
		expect(changes).toEqual(['layout']);
		expect(state.getToolbarLayout().order[0]).toBe('zoom');
	});

	it('stays quiet for a layout equal to the one it has', () => {
		const state = new ToolState();
		const changes: ToolStateChange[] = [];
		state.subscribe((change) => changes.push(change));
		state.setToolbarLayout(defaultToolbarLayout());
		expect(changes).toEqual([]);
	});
});
