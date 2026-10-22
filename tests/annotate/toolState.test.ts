import { describe, expect, it, vi } from 'vitest';
import { ToolState } from '../../src/annotate/toolState';
import { DEFAULT_COLOR, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH } from '../../src/annotate/types';

describe('ToolState', () => {
	it('starts on select at the defaults', () => {
		const state = new ToolState();
		expect(state.getTool()).toBe('select');
		expect(state.getColor()).toBe(DEFAULT_COLOR);
		expect(state.getWidth()).toBe(DEFAULT_WIDTH);
	});

	it('remembers color and width per tool', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setColor('#e03131');
		state.setWidth(8);

		state.setTool('highlighter');
		state.setWidth(20);
		expect(state.getWidth()).toBe(20);

		state.setTool('pen');
		expect(state.getColor()).toBe('#e03131');
		expect(state.getWidth()).toBe(8);
	});

	it('clamps width to the allowed range', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setWidth(9999);
		expect(state.getWidth()).toBe(MAX_WIDTH);
		state.setWidth(-4);
		expect(state.getWidth()).toBe(MIN_WIDTH);
	});

	it('honours a suggestion only until the user picks a tool', () => {
		const state = new ToolState();
		state.suggestTool('pen');
		expect(state.getTool()).toBe('pen');

		state.setTool('select');
		state.suggestTool('pen');
		// An ink block re-renders on every save and suggests again; that must
		// not drag the user back out of the lasso they chose.
		expect(state.getTool()).toBe('select');
	});

	it('notifies listeners with the kind of change', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setTool('pen');
		expect(listener).toHaveBeenLastCalledWith('tool');

		state.setColor('#1971c2');
		expect(listener).toHaveBeenLastCalledWith('style');
	});

	it('stops notifying after unsubscribe', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener)();
		state.setTool('pen');
		expect(listener).not.toHaveBeenCalled();
	});

	it('does not notify when a setter is handed the value already held', () => {
		const state = new ToolState();
		state.setTool('pen');
		const listener = vi.fn();
		state.subscribe(listener);
		state.setTool('pen');
		state.setColor(state.getColor());
		state.setWidth(state.getWidth());
		expect(listener).not.toHaveBeenCalled();
	});
});

// Collapsed state lives on ToolState rather than on a toolbar for the same
// reason the pen does: an ink block's toolbar is destroyed and rebuilt on
// every save, so a strip collapsed to get it out of the way would spring
// back open a second after every burst of handwriting.
describe('ToolState toolbar chrome', () => {
	it('starts expanded', () => {
		expect(new ToolState().isToolbarCollapsed()).toBe(false);
	});

	it('reports what it was set to, and says so as a chrome change', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);

		state.setToolbarCollapsed(true);
		expect(state.isToolbarCollapsed()).toBe(true);
		// Not 'tool': a controller drops an in-flight drag on a tool change,
		// and collapsing the strip must not throw away a stroke in progress.
		expect(listener).toHaveBeenLastCalledWith('chrome');
	});

	it('says nothing when set to the state it already holds', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);
		state.setToolbarCollapsed(false);
		expect(listener).not.toHaveBeenCalled();
	});

	it('survives being collapsed and expanded without disturbing the pen', () => {
		const state = new ToolState();
		state.setTool('pen');
		state.setColor('#e03131');
		state.setWidth(8);

		state.setToolbarCollapsed(true);
		state.setToolbarCollapsed(false);

		expect(state.getTool()).toBe('pen');
		expect(state.getColor()).toBe('#e03131');
		expect(state.getWidth()).toBe(8);
	});
});

// The pen as it was last left, stored on the device and put back when the
// plugin next loads — so every note, and every session, starts with it.
describe('ToolState snapshot and restore', () => {
	it('brings back the tool in hand and every tool’s own colour and width', () => {
		const used = new ToolState();
		used.setTool('highlighter');
		used.setColor('#ffe066');
		used.setWidth(22);
		used.setTool('pen');
		used.setColor('#e03131');
		used.setWidth(7);

		const fresh = new ToolState();
		// Through JSON, the way local storage holds it.
		fresh.restore(JSON.parse(JSON.stringify(used.snapshot())));

		expect(fresh.getTool()).toBe('pen');
		expect(fresh.getColor()).toBe('#e03131');
		expect(fresh.getWidth()).toBe(7);
		fresh.setTool('highlighter');
		expect(fresh.getColor()).toBe('#ffe066');
		expect(fresh.getWidth()).toBe(22);
	});

	it('keeps a chosen tool chosen, so an ink block does not swap it for the pen', () => {
		const used = new ToolState();
		used.setTool('select');
		const fresh = new ToolState();
		fresh.restore(used.snapshot());
		fresh.suggestTool('pen');
		expect(fresh.getTool()).toBe('select');
	});

	it('lets an ink block suggest the pen when nothing was ever chosen', () => {
		const fresh = new ToolState();
		fresh.restore(new ToolState().snapshot());
		fresh.suggestTool('pen');
		expect(fresh.getTool()).toBe('pen');
	});

	it('keeps what it can of a damaged snapshot and defaults the rest', () => {
		const fresh = new ToolState();
		fresh.restore({
			tool: 'laser',
			styles: {
				pen: { color: '#1971c2', width: 999 },
				highlighter: { color: 'yellow', width: 10 },
				eraser: { color: '#000000', width: Number.NaN },
				'__proto__': { color: '#000000', width: 5 },
			},
		});
		expect(fresh.getTool()).toBe('select');
		fresh.setTool('pen');
		expect(fresh.getColor()).toBe('#1971c2');
		expect(fresh.getWidth()).toBe(MAX_WIDTH);
		fresh.setTool('highlighter');
		expect(fresh.getColor()).not.toBe('yellow');
	});

	it('ignores nothing stored at all', () => {
		const fresh = new ToolState();
		for (const raw of [null, undefined, 'pen', 7]) fresh.restore(raw);
		expect(fresh.getTool()).toBe('select');
		expect(fresh.getColor()).toBe(DEFAULT_COLOR);
		expect(fresh.getWidth()).toBe(DEFAULT_WIDTH);
	});

	it('tells every open surface, so their strips show what was restored', () => {
		const state = new ToolState();
		const listener = vi.fn();
		state.subscribe(listener);
		state.restore({ tool: 'eraser', chosen: true, styles: {} });
		expect(listener).toHaveBeenCalledWith('tool');
	});
});
