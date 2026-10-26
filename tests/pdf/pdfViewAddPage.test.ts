// @vitest-environment jsdom
import { PDFDocument, degrees } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHandwrittenNoteBytes } from '../../src/templates';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// Adding a page — to a note this plugin made, and to any other PDF: a book,
// a handout, a scan.

async function open(bytes: Uint8Array, onPage = 1) {
	installSurfaceStubs();
	const harness = openPdfView();
	const internals = harness.view as unknown as {
		app: { vault: Record<string, unknown> & { configDir?: string; adapter: Record<string, unknown> } };
		currentPageNumber: number;
		onLoadFile: (file: unknown) => Promise<void>;
		addPage(): Promise<void>;
		controller: { setReadOnly(on: boolean): void };
	};
	let onDisk = bytes;
	const vault = internals.app.vault;
	vault.configDir = 'config-folder';
	vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
	vault.modifyBinary = vi.fn(async (_file: unknown, written: ArrayBuffer) => {
		onDisk = new Uint8Array(written);
	});
	Object.assign(vault.adapter, {
		stat: vi.fn(async () => ({ size: onDisk.byteLength, mtime: 1 })),
		exists: vi.fn(async () => true),
		mkdir: vi.fn(async () => {}),
		writeBinary: vi.fn(async () => {}),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		remove: vi.fn(async () => {}),
	});
	internals.onLoadFile = vi.fn(async () => internals.controller.setReadOnly(false));
	Object.defineProperty(internals, 'currentPageNumber', { get: () => onPage, configurable: true });
	return { internals, onDisk: async () => PDFDocument.load(onDisk) };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('adding a page to a PDF this plugin did not make', () => {
	it('adds a blank page the size of the page on screen, right after it', async () => {
		const book = await PDFDocument.create();
		book.addPage([500, 700]);
		book.addPage([500, 700]);
		const { internals, onDisk } = await open(await book.save(), 1);

		await internals.addPage();

		const doc = await onDisk();
		expect(doc.getPageCount()).toBe(3);
		const added = doc.getPage(1);
		expect([added.getWidth(), added.getHeight()]).toEqual([500, 700]);
		// Blank, and the book is not turned into a note.
		expect(added.node.Contents()).toBeUndefined();
		expect(doc.getKeywords()).toBeUndefined();
	});

	it('turns the page the way the page on screen is turned', async () => {
		const scan = await PDFDocument.create();
		scan.addPage([595, 842]).setRotation(degrees(90));
		const { internals, onDisk } = await open(await scan.save());

		await internals.addPage();

		const added = (await onDisk()).getPage(1);
		expect([added.getWidth(), added.getHeight()]).toEqual([842, 595]);
	});

	it('takes the size a reader shows — the crop box — not the paper behind it', async () => {
		const cropped = await PDFDocument.create();
		cropped.addPage([612, 792]).setCropBox(36, 36, 540, 720);
		const { internals, onDisk } = await open(await cropped.save());

		await internals.addPage();

		const added = (await onDisk()).getPage(1);
		expect([added.getWidth(), added.getHeight()]).toEqual([540, 720]);
	});
});

describe('adding a page to a note this plugin made', () => {
	it('still gives it the note’s paper and ruling', async () => {
		const { internals, onDisk } = await open(await createHandwrittenNoteBytes('lined'));

		await internals.addPage();

		const doc = await onDisk();
		expect(doc.getPageCount()).toBe(2);
		const added = doc.getPage(1);
		expect([added.getWidth(), added.getHeight()]).toEqual([612, 792]);
		expect(added.node.Contents()).toBeDefined();
	});
});
