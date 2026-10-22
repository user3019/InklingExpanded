import { AnnotationController, type AnnotationControllerOptions } from '../../src/annotate/controller';
import type { Annotation, Point } from '../../src/annotate/types';

// A drawing surface that runs outside Obsidian, so the wiring between the
// controller, the pointer layer and the renderer can be tested.
//
// Every bug that cost real work on 2026-09-06 shared a shape: correct logic
// wired to something that quietly ignored it — an IntersectionObserver
// rooted at the viewport, an editor write into a buffer nothing persists, a
// `hidden` attribute an author rule outranks. None threw, and all of them
// passed a suite that tests pure functions thoroughly. What the suite could
// not do was mount anything and watch what happened.
//
// This is deliberately small. The controller path — controller, pointer,
// render, store, eraser, geometry, stroke — imports nothing from the
// Obsidian API at all; the only thing it borrows is `createEl`. So the gap
// between "runs in a test" and "runs in the app" is a canvas, a Path2D, a
// PointerEvent and one DOM helper, all faked here.

interface DrawCall {
	op: string;
	args: unknown[];
}

interface FakeContext {
	canvas: { width: number; height: number };
	calls: DrawCall[];
}

// Every method render.ts reaches for. Recorded rather than executed: the
// question these tests ask is "what was the renderer asked to draw", which
// pixels would only obscure.
const CONTEXT_METHODS = [
	'save',
	'restore',
	'clearRect',
	'beginPath',
	'closePath',
	'moveTo',
	'lineTo',
	'quadraticCurveTo',
	'bezierCurveTo',
	'arc',
	'ellipse',
	'rect',
	'fill',
	'stroke',
	'fillRect',
	'strokeRect',
	'roundRect',
	'setLineDash',
	'setTransform',
	'translate',
	'scale',
] as const;

function makeContext(canvas: HTMLCanvasElement): FakeContext {
	const calls: DrawCall[] = [];
	const ctx = { canvas, calls } as unknown as FakeContext & Record<string, unknown>;
	for (const op of CONTEXT_METHODS) {
		ctx[op] = (...args: unknown[]) => {
			calls.push({ op, args });
		};
	}
	return ctx;
}

class FakePath2D {
	readonly calls: DrawCall[] = [];
	moveTo(...args: unknown[]): void {
		this.calls.push({ op: 'moveTo', args });
	}
	lineTo(...args: unknown[]): void {
		this.calls.push({ op: 'lineTo', args });
	}
	quadraticCurveTo(...args: unknown[]): void {
		this.calls.push({ op: 'quadraticCurveTo', args });
	}
	closePath(): void {
		this.calls.push({ op: 'closePath', args: [] });
	}
}

export interface PointerOptions {
	pointerId?: number;
	pointerType?: string;
	pressure?: number;
	isPrimary?: boolean;
	button?: number;
	// The buttons held, as a bit mask: 2 a stylus's side button, 32 its
	// eraser end.
	buttons?: number;
}

class FakePointerEvent extends Event {
	pointerId: number;
	pointerType: string;
	pressure: number;
	isPrimary: boolean;
	button: number;
	buttons: number;
	width = 1;
	height = 1;
	clientX: number;
	clientY: number;

	constructor(type: string, init: PointerOptions & { clientX: number; clientY: number }) {
		super(type, { bubbles: true, cancelable: true });
		this.pointerId = init.pointerId ?? 1;
		this.pointerType = init.pointerType ?? 'pen';
		this.pressure = init.pressure ?? 0.5;
		this.isPrimary = init.isPrimary ?? true;
		this.button = init.button ?? 0;
		this.buttons = init.buttons ?? (type === 'pointerup' ? 0 : 1);
		this.clientX = init.clientX;
		this.clientY = init.clientY;
	}
}

export function makePointerEvent(type: string, init: PointerOptions & { clientX: number; clientY: number }): Event {
	return new FakePointerEvent(type, init);
}

// Which pointer ids each element currently holds capture of. A WeakMap so
// an element torn down between tests takes its entry with it, plus the
// reverse lookup an implicit release needs.
const capturedPointers = new WeakMap<Element, Set<number>>();
const captureHolders = new Map<number, Element>();
let releaseInstalled = false;

// The width every element reports in the absence of real layout. Matches the
// default stored block width, so the canvas scale works out to exactly 1.
const LAYOUT_WIDTH = 800;

/** Whether `el` currently holds pointer capture for `pointerId`. */
export function hasCapturedPointer(el: Element, pointerId = 1): boolean {
	return capturedPointers.get(el)?.has(pointerId) ?? false;
}

interface ElementInfo {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
	type?: string;
	href?: string;
}

