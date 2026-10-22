// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildToolbar } from '../../src/annotate/toolbar';
import { defaultToolbarLayout, moveToolbarItem, setToolbarItemHidden } from '../../src/annotate/toolbarLayout';
import { ToolbarLayoutModal } from '../../src/annotate/toolbarLayoutModal';
import { mountTestSurface, type TestSurface } from '../harness/surface';
import { openedModals, resetObsidianStubs } from '../harness/obsidian';

let surface: TestSurface;
let host: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	resetObsidianStubs();
	surface = mountTestSurface(800, 450);
	host = document.createElement('div');
	document.body.appendChild(host);
});

// The pen's button names the nib in hand and says how to change it.
const PEN = 'Round pen — press again for pen types';

function stripLabels(): string[] {
	const bar = host.querySelector('.inkling-toolbar-bar');
	return Array.from(bar?.children ?? []).map((child) => child.getAttribute('aria-label') ?? child.className);
}

describe('the toolbar layout', () => {
	it('lays the strip out in the default order to begin with', () => {
		buildToolbar(host, surface.controller);
		const labels = stripLabels();
		expect(labels[0]).toBe('Select / lasso');
		expect(labels.indexOf(PEN)).toBeLessThan(labels.indexOf('Undo'));
		expect(labels.at(-1)).toBe('Collapse tools');
	});

	it('rearranges every open strip when the layout changes', () => {
		buildToolbar(host, surface.controller);
		surface.controller.setToolbarLayout(moveToolbarItem(defaultToolbarLayout(), 'undo', 0));
		expect(stripLabels()[0]).toBe('Undo');
	});

	it('leaves a hidden item out of the strip', () => {
		buildToolbar(host, surface.controller);
		surface.controller.setToolbarLayout(setToolbarItemHidden(defaultToolbarLayout(), 'eraser', true));
		expect(stripLabels()).not.toContain('Eraser');
		expect(stripLabels()).toContain(PEN);
	});

	it('marks the tool in hand as pressed', () => {
		buildToolbar(host, surface.controller);
		const pen = host.querySelector(`[aria-label="${PEN}"]`);
		expect(pen?.getAttribute('aria-pressed')).toBe('true');
		expect(host.querySelector('[aria-label="Eraser"]')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('offers the layout editor only when there is an app to open it in', () => {
		buildToolbar(host, surface.controller);
		expect(host.querySelector('.inkling-layout-button')).toBeNull();

		host.replaceChildren();
		buildToolbar(host, surface.controller, { app: {} as never });
		const button = host.querySelector<HTMLButtonElement>('.inkling-layout-button');
		expect(button).not.toBeNull();
		button?.click();
		expect(openedModals.at(-1)).toBeInstanceOf(ToolbarLayoutModal);
	});

	it('keeps the editor button and the collapse button even when the layout hides everything', () => {
		buildToolbar(host, surface.controller, { app: {} as never });
		let layout = defaultToolbarLayout();
		for (const id of layout.order) layout = setToolbarItemHidden(layout, id, true);
		surface.controller.setToolbarLayout(layout);
		const bar = host.querySelector('.inkling-toolbar-bar');
		expect(bar?.children).toHaveLength(2);
		expect(bar?.querySelector('.inkling-layout-button')).not.toBeNull();
		expect(bar?.querySelector('.inkling-collapse-button')).not.toBeNull();
	});
});
