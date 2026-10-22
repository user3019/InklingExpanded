// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, StrokeAnnotation } from '../../src/annotate/types';
import { AnnotationWriterClient } from '../../src/pdf/annotationWriterClient';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { notices } from '../harness/obsidian';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// A note open on two devices — a tablet and a laptop — while one of them
// adds or deletes pages, or saves while the other's save is still on its
// way. Pages are matched by who they are, not by their number, and no save
// is built on a file that has changed under it.

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

// Two pages: ink-a on the first, ink-b on the second.
async function twoPages(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	doc.addPage([WIDTH, HEIGHT]);
	doc.addPage([WIDTH, HEIGHT]);
	writeInklingAnnotations(doc, 0, [stroke('ink-a', 700)]);
	writeInklingAnnotations(doc, 1, [stroke('ink-b', 600)]);
	return doc.save();
}

async function open() {
	installSurfaceStubs();
	const harness = openPdfView();
	await harness.open();
	const internals = harness.view as unknown as {
		app: { vault: Record<string, unknown> & { adapter: { stat: unknown }; trigger(name: string, file: unknown): void } };
		currentFile: { path: string; stat?: { size: number; mtime: number } };
		pdf: unknown;
		writer: AnnotationWriterClient;
		savedAnnotations: Map<number, Annotation[]>;
		pageIds: string[];
		viewports: Map<number, unknown>;
		seededPages: Set<number>;
		rememberDisk(file: unknown): Promise<void>;
		flushAnnotations(file: unknown): Promise<void>;
		onLoadFile: (file: unknown) => Promise<void>;
		controller: {
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			seedPage(page: number, annotations: Annotation[]): void;
			getPageAnnotations(page: number): Annotation[];
			place(page: number, annotation: Annotation): void;
			isReadOnly(): boolean;
			setReadOnly(on: boolean): void;
		};
	};

	let onDisk = await twoPages();
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
	// The real reload decides read-only for itself; for this file, no.
	internals.onLoadFile = vi.fn(async () => internals.controller.setReadOnly(false));

	const writer = new AnnotationWriterClient();
	const opened = await writer.open(onDisk.slice().buffer);
	internals.writer = writer;
	internals.savedAnnotations = opened.savedAnnotations;
	internals.pageIds = opened.pageIds;
	internals.pdf = {
		numPages: 2,
		getPage: async () => ({ view: [0, 0, WIDTH, HEIGHT], rotate: 0 }),
		destroy: async () => undefined,
	};
	for (const page of [1, 2]) {
		internals.viewports.set(page, viewport);
		internals.seededPages.add(page);
		internals.controller.mountPage(page, document.body.createDiv(), WIDTH, HEIGHT);
	}
	internals.controller.seedPage(1, [onScreen(stroke('ink-a', 700))]);
	internals.controller.seedPage(2, [onScreen(stroke('ink-b', 600))]);
	await internals.rememberDisk(file);

	return {
		internals,
		file,
		// Each page's ink ids, as the file on disk has them.
		onDiskPages: async () => {
			const doc = await PDFDocument.load(onDisk);
			return doc.getPages().map((_, index) => readInklingAnnotations(doc, index).map((a) => a.id).sort());
		},
		// The other device's save, landing by sync. `announce` is whether the
		// vault has said so yet — a save here can come first.
		remote: async (change: (doc: PDFDocument) => void, announce = true) => {
			const doc = await PDFDocument.load(onDisk);
			change(doc);
			onDisk = await doc.save();
			touch();
			if (announce) vault.trigger('modify', file);
		},
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
	notices.length = 0;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('a note changing on two devices at once', () => {
	it('does not save over the other device’s save, even before hearing of it', async () => {
		const { internals, file, onDiskPages, remote } = await open();
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		// Theirs lands on disk; the vault has not said so yet when ours saves.
		await remote((doc) => writeInklingAnnotations(doc, 0, [stroke('ink-a', 700), stroke('ink-theirs', 300)]), false);
		await internals.flushAnnotations(file);
		await vi.advanceTimersByTimeAsync(5000);

		expect(await onDiskPages()).toEqual([['ink-a', 'ink-ours', 'ink-theirs'], ['ink-b']]);
	});

	it('puts ink not saved yet on the page it was drawn on, after a page was added before it there', async () => {
		const { internals, onDiskPages, remote } = await open();
		// Drawn here on page 2, not saved yet.
		internals.controller.place(2, onScreen(stroke('ink-ours', 500)));
		// There, a page goes in between 1 and 2, written on.
		await remote((doc) => {
			doc.insertPage(1, [WIDTH, HEIGHT]);
			writeInklingAnnotations(doc, 1, [stroke('ink-new-page', 400)]);
		});
		await vi.advanceTimersByTimeAsync(5000);

		expect(await onDiskPages()).toEqual([['ink-a'], ['ink-new-page'], ['ink-b', 'ink-ours']]);
		// And the view reloads, with page numbers that mean those pages.
		expect(internals.onLoadFile).toHaveBeenCalled();
		expect(internals.controller.isReadOnly()).toBe(false);
	});

	it('keeps every page’s ink where it was when a page is deleted there', async () => {
		const { internals, onDiskPages, remote } = await open();
		internals.controller.place(1, onScreen(stroke('ink-ours', 500)));
		await remote((doc) => doc.removePage(1));
		await vi.advanceTimersByTimeAsync(5000);

		expect(await onDiskPages()).toEqual([['ink-a', 'ink-ours']]);
	});

	it('says so when the page with ink not saved yet was the one deleted there', async () => {
		const { internals, onDiskPages, remote } = await open();
		internals.controller.place(2, onScreen(stroke('ink-ours', 500)));
		await remote((doc) => doc.removePage(1));
		await vi.advanceTimersByTimeAsync(5000);

		expect(await onDiskPages()).toEqual([['ink-a']]);
		expect(notices.some((message) => message.includes('page 2 was deleted on another device'))).toBe(true);
	});
});