function applyInfo(el: Element, info?: ElementInfo): void {
	if (!info) return;
	if (info.cls) el.setAttribute('class', info.cls);
	if (info.text !== undefined) el.textContent = info.text;
	for (const [name, value] of Object.entries(info.attr ?? {})) el.setAttribute(name, value);
	if (info.type) el.setAttribute('type', info.type);
	if (info.href) el.setAttribute('href', info.href);
}

// Installs everything the plugin expects a browser — and Obsidian — to have
// and jsdom does not. Idempotent, so a test file can call it once at the top.
//
// The DOM helpers below are Obsidian's, not the platform's: createEl and its
// relatives are added to Element.prototype by the app itself, which is why
// the obsidianmd lint rules insist on them and why nothing outside Obsidian
// can call them without this.
export function installSurfaceStubs(): void {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: Element, tag: string, info?: ElementInfo): HTMLElement {
			const child = this.ownerDocument.createElement(tag);
			applyInfo(child, info);
			this.appendChild(child);
			return child;
		};
		proto.createDiv = function (this: Element, info?: ElementInfo): HTMLElement {
			return (this as unknown as { createEl: (tag: string, info?: ElementInfo) => HTMLElement }).createEl('div', info);
		};
		proto.createSpan = function (this: Element, info?: ElementInfo): HTMLElement {
			return (this as unknown as { createEl: (tag: string, info?: ElementInfo) => HTMLElement }).createEl('span', info);
		};
		proto.createSvg = function (this: Element, tag: string, info?: ElementInfo): SVGElement {
			const child = this.ownerDocument.createElementNS('http://www.w3.org/2000/svg', tag);
			applyInfo(child, info);
			this.appendChild(child);
			return child;
		};
		proto.addClass = function (this: Element, ...classes: string[]): void {
			this.classList.add(...classes);
		};
		proto.removeClass = function (this: Element, ...classes: string[]): void {
			this.classList.remove(...classes);
		};
		proto.toggleClass = function (this: Element, classes: string | string[], value: boolean): void {
			for (const name of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(name, value);
		};
		proto.setText = function (this: Element, text: string): void {
			this.textContent = text;
		};
		// Custom properties, so the stylesheet can size a block from values
		// only the plugin knows — jsdom's setProperty handles `--` names.
		proto.setCssProps = function (this: Element, props: Record<string, string>): void {
			for (const [name, value] of Object.entries(props)) {
				(this as HTMLElement).style.setProperty(name, value);
			}
		};
		proto.detach = function (this: Element): void {
			this.remove();
		};
		proto.empty = function (this: Element): void {
			this.replaceChildren();
		};

		// Pointer capture, which jsdom has no implementation of at all.
		//
		// Stubbed rather than left absent: the production code already
		// tolerates its absence, so a missing implementation quietly turned
		// every test into the degraded path and left the captured one — the
		// one that actually runs on a tablet — untested. Recording the calls
		// makes "was this pointer captured" something a test can assert.
		proto.setPointerCapture = function (this: Element, pointerId: number): void {
			const held = capturedPointers.get(this);
			if (held) held.add(pointerId);
			else capturedPointers.set(this, new Set([pointerId]));
			captureHolders.set(pointerId, this);
		};
		proto.releasePointerCapture = function (this: Element, pointerId: number): void {
			capturedPointers.get(this)?.delete(pointerId);
			captureHolders.delete(pointerId);
		};
		proto.hasPointerCapture = function (this: Element, pointerId: number): boolean {
			return capturedPointers.get(this)?.has(pointerId) ?? false;
		};
	}

	// Capture ends implicitly at the end of a gesture. That is the browser's
	// doing, not the plugin's — which is why pointer.ts only ever releases
	// capture explicitly in the touch-pan path, and why a stub that held on
	// to it past pointerup would misreport perfectly correct code as leaking.
	if (!releaseInstalled) {
		releaseInstalled = true;
		const release = (event: Event): void => {
			const pointerId = (event as unknown as { pointerId?: number }).pointerId;
			if (pointerId === undefined) return;
			const holder = captureHolders.get(pointerId);
			if (!holder) return;
			capturedPointers.get(holder)?.delete(pointerId);
			captureHolders.delete(pointerId);
		};
		document.addEventListener('pointerup', release);
		document.addEventListener('pointercancel', release);
	}

	// jsdom performs no layout, so every element reports a clientWidth of
	// zero. The plugin measures that width to decide how sharply to back a
	// block's canvases, and treats zero as "not in the layout yet" — so
	// without this the harness silently exercises only the not-yet-measurable
	// path, and any behaviour that depends on knowing the block's width
	// cannot be tested at all.
	//
	// 800 matches the default stored block width, which keeps the scale at
	// exactly 1 and leaves every existing test working in stored units.
	if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, '__inkLayoutWidth')) {
		Object.defineProperty(HTMLElement.prototype, '__inkLayoutWidth', { value: true });
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
			configurable: true,
			get(this: HTMLElement): number {
				const override = (this as unknown as { __clientWidth?: number }).__clientWidth;
				return override ?? LAYOUT_WIDTH;
			},
		});
	}

	// Obsidian puts these in the global scope as well as on Element, and
	// annotate/toolbar.ts builds detached elements with the global form.
	const globalScope = globalThis as unknown as Record<string, unknown>;
	globalScope.createEl ??= (tag: string, info?: ElementInfo): HTMLElement => {
		const child = document.createElement(tag);
		applyInfo(child, info);
		return child;
	};
	globalScope.createDiv ??= (info?: ElementInfo): HTMLElement =>
		(globalScope.createEl as (tag: string, info?: ElementInfo) => HTMLElement)('div', info);
	globalScope.createSpan ??= (info?: ElementInfo): HTMLElement =>
		(globalScope.createEl as (tag: string, info?: ElementInfo) => HTMLElement)('span', info);
	globalScope.createFragment ??= (): DocumentFragment => document.createDocumentFragment();

	const canvasProto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
	canvasProto.getContext = function (this: HTMLCanvasElement): FakeContext {
		const held = this as unknown as { __ctx?: FakeContext };
		// Cached the way a real canvas caches it, because whether a context
		// has been acquired *at all* is one of the things worth asserting:
		// an overlay is only meant to allocate one once something needs
		// drawing on it.
		held.__ctx ??= makeContext(this);
		return held.__ctx;
	};

	const scope = globalThis as unknown as Record<string, unknown>;
	scope.Path2D ??= FakePath2D;
	scope.PointerEvent ??= FakePointerEvent;

	// Synchronous, so a test never has to wait a frame to see the result of
	// a gesture. The controller batches overlay repaints into one per frame.
	scope.requestAnimationFrame = (cb: FrameRequestCallback): number => {
		cb(performance.now());
		return 0;
	};
	scope.cancelAnimationFrame = (): void => undefined;
}

