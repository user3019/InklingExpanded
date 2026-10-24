// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { backUp, listBackups, restoreBackup } from '../src/backups';
import { createHandwrittenNoteBytes } from '../src/templates';
import type { TFile as ObsidianFile } from 'obsidian';
import { TFile } from './harness/obsidian';
import { openPdfView } from './harness/pdfView';
import { installSurfaceStubs } from './harness/surface';

// A copy of a note from before each rebuild, and the way back to it.

// A vault in memory: the note itself, and files the adapter writes.
// Obsidian's own folder, under whatever name the vault gives it.
const CONFIG = 'config-folder';

function memoryVault(note: Uint8Array) {
	const files = new Map<string, ArrayBuffer>();
	let onDisk = note.slice().buffer;
	const vault = {
		configDir: CONFIG,
		readBinary: vi.fn(async () => onDisk.slice(0)),
		modifyBinary: vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
			onDisk = bytes.slice(0);
		}),
		adapter: {
			stat: vi.fn(async (path: string) => ({ size: path === 'Notes/Handwritten.pdf' ? onDisk.byteLength : (files.get(path)?.byteLength ?? 0), mtime: 1 })),
			exists: vi.fn(async (path: string) => path === `${CONFIG}/plugins/inkling-expanded/backups` || files.has(path)),
			mkdir: vi.fn(async () => {}),
			writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => void files.set(path, bytes.slice(0))),
			readBinary: vi.fn(async (path: string) => (files.get(path) as ArrayBuffer).slice(0)),
			remove: vi.fn(async (path: string) => void files.delete(path)),
			list: vi.fn(async () => ({ files: [...files.keys()], folders: [] })),
		},
	};
	return { vault, files, onDisk: () => onDisk };
}

const pageCount = async (bytes: ArrayBuffer) => (await PDFDocument.load(bytes)).getPageCount();

describe('backups of a note', () => {
	const file = new TFile('Notes/Handwritten.pdf') as unknown as ObsidianFile;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-22T10:00:00.000Z'));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('keeps the last few, newest first, with what each was from before', async () => {
		const { vault, files } = memoryVault(await createHandwrittenNoteBytes('lined'));
		const app = { vault, workspace: { getLeavesOfType: () => [] } } as never;
		for (let minute = 0; minute < 7; minute++) {
			vi.setSystemTime(new Date(Date.UTC(2026, 9, 22, 10, minute)));
			await backUp(app, file, await vault.readBinary(), minute === 6 ? 'background' : 'add-page');
		}
		expect(files.size).toBe(5);
		const backups = await listBackups(app, file);
		expect(backups).toHaveLength(5);
		expect(backups[0]?.time.toISOString()).toBe('2026-10-22T10:06:00.000Z');
		expect(backups[0]?.reason).toBe('background');
		expect(backups[4]?.time.toISOString()).toBe('2026-10-22T10:02:00.000Z');
	});

	it('finds them in a listing with backslashes, as a Windows path may come', async () => {
		const { vault, files } = memoryVault(await createHandwrittenNoteBytes('lined'));
		const app = { vault, workspace: { getLeavesOfType: () => [] } } as never;
		await backUp(app, file, await vault.readBinary(), 'add-page');
		vault.adapter.list = vi.fn(async () => ({ files: [...files.keys()].map((path) => path.replace(/\//g, '\\')), folders: [] }));
		const backups = await listBackups(app, file);
		expect(backups).toHaveLength(1);
		expect(backups[0]?.reason).toBe('add-page');
		expect(files.has(backups[0]?.path ?? '')).toBe(true);
	});

	it('restores one, keeping the note as it is now as a backup too', async () => {
		const one = await createHandwrittenNoteBytes('lined');
		const { vault, onDisk } = memoryVault(one);
		const app = { vault, workspace: { getLeavesOfType: () => [] } } as never;
		await backUp(app, file, await vault.readBinary(), 'add-page');

		const two = await PDFDocument.load(one);
		two.addPage();
		await vault.modifyBinary(file, (await two.save()).slice().buffer);
		expect(await pageCount(onDisk())).toBe(2);

		vi.setSystemTime(new Date('2026-10-22T11:00:00.000Z'));
		const [backup] = await listBackups(app, file);
		expect(await restoreBackup(app, file, backup as never)).toBe(true);
		expect(await pageCount(onDisk())).toBe(1);
		const after = await listBackups(app, file);
		expect(after.map((b) => b.reason)).toEqual(['restore', 'add-page']);
	});
});

describe('a rebuild in the PDF view', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
	});

	it('pauses drawing until the reload, and keeps the note as it was', async () => {
		const harness = openPdfView();
		const internals = harness.view as unknown as {
			app: { vault: Record<string, unknown> };
			controller: { isReadOnly(): boolean; setReadOnly(on: boolean): void };
			onLoadFile: (file: unknown) => Promise<void>;
			addPage(): Promise<void>;
		};
		const memory = memoryVault(await createHandwrittenNoteBytes('lined'));
		Object.assign(internals.app.vault, memory.vault);

		let readOnlyDuringWrite: boolean | null = null;
		const write = memory.vault.modifyBinary.getMockImplementation();
		memory.vault.modifyBinary.mockImplementation(async (file: unknown, bytes: ArrayBuffer) => {
			readOnlyDuringWrite = internals.controller.isReadOnly();
			await write?.(file, bytes);
		});
		// The real reload decides read-only for itself; this one says yes.
		internals.onLoadFile = vi.fn(async () => internals.controller.setReadOnly(false));

		await internals.addPage();

		expect(readOnlyDuringWrite).toBe(true);
		expect(internals.controller.isReadOnly()).toBe(false);
		expect(await pageCount(memory.onDisk())).toBe(2);
		const kept = [...memory.files.keys()];
		expect(kept).toHaveLength(1);
		expect(kept[0]?.startsWith(`${CONFIG}/plugins/inkling-expanded/backups/Notes_Handwritten.pdf@`)).toBe(true);
		expect(kept[0]?.endsWith('@add-page.pdf')).toBe(true);
		expect(await pageCount(memory.files.get(kept[0] as string) as ArrayBuffer)).toBe(1);
	});

	it('lets drawing go on when the rebuild is refused', async () => {
		const harness = openPdfView();
		const internals = harness.view as unknown as {
			app: { vault: Record<string, unknown> };
			controller: { isReadOnly(): boolean };
			changeBackground(target: number, style: string): Promise<void>;
			onLoadFile: (file: unknown) => Promise<void>;
		};
		const memory = memoryVault(await createHandwrittenNoteBytes('lined'));
		Object.assign(internals.app.vault, memory.vault);
		internals.onLoadFile = vi.fn(async () => {});
		await internals.changeBackground(9, 'dot-grid');
		expect(internals.controller.isReadOnly()).toBe(false);
		expect(memory.files.size).toBe(0);
	});
});
