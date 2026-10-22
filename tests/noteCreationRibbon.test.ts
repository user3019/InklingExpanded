// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openedModals, resetObsidianStubs } from './harness/obsidian';
import { registerNoteCreation } from '../src/noteCreation';

// Creating a handwritten note was reachable only from the command palette
// and a folder's context menu — neither of which is one tap away on a
// tablet. A ribbon button puts it on the side panel, doing exactly what
// the command does: the same dialog, the same folder.

interface Ribbon {
	icon: string;
	title: string;
	callback: () => void;
}

function registerOnFakePlugin() {
	const ribbons: Ribbon[] = [];
	const commands: { id: string; callback: () => void }[] = [];
	const plugin = {
		app: {
			workspace: { getActiveFile: () => null, on: () => ({}) },
			vault: { getRoot: () => ({ path: '/', isRoot: () => true }) },
		},
		addCommand: vi.fn((command: { id: string; callback: () => void }) => commands.push(command)),
		registerEvent: vi.fn(),
		addRibbonIcon: vi.fn((icon: string, title: string, callback: () => void) => {
			ribbons.push({ icon, title, callback });
			return document.createElement('div');
		}),
	};
	registerNoteCreation(plugin as never, () => ({ template: 'lined', pageSize: 'letter', canvasMode: 'pages' }));
	return { ribbons, commands };
}

beforeEach(() => {
	resetObsidianStubs();
});

describe('the side panel', () => {
	it('has a button to create a handwritten note', () => {
		const { ribbons } = registerOnFakePlugin();

		expect(ribbons.map((r) => r.title)).toEqual(['Create handwritten note']);
	});

	it('opens the same dialog the command does', () => {
		const { ribbons, commands } = registerOnFakePlugin();

		ribbons[0]?.callback();
		commands.find((c) => c.id === 'create-handwritten-note')?.callback();

		expect(openedModals).toHaveLength(2);
		expect(openedModals[0]?.constructor).toBe(openedModals[1]?.constructor);
	});
});
