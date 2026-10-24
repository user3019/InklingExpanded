// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, StrokeAnnotation } from '../../src/annotate/types';
import { backUp, listBackups, restoreBackup } from '../../src/backups';
import { AnnotationWriterClient } from '../../src/pdf/annotationWriterClient';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { notices } from '../harness/obsidian';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// The annotate view's ink, kept through what happens around it: closing
// while another device's save is landing, restoring an earlier version,
// a change it fails to take in, a canvas that grew on disk but not on
// screen.

const WIDTH = 612;
const HEIGHT = 792;

const viewport = {
	scale: 1,
	width: WIDTH,
	height: HEIGHT,
	convertToViewportPoint: (x: number, y: number) => [x, HEIGHT - y],
	convertToPdfPoint: (x: number, y: number) => [x, HEIGHT - y],
};

function stroke(id: string, y: number): StrokeAnnotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 100, y }, { x: 300, y }] };
}

const onScreen = (annotation: StrokeAnnotation): Annotation => ({
	...annotation,
	points: annotation.points.map((point) => ({ x: point.x, y: HEIGHT - point.y })),
});

async function pdfWith(annotations: Annotation[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([WIDTH, HEIGHT]);
	writeInklingAnnotations(doc, 0, annotations);
	return doc.save();
}

async function open(initial: Annotation[]) {
	installSurfaceStubs();
	const harness = openPdfView();
	await harness.open();
	const internals = harness.view as unknown as {
		app: {
			vault: Record<string, unknown> & { configDir?: string; adapter: Record<string, unknown>; trigger(name: string, file: unknown): void };
			workspace: Record<string, unknown>;
		};
		file: { path: string; basename: string; extension: string };
		currentFile: { path: string; stat?: { size: number; mtime: number } };
		pdf: unknown;
		writer: AnnotationWriterClient;
		savedAnnotations: Map<number, Annotation[]>;
		pageIds: string[];
		viewports: Map<number, unknown>;
		seededPages: Set<number>;
		infiniteBox: unknown;
		rememberDisk(file: unknown): Promise<void>;
		flushAnnotations(file: unknown): Promise<void>;
		onUnloadFile(): Promise<void>;
		onLoadFile: (file: unknown) => Promise<void>;
		pullRemote(file: unknown, force?: boolean): Promise<void>;
		addPage(): Promise<void>;
		growInfiniteCanvas(edges: string[]): Promise<void>;
		writeGrownBox: (...args: unknown[]) => Promise<unknown>;
		showGrownPage: (...args: unknown[]) => Promise<void>;
		controller: {
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			seedPage(page: number, annotations: Annotation[]): void;
			getPageAnnotations(page: number): Annotation[];
			place(page: number, annotation: Annotation): void;
			setReadOnly(on: boolean): void;
		};
	};

	let onDisk = await pdfWith(initial);
	let clock = 1000;
	const file = internals.currentFile;
	const touch = () => (file.stat = { size: onDisk.byteLength, mtime: ++clock });
	touch();
	const kept = new Map<string, ArrayBuffer>();
	const vault = internals.app.vault;
	vault.configDir = 'config-folder';
	vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
	vault.modifyBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		onDisk = new Uint8Array(bytes);
		touch();
		vault.trigger('modify', file);
	});
	vault.appendBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		const joined = new Uint8Array(onDisk.byteLength + bytes.byteLength);
		joined.set(onDisk);
		joined.set(new Uint8Array(bytes), onDisk.byteLength);
		onDisk = joined;
		touch();
	});
	Object.assign(vault.adapter, {
		stat: vi.fn(async (path: string) => (path === file.path ? { ...file.stat } : { size: kept.get(path)?.byteLength ?? 0, mtime: 1 })),
		exists: vi.fn(async (path: string) => path === 'config-folder/plugins/inkling-expanded/backups' || kept.has(path)),
		mkdir: vi.fn(async () => {}),
		writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => void kept.set(path, bytes.slice(0))),
		readBinary: vi.fn(async (path: string) => (kept.get(path) as ArrayBuffer).slice(0)),
		remove: vi.fn(async (path: string) => void kept.delete(path)),
		list: vi.fn(async () => ({ files: [...kept.keys()], folders: [] })),
	});
	// The real reload decides read-only for itself; for this file, no.
	internals.onLoadFile = vi.fn(async () => internals.controller.setReadOnly(false));
	internals.app.workspace.getLeavesOfType = (type: string) => (type === 'inkling-pdf-view' ? [{ view: internals }] : []);

	const writer = new AnnotationWriterClient();
	const opened = await writer.open(onDisk.slice().buffer);
	internals.writer = writer;
	internals.savedAnnotations = opened.savedAnnotations;
	internals.pageIds = opened.pageIds;
	internals.pdf = { numPages: 1, getPage: async () => ({ view: [0, 0, WIDTH, HEIGHT], rotate: 0 }), destroy: async () => undefined };
	internals.viewports.set(1, viewport);
	internals.seededPages.add(1);
	internals.controller.mountPage(1, document.body.createDiv(), WIDTH, HEIGHT);
	internals.controller.seedPage(1, initial.map((a) => onScreen(a as StrokeAnnotation)));
	await internals.rememberDisk(file);

	return {
		internals,
		file,
		app: internals.app as never,
		onDiskIds: async (bytes = onDisk) => readInklingAnnotations(await PDFDocument.load(bytes), 0).map((a) => a.id).sort(),
		// Another device's save landing on disk, before the vault says so.
		remoteSave: async (annotations: Annotation[]) => {
			onDisk = await pdfWith(annotations);
			touch();
		},
		kept,
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
	notices.length = 0;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('closing a PDF', () => {
	it('saves ink not saved yet on top of another device’s save that landed just before', async () => {
		const { internals, onDiskIds, remoteSave } = await open([stroke('ink-a', 700)]);
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		await remoteSave([stroke('ink-a', 700), stroke('ink-theirs', 300)]);

		await internals.onUnloadFile();

		expect(await onDiskIds()).toEqual(['ink-a', 'ink-ours', 'ink-theirs']);
		expect(notices.some((message) => message.includes('could not be saved'))).toBe(false);
	});
});

describe('restoring an earlier version of an open PDF', () => {
	it('puts back exactly that version, keeping what was on screen as a backup of its own', async () => {
		const { internals, file, app, onDiskIds, kept } = await open([stroke('ink-a', 700)]);
		await backUp(app, file as never, (await (internals.app.vault.readBinary as () => Promise<ArrayBuffer>)()), 'add-page');
		vi.setSystemTime(Date.now() + 60_000);
		// Saved since, and drawn since without being saved.
		internals.controller.place(1, onScreen(stroke('ink-b', 600)));
		await internals.flushAnnotations(file);
		internals.controller.place(1, onScreen(stroke('ink-c', 500)));

		const [earlier] = await listBackups(app, file as never);
		expect(await restoreBackup(app, file as never, earlier as never)).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);

		// Not merged with what was on screen: the restored file, as it was.
		expect(await onDiskIds()).toEqual(['ink-a']);
		expect(internals.onLoadFile).toHaveBeenCalled();
		// What was on screen, unsaved ink included, kept as the backup the
		// restore made first.
		const newest = (await listBackups(app, file as never))[0];
		expect(newest?.reason).toBe('restore');
		expect(await onDiskIds(new Uint8Array(kept.get(newest?.path ?? '') as ArrayBuffer))).toEqual(['ink-a', 'ink-b', 'ink-c']);
	});
});

