// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, StrokeAnnotation } from '../../src/annotate/types';
import { AnnotationWriterClient } from '../../src/pdf/annotationWriterClient';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// Two devices with the same PDF open, both writing on it. Each one's saves
// reach the other by sync, as a change to the file on disk; the view merges
// that change into what it shows, stroke by stroke, and saves on from it —
// instead of writing over it, which is what it used to do.

const WIDTH = 612;
const HEIGHT = 792;

// pdf.js's viewport for an upright page at scale 1: y flipped.
const viewport = {
	scale: 1,
	width: WIDTH,
	height: HEIGHT,
	convertToViewportPoint: (x: number, y: number) => [x, HEIGHT - y],
	convertToPdfPoint: (x: number, y: number) => [x, HEIGHT - y],
};

const fakePdf = {
	numPages: 1,
	getPage: async () => ({ view: [0, 0, WIDTH, HEIGHT], rotate: 0 }),
	destroy: async () => undefined,
};

function stroke(id: string, y: number): StrokeAnnotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 100, y }, { x: 300, y }] };
}

// In canvas space, which is what the view's store holds.
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
	// Opened, as the workspace opens it: that is when it starts listening
	// for the file changing.
	await harness.open();
	const internals = harness.view as unknown as {
		app: { vault: Record<string, unknown> & { adapter: { stat: unknown }; trigger(name: string, file: unknown): void } };
		currentFile: { path: string; stat?: { size: number; mtime: number } };
		pdf: unknown;
		writer: AnnotationWriterClient;
		savedAnnotations: Map<number, Annotation[]>;
		viewports: Map<number, unknown>;
		seededPages: Set<number>;
		rememberDisk(file: unknown): Promise<void>;
		controller: {
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			seedPage(page: number, annotations: Annotation[]): void;
			getPageAnnotations(page: number): Annotation[];
			place(page: number, annotation: Annotation): void;
		};
	};

	let onDisk = await pdfWith(initial);
	let clock = 1000;
	const file = internals.currentFile;
	const touch = () => (file.stat = { size: onDisk.byteLength, mtime: ++clock });
	touch();
	const vault = internals.app.vault;
	vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
	vault.modifyBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		onDisk = new Uint8Array(bytes);
		touch();
	});
	vault.appendBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		const joined = new Uint8Array(onDisk.byteLength + bytes.byteLength);
		joined.set(onDisk);
		joined.set(new Uint8Array(bytes), onDisk.byteLength);
		onDisk = joined;
		touch();
	});
	vault.adapter.stat = vi.fn(async () => ({ ...file.stat }));

	// The view as onLoadFile and renderPage leave it.
	const writer = new AnnotationWriterClient();
	const opened = await writer.open(onDisk.slice().buffer);
	internals.writer = writer;
	internals.savedAnnotations = opened.savedAnnotations;
	internals.pdf = fakePdf;
	internals.viewports.set(1, viewport);
	internals.seededPages.add(1);
	internals.controller.mountPage(1, document.body.createDiv(), WIDTH, HEIGHT);
	internals.controller.seedPage(1, initial.map((a) => onScreen(a as StrokeAnnotation)));
	await internals.rememberDisk(file);

	return {
		internals,
		ids: () => internals.controller.getPageAnnotations(1).map((a) => a.id),
		onDiskIds: async () => readInklingAnnotations(await PDFDocument.load(onDisk), 0).map((a) => a.id),
		// Another device's save landing by sync, and the vault saying so.
		remoteSave: async (annotations: Annotation[]) => {
			onDisk = await pdfWith(annotations);
			touch();
			vault.trigger('modify', file);
		},
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a PDF open on two devices at once', () => {
	it('shows the other device’s new ink as it arrives, keeping ours that is not saved yet', async () => {
		const { internals, ids, remoteSave } = await open([stroke('ink-a', 700)]);
		// Ours, not saved yet.
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		// Theirs, saved there and synced here.
		await remoteSave([stroke('ink-a', 700), stroke('ink-theirs', 300)]);
		await vi.advanceTimersByTimeAsync(300);

		expect(ids().sort()).toEqual(['ink-a', 'ink-ours', 'ink-theirs']);
	});

	it('then saves on top of their file rather than over it', async () => {
		const { internals, onDiskIds, remoteSave } = await open([stroke('ink-a', 700)]);
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		await remoteSave([stroke('ink-a', 700), stroke('ink-theirs', 300)]);
		await vi.advanceTimersByTimeAsync(5000);

		expect((await onDiskIds()).sort()).toEqual(['ink-a', 'ink-ours', 'ink-theirs']);
	});

	it('takes away what the other device erased', async () => {
		const { ids, remoteSave } = await open([stroke('ink-a', 700), stroke('ink-b', 600)]);
		await remoteSave([stroke('ink-b', 600)]);
		await vi.advanceTimersByTimeAsync(300);

		expect(ids()).toEqual(['ink-b']);
	});

	it('does not take its own save for another device’s', async () => {
		const { internals, remoteSave } = await open([stroke('ink-a', 700)]);
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		await vi.advanceTimersByTimeAsync(5000);
		const writer = internals.writer;
		// The vault reports our own save as a change, as it does.
		internals.app.vault.trigger('modify', internals.currentFile);
		await vi.advanceTimersByTimeAsync(300);

		expect(internals.writer).toBe(writer);
		void remoteSave;
	});

	it('saves sooner once another device is writing too', async () => {
		const { internals, onDiskIds, remoteSave } = await open([stroke('ink-a', 700)]);
		await remoteSave([stroke('ink-a', 700), stroke('ink-theirs', 300)]);
		await vi.advanceTimersByTimeAsync(300);

		internals.controller.place(1, onScreen(stroke('ink-quick', 400)));
		await vi.advanceTimersByTimeAsync(400);
		expect(await onDiskIds()).toContain('ink-quick');
	});
});
