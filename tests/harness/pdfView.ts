import { vi } from 'vitest';
import { TFile } from './obsidian';
import { installSurfaceStubs, makePointerEvent } from './surface';
import { ToolState, type Annotation } from '../../src/annotate';
import { PdfAnnotateView } from '../../src/pdfView';

// A PDF view with a file "open", built without a worker or pdf.js: the state
// onLoadFile and renderPage would leave behind is set directly, and the
// writer is a fake that records what each save was asked to write.
//
// Needs a jsdom environment in the test file that uses it.

export interface WrittenPage {
	pageNumber: number;
	annotations: Annotation[];
}

// Obsidian adds `empty` to every element; teardown uses it.
(HTMLElement.prototype as unknown as { empty(): void }).empty = function (this: HTMLElement) {
	this.replaceChildren();
};

// A PDF-shaped byte buffer, enough for writeBinarySafely's sniff test.
function pdfBytes(): ArrayBuffer {
	const bytes = new Uint8Array(400);
	bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
	return bytes.buffer;
}

// A pdf.js viewport reduced to what the view's coordinate conversion uses:
// a uniform scale, no rotation, origin at the top left.
export function fakeViewport(scale: number) {
	return {
		scale,
		convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
		convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
	};
}

export function openPdfView(options: { toolState?: ToolState; writeDone?: () => Promise<void> } = {}) {
	const writes: WrittenPage[][] = [];
	let terminated = false;
	const writer = {
		write: vi.fn(async (pages: WrittenPage[]) => {
			writes.push(pages.map((p) => ({ pageNumber: p.pageNumber, annotations: structuredClone(p.annotations) })));
			// A save that takes as long as the test says, the way one of a
			// large book does on a tablet.
			await options.writeDone?.();
			return { mode: 'rewrite', bytes: pdfBytes() };
		}),
		commit: vi.fn(async () => {}),
		abandon: vi.fn(async () => {}),
		terminate: vi.fn(() => {
			terminated = true;
		}),
	};
	// File events the view listens to, kept so a test can fire one — a sync
	// landing another device's save, say.
	const vaultListeners = new Map<string, Array<(file: unknown) => void>>();
	const vault = {
		modifyBinary: vi.fn(async () => {}),
		adapter: { stat: vi.fn(async () => ({ size: 400 })) },
		on: (name: string, listener: (file: unknown) => void) => {
			vaultListeners.set(name, [...(vaultListeners.get(name) ?? []), listener]);
			return {};
		},
		trigger: (name: string, file: unknown) => {
			for (const listener of vaultListeners.get(name) ?? []) listener(file);
		},
	};
	const leaf = { app: { vault, workspace: { on: () => ({}), getLeavesOfType: () => [] } } };
	const view = new PdfAnnotateView(leaf as never, options.toolState ?? new ToolState());
	const file = new TFile('Notes/Handwritten.pdf');

	const internals = view as unknown as {
		file: TFile | null;
		close(): Promise<void>;
		open(): Promise<void>;
		currentFile: TFile | null;
		writer: unknown;
		viewports: Map<number, unknown>;
		baseScales: Map<number, number>;
		renderedScales: Map<number, number>;
		visiblePages: Set<number>;
		controller: {
			seedPage(page: number, annotations: Annotation[]): void;
			getPageAnnotations(page: number): Annotation[];
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			setTool(tool: 'pen'): void;
			setWidth(width: number): void;
			getCurrentPageNumber(): number;
		};
		markPageDirty(page: number): void;
	};
	internals.file = file;
	internals.currentFile = file;
	internals.writer = writer;

	return {
		view,
		writes,
		isTerminated: () => terminated,
		// View.close is not in the public typings, but it is what the
		// workspace calls when the leaf switches away from this view.
		close: () => internals.close(),
		// What the workspace does when the leaf first shows this view.
		open: () => internals.open(),
		// A page as renderPage leaves it: a viewport, and the file's saved
		// annotations for it (given here in canvas space) in the store.
		showPage(pageNumber: number, scale: number, annotations: Annotation[] = []) {
			internals.viewports.set(pageNumber, fakeViewport(scale));
			internals.controller.seedPage(pageNumber, annotations);
		},
		// What an edit does to the view: the page becomes due for a save.
		markDirty: (pageNumber: number) => internals.markPageDirty(pageNumber),
		pageAnnotations: (pageNumber: number) => internals.controller.getPageAnnotations(pageNumber),
		setPenWidth: (width: number) => internals.controller.setWidth(width),
		currentPage: () => internals.controller.getCurrentPageNumber(),
		// Lays pages out down the scroll container, `height` CSS pixels each,
		// with the container showing `viewportHeight` of them scrolled to
		// `scrollTop` — and tells the view it scrolled.
		scrollPagesTo(options: { pages: number; height: number; viewportHeight: number; scrollTop: number }) {
			const container = view.contentEl;
			container.getBoundingClientRect = () => rect(0, options.viewportHeight);
			container.replaceChildren();
			for (let pageNumber = 1; pageNumber <= options.pages; pageNumber++) {
				const placeholder = container.appendChild(document.createElement('div'));
				placeholder.className = 'inkling-pdf-page-placeholder';
				placeholder.dataset.pageNumber = String(pageNumber);
				const top = (pageNumber - 1) * options.height - options.scrollTop;
				placeholder.getBoundingClientRect = () => rect(top, options.height);
				internals.visiblePages.add(pageNumber);
			}
			container.dispatchEvent(new Event('scroll'));
		},
		// A page mounted and drawable, backed at `rendered` after first
		// rendering at `base` — a page a zoom has since sharpened, when the
		// two differ.
		mountDrawablePage(pageNumber: number, scales: { base: number; rendered: number }) {
			installSurfaceStubs();
			internals.baseScales.set(pageNumber, scales.base);
			internals.renderedScales.set(pageNumber, scales.rendered);
			internals.viewports.set(pageNumber, fakeViewport(scales.rendered));
			const host = document.body.appendChild(document.createElement('div'));
			internals.controller.mountPage(pageNumber, host, 800, 1000);
			internals.controller.setTool('pen');
			const canvases = Array.from(host.querySelectorAll('canvas'));
			for (const canvas of canvases) {
				canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000, toJSON: () => ({}) });
			}
			const overlay = canvases[1];
			if (!overlay) throw new Error('mountPage built no overlay canvas');
			return {
				drawStroke(points: Array<[number, number]>) {
					points.forEach(([x, y], i) => {
						overlay.dispatchEvent(makePointerEvent(i === 0 ? 'pointerdown' : 'pointermove', { clientX: x, clientY: y }));
					});
					const last = points[points.length - 1];
					if (last) overlay.dispatchEvent(makePointerEvent('pointerup', { clientX: last[0], clientY: last[1] }));
				},
			};
		},
	};
}

function rect(top: number, height: number): DOMRect {
	return { x: 0, y: top, left: 0, top, right: 800, bottom: top + height, width: 800, height, toJSON: () => ({}) };
}