describe('a change from another device that cannot be taken in', () => {
	it('does not leave the writer it opened for it running', async () => {
		const { internals, file, remoteSave } = await open([stroke('ink-a', 700)]);
		// Each writer ended, as the `this` of its terminate call.
		const terminate = vi.spyOn(AnnotationWriterClient.prototype, 'terminate');
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		// The document fails to be read back after the writer has opened.
		internals.pdf = { numPages: 1, getPage: async () => Promise.reject(new Error('unreadable')), destroy: async () => undefined };
		const current = internals.writer;
		await remoteSave([stroke('ink-a', 700), stroke('ink-theirs', 300)]);

		await internals.pullRemote(file);

		expect(internals.writer).toBe(current);
		expect(terminate.mock.contexts.filter((writer) => writer !== current)).toHaveLength(1);
	});
});

describe('an infinite canvas', () => {
	it('is not given a second page, which would stop it growing for good', async () => {
		const { internals } = await open([]);
		internals.infiniteBox = { left: 0, bottom: 0, right: WIDTH, top: HEIGHT };
		await internals.addPage();
		expect(internals.app.vault.modifyBinary).not.toHaveBeenCalled();
		expect(notices.some((message) => message.includes('cannot have more pages'))).toBe(true);
	});

	it('reloads when it grew on disk but could not be shown grown', async () => {
		const { internals } = await open([]);
		internals.infiniteBox = { left: 0, bottom: 0, right: WIDTH, top: HEIGHT };
		internals.writeGrownBox = vi.fn(async () => ({}));
		internals.showGrownPage = vi.fn(async () => Promise.reject(new Error('render failed')));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		await internals.growInfiniteCanvas(['right']);

		expect(internals.onLoadFile).toHaveBeenCalled();
		expect(notices.some((message) => message.includes('could not make this canvas larger'))).toBe(false);
	});
});