export interface TestSurface {
	controller: AnnotationController;
	host: HTMLElement;
	width: number;
	height: number;
	annotations(): Annotation[];
	/** Whether the overlay canvas has had a 2D context taken from it yet. */
	overlayAcquired(): boolean;
	baseCalls(): DrawCall[];
	pointer(type: string, x: number, y: number, options?: PointerOptions): void;
	/** A complete pen gesture: down, moves, up. */
	drawStroke(points: Array<[number, number]>, options?: PointerOptions): void;
}

const PAGE = 1;

export function mountTestSurface(width = 800, height = 450, options: AnnotationControllerOptions = {}): TestSurface {
	installSurfaceStubs();

	const host = document.createElement('div');
	document.body.appendChild(host);

	const controller = new AnnotationController({ getCurrentPage: () => PAGE, ...options });
	// The shared default is the select tool, which suits a PDF opened to be
	// read. A surface built to be drawn on in a test wants the pen, and
	// leaving it unset is how the first run of these tests came to assert
	// against lasso gestures without noticing.
	controller.setTool('pen');
	controller.mountPage(PAGE, host, width, height);

	const canvases = host.querySelectorAll('canvas');
	const overlay = canvases[1] as HTMLCanvasElement;

	// The surface reports its displayed size as its backing size, so a test
	// works in the same units the file does and no scale is in the way.
	for (const canvas of Array.from(canvases)) {
		canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) });
	}

	const target = overlay;
	const pointer = (type: string, x: number, y: number, options: PointerOptions = {}): void => {
		target.dispatchEvent(new FakePointerEvent(type, { ...options, clientX: x, clientY: y }));
	};

	return {
		controller,
		host,
		width,
		height,
		annotations: () => controller.getPageAnnotations(PAGE),
		overlayAcquired: () => (overlay as unknown as { __ctx?: unknown }).__ctx !== undefined,
		baseCalls: () => ((canvases[0] as unknown as { __ctx?: FakeContext }).__ctx?.calls ?? []),
		pointer,
		drawStroke: (points, options = {}) => {
			const [first, ...rest] = points;
			if (!first) return;
			pointer('pointerdown', first[0], first[1], options);
			for (const [x, y] of rest) pointer('pointermove', x, y, options);
			const last = points[points.length - 1] ?? first;
			pointer('pointerup', last[0], last[1], options);
		},
	};
}

export function pointsOf(annotation: Annotation | undefined): Point[] {
	return annotation && annotation.kind === 'stroke' ? annotation.points : [];
}
