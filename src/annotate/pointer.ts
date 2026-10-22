import { Point } from './types';

export interface GestureHandlers {
	onStart(point: Point, event: PointerEvent): void;
	onMove(point: Point, event: PointerEvent): void;
	onEnd(point: Point, event: PointerEvent): void;
	onCancel(event: PointerEvent): void;
	// Fired on every pen/mouse pointermove — hovering or mid-gesture alike —
	// plus once with `null` when the pointer leaves the canvas. Lets a tool
	// (the eraser's outline, currently) track where the pointer is without
	// needing an active gesture. Optional since most tools don't care.
	onHover?(point: Point | null): void;
	// Fired with every pen event over the page — hovering, touching, lifting,
	// leaving — before anything else sees it: what the pen's own buttons are
	// doing. A side button held is a tool held, and the pen can be in the air
	// when it is pressed, or already writing.
	onPenButtons?(point: Point, event: PointerEvent): void;
	// Fired on every pinch-zoom move, and once more at the end — lets a live
	// zoom-level indicator (the toolbar's) stay current throughout the
	// gesture, not just once it settles.
	onZoomChange?(scale: number): void;
	// Fired once when a pinch-zoom gesture ends (never mid-pinch — a
	// zoom-triggered PDF re-render is real work, so it only ever happens
	// once the user's fingers actually settle), with the page's current
	// zoom scale. Lets the PDF-specific view re-render that page at a
	// matching resolution so it — and the ink on it — stay sharp instead of
	// just being a blown-up copy of the original lower-resolution render.
	onZoomEnd?(scale: number): void;
	// Present when the host zooms its whole view rather than one page at a
	// time — the PDF view does, the way a PDF reader does. Every way of
	// moving about (touch, pinch, trackpad, wheel zoom, middle-button drag)
	// is then left to bubble up to the host's attachViewNavigation, which
	// sees them wherever they land rather than only over a page.
	viewZoom?: ViewZoom;
	// Whether a finger draws, as a pen does, rather than moving the page.
	// See ToolState.isTouchDrawing. A second finger still means a pinch:
	// the stroke the first one began is given up (onAbandon) and the two
	// zoom and pan together.
	touchDraws?(): boolean;
	onAbandon?(): void;
	// Whether a finger landing here belongs to the page rather than to
	// moving the view: on a selection's frame, a handle, or a picture's
	// buttons, which a finger has to be able to use on a phone or a tablet
	// with no pen. Everywhere else a finger scrolls as always.
	claimsTouch?(point: Point): boolean;
	// A finger that touched and lifted without moving: a tap, not a scroll —
	// on a page, where it lets go of a selection or picks something out.
	onTouchTap?(point: Point): void;
}

// How long and how far a finger may press and still be a tap.
const TAP_MS = 350;
const TAP_SLOP = 8;

// Whether a pen's tip — or its eraser end — is on the glass. Not simply "a
// pointerdown came": a side button pressed in the air is one too, and a tip
// lifted with the side button still held sends no pointerup, because a
// button still is. Nor "the left button is down": Android reports a side
// button as exactly that (see AnnotationController.readPenButtons). A pen
// in the air reports no pressure; one without a pressure sensor reports
// 0.5 for as long as it touches.
function penTouches(event: PointerEvent): boolean {
	return event.pressure > 0;
}

// Fingers that are drawing, by pointer id. Module scope because two
// listeners need to agree on them: a page's, which draws with them, and a
// view's navigation (attachViewNavigation), which must not also scroll the
// page under them — but must count them when a second finger makes a pinch.
const drawingTouches = new Set<number>();

export function isDrawingTouch(pointerId: number): boolean {
	return drawingTouches.has(pointerId);
}

// A zoom of everything the host scrolls: every page grows or shrinks
// together and the view scrolls across them, so that zooming in on one
// page and then scrolling to the next leaves the next zoomed too.
export interface ViewZoom {
	readonly min: number;
	readonly max: number;
	get(): number;
	// Whatever is under a client-space point, in a form that survives the
	// layout changing underneath it — which every zoom step does.
	anchorAt(at: Point): ViewAnchor;
	// Zooms to `scale` (clamped) and scrolls so that `anchor` is under the
	// client-space point `at`. A pinch passes the same anchor on every move
	// with the fingers' current midpoint, which is what lets two fingers
	// zoom and pan at once.
	zoomTo(scale: number, anchor: ViewAnchor, at: Point): void;
	// The middle of the view, for a zoom that has no pointer to aim at.
	centre(): Point;
	// The gesture is over: a good moment for re-rendering at the new size,
	// which would be wasted work on every step of a pinch.
	settle(): void;
}

// Opaque to everything but the host that made it.
export type ViewAnchor = unknown;

// A real stylus tip's contact patch is a couple of CSS pixels at most; a
// palm or a knuckle resting on the glass is tens of pixels wide. Some
// Android vendors/WebViews misreport an accidental palm touch as
// `pointerType: 'pen'` instead of `'touch'` (a known real-world gap in an
// otherwise spec-following stack — see the plan's Architecture notes on
// stylus behavior varying across devices), so contact-geometry size is a
// second, independent signal on top of pointerType. Devices that can't
// measure contact geometry report width/height as 1, so this only ever
// rejects an implausibly large "pen" contact, never a normal one.
const MAX_PLAUSIBLE_PEN_CONTACT_PX = 40;

// Stylus pointer-capture behavior varies across Android vendors/WebViews in
// practice (see the plan's Architecture notes) — a capture failure shouldn't
// abort the whole gesture, just lose the "keeps tracking outside the
// element" benefit.
//
// Reported once per session, not once per gesture. A device whose capture
// fails will fail on every single stroke, and one console message per
// stroke is exactly the noise Obsidian's plugin guidelines ask plugins not
// to produce — enough to bury anything else in the console during a
// handwriting session.
let pointerCaptureFailureLogged = false;

export function capturePointer(el: Element, pointerId: number): void {
	try {
		el.setPointerCapture(pointerId);
	} catch (error) {
		if (pointerCaptureFailureLogged) return;
		pointerCaptureFailureLogged = true;
		console.error(
			'Inkling: setPointerCapture failed; continuing without it. Further failures this session will not be logged.',
			error,
		);
	}
}

// Pinch-zoom lets writing be more precise than the page's base render scale
// would otherwise allow: zooming in means the same physical pen movement
// covers fewer canvas pixels, so strokes drawn while zoomed come out finer.
// Keyed by each page's `.inkling-page-content` wrapper element (see
// pdfView.ts) rather than closed over per attachPointerGestures call, so
// zoom state survives independently of — and outlives — any single
// gesture, and each page keeps its own.
interface Zoom {
	scale: number;
	x: number;
	y: number;
}

const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

const zoomState = new WeakMap<HTMLElement, Zoom>();

function getZoom(content: HTMLElement): Zoom {
	return zoomState.get(content) ?? { scale: MIN_ZOOM, x: 0, y: 0 };
}

function applyZoom(content: HTMLElement, zoom: Zoom): void {
	zoomState.set(content, zoom);
	content.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
}

function distance(a: Point, b: Point): number {
	return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

// However far zoomed content is panned, its edges can never be dragged
// past the viewport's own edges — otherwise panning could leave blank
// space showing on one side with no way back except zooming out again.
function clampTranslate(x: number, y: number, scale: number, width: number, height: number): Point {
	return {
		x: clamp(x, width * (1 - scale), 0),
		y: clamp(y, height * (1 - scale), 0),
	};
}

// The scrolling container an element actually sits in — the editor's
// scroller in Live Preview, the preview scroller in reading view, the PDF
// view's own content area. Exported because touch panning is not the only
// thing that needs it: an ink block's autosave has to put the note back
// where it was afterwards (see markdown/inkBlock.ts).
export function findScrollParent(el: HTMLElement): HTMLElement | null {
	return findScroller(el, 'y') ?? findScroller(el, 'x');
}

// Vertical first, which is the only kind there used to be, so every surface
// that scrolled before scrolls the same element now. Sideways only when
// nothing scrolls down: an infinite canvas on a phone in portrait can be
// wider than the screen while still short enough to fit it.
function findScroller(el: HTMLElement, axis: 'x' | 'y'): HTMLElement | null {
	let node = el.parentElement;
	while (node) {
		const style = getComputedStyle(node);
		const overflow = axis === 'y' ? style.overflowY : style.overflowX;
		const overflowing = axis === 'y' ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth;
		if ((overflow === 'auto' || overflow === 'scroll') && overflowing) return node;
		node = node.parentElement;
	}
	return null;
}

// Flick-to-scroll (momentum), and the constants governing how it decays.
// Touch panning here is implemented by hand rather than left to the browser
// (see attachPointerGestures' comment for why), and hand-rolled panning
// stops dead the instant a finger lifts — no glide, which is most of what
// made scrolling in edit mode feel worse than the native PDF view. These
// restore the part the browser would otherwise have done.
//
// Module scope, not per-canvas: gestures are attached per page, but a flick
// started on one page keeps scrolling across others, and *any* new touch
// anywhere has to stop it — the way tapping a scrolling page halts it
// everywhere else.
const MOMENTUM_FRICTION = 0.94; // per 16ms frame; ~1s of glide
const MOMENTUM_MIN_VELOCITY = 0.05; // px/ms — below this, stop
const MOMENTUM_START_VELOCITY = 0.15; // px/ms — a slow release just stops
// Velocity is smoothed across moves so one erratic final sample (common as
// a finger lifts) can't throw the whole flick.
const VELOCITY_SMOOTHING = 0.7;

let momentumFrame: number | null = null;

function stopMomentum(): void {
	if (momentumFrame === null) return;
	window.cancelAnimationFrame(momentumFrame);
	momentumFrame = null;
}

// Both axes, though a page of a book only ever scrolls down: an infinite
// canvas (see pdf/infiniteCanvas.ts) is wider than the pane, and a flick
// across it should glide sideways the same way a flick down a book does.
// Where there is nowhere to go sideways, setting scrollLeft does nothing.
function startMomentum(scrollParent: HTMLElement, velocityX: number, velocityY: number): void {
	stopMomentum();
	if (Math.hypot(velocityX, velocityY) < MOMENTUM_START_VELOCITY) return;

	let currentX = velocityX;
	let currentY = velocityY;
	let previous = performance.now();

	const step = (now: number) => {
		momentumFrame = null;
		// Scaled by real elapsed time so the glide covers the same distance
		// whether the display runs at 60Hz or 120Hz (tablets often do).
		const elapsed = Math.min(now - previous, 64);
		previous = now;

		const beforeLeft = scrollParent.scrollLeft;
		const beforeTop = scrollParent.scrollTop;
		scrollParent.scrollLeft = beforeLeft - currentX * elapsed;
		scrollParent.scrollTop = beforeTop - currentY * elapsed;
		// Hit an edge in every direction it was moving — nothing left to
		// glide through.
		if (scrollParent.scrollLeft === beforeLeft && scrollParent.scrollTop === beforeTop) return;

		const decay = Math.pow(MOMENTUM_FRICTION, elapsed / 16);
		currentX *= decay;
		currentY *= decay;
		if (Math.hypot(currentX, currentY) < MOMENTUM_MIN_VELOCITY) return;
		momentumFrame = window.requestAnimationFrame(step);
	};

	momentumFrame = window.requestAnimationFrame(step);
}

// Zooms a page to `targetScale` while holding whatever sits under `screen`
// (a client-space point) in place. Shared by the pinch handler below, the
// Ctrl/Cmd+wheel handler, and the toolbar buttons — one implementation, so
// zooming behaves identically however it was asked for. Returns the scale
// actually applied, which is the requested one clamped to the allowed
// range.
export function zoomAbout(content: HTMLElement, placeholder: HTMLElement, targetScale: number, screen: Point): number {
	const rect = placeholder.getBoundingClientRect();
	const zoom = getZoom(content);
	// The content-space point currently under `screen`, solved from the
	// transform already applied — then held fixed by solving the same
	// transform for translate at the new scale.
	const anchor: Point = {
		x: (screen.x - rect.left - zoom.x) / zoom.scale,
		y: (screen.y - rect.top - zoom.y) / zoom.scale,
	};
	const scale = clamp(targetScale, MIN_ZOOM, MAX_ZOOM);
	const translate = clampTranslate(
		screen.x - rect.left - anchor.x * scale,
		screen.y - rect.top - anchor.y * scale,
		scale,
		rect.width,
		rect.height,
	);
	applyZoom(content, { scale, x: translate.x, y: translate.y });
	return scale;
}

export function currentZoom(content: HTMLElement): number {
	return getZoom(content).scale;
}

// A page's own zoom in full — its scale and where it is panned to — for a
// surface that is rebuilt and has to come back the way it was left. See
// markdown/inkBlock.ts, whose blocks are rebuilt by every save.
export type ContentZoom = Readonly<Zoom>;

export function contentZoom(content: HTMLElement): ContentZoom {
	return { ...getZoom(content) };
}

export function setContentZoom(content: HTMLElement, zoom: ContentZoom): void {
	applyZoom(content, { scale: clamp(zoom.scale, MIN_ZOOM, MAX_ZOOM), x: zoom.x, y: zoom.y });
}

// How hard a wheel notch zooms. Exponential rather than additive so the
// same gesture covers the same proportion of the range wherever it starts
// — additive steps crawl when zoomed in and lurch when zoomed out.
const WHEEL_ZOOM_SENSITIVITY = 0.002;

// A wheel produces a burst of events with no end signal of its own.
// onZoomEnd triggers a full page re-render at a higher resolution, which
// is real work, so it waits for the burst to stop rather than firing once
// per notch.
const WHEEL_SETTLE_MS = 200;

// Palm rejection: touch pans/scrolls the page, pen and mouse draw — required
// for both Apple Pencil and S Pen. Real-device testing (Samsung S Pen) found
// that relying on native `touch-action`-driven panning for the touch side
// isn't reliable enough here: `touch-action: pan-y` doesn't just permit
// touch to pan, it authorizes the browser to recognize a vertical pan from
// *any* pointer's movement, and toggling it dynamically per-gesture still
// let a downward pen stroke get taken over mid-draw on that device. So
// `touch-action` on the canvas is `none` unconditionally (see styles.css)
// and touch panning is implemented by hand below instead of leaned on the
// browser for — full, deterministic control instead of depending on
// cross-device native-gesture-recognition timing.
export function attachPointerGestures(el: HTMLCanvasElement, getHandlers: () => GestureHandlers | null): () => void {
	let activePointerId: number | null = null;
	// A pen held above the page with a side button pressed: its tip touching
	// starts a stroke, though no pointerdown says so. See penMoved.
	let penInAir: number | null = null;
	// A finger that may turn out to be a tap: where and when it came down.
	// Apart from touchPan, which needs something to scroll; a tap does not.
	let touchTap: { pointerId: number; startTime: number; x: number; y: number } | null = null;
	let touchPan: {
		pointerId: number;
		startX: number;
		startY: number;
		scrollLeft: number;
		scrollTop: number;
		scrollParent: HTMLElement;
		// Last sample, for the flick velocity handed to startMomentum below.
		lastX: number;
		lastY: number;
		lastTime: number;
		velocityX: number;
		velocityY: number;
	} | null = null;
	// Every currently-down touch's latest screen position — tracked
	// independently of touchPan/pinch so a second touch joining mid-gesture
	// always has both points available to compute a starting pinch distance
	// and midpoint from.
	const touches = new Map<number, Point>();
	let pinch: { ids: [number, number]; startDistance: number; startScale: number; anchor: Point; content: HTMLElement; placeholder: HTMLElement } | null = null;

	// event.clientX/Y are in CSS pixels relative to the canvas's rendered
	// (possibly shrunk-to-fit, e.g. by the page placeholder's max-width:
	// 100% on a narrow phone screen) size — but every stroke coordinate is
	// stored, and every draw call issued, in the canvas's *backing-store*
	// pixel space (canvas.width/height, set from the pdf.js viewport). On
	// desktop those two sizes are usually equal so this was invisible; on a
	// phone where the page is scaled down to fit, skipping this conversion
	// put every stroke closer to the canvas's top-left origin than the
	// actual touch point, worse the further out you drew — exactly the
	// "appears diagonally above the pen tip, inconsistently" symptom.
	const toPoint = (event: PointerEvent): Point => {
		const rect = el.getBoundingClientRect();
		const scaleX = rect.width === 0 ? 1 : el.width / rect.width;
		const scaleY = rect.height === 0 ? 1 : el.height / rect.height;
		const point: Point = { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY };
		// Pen only. A mouse reports a constant 0.5 for as long as a button is
		// held, so honouring it would render every desktop stroke as a
		// uniform ribbon at half weight — worse than having no pressure at
		// all. A pressure of exactly 0 is a hover sample, not a feather-light
		// touch, and would draw a stroke that pinches to nothing.
		if (event.pointerType === 'pen' && Number.isFinite(event.pressure) && event.pressure > 0) {
			point.p = Math.min(event.pressure, 1);
		}
		return point;
	};

	const isImplausiblePenContact = (event: PointerEvent): boolean =>
		event.pointerType === 'pen' && (event.width > MAX_PLAUSIBLE_PEN_CONTACT_PX || event.height > MAX_PLAUSIBLE_PEN_CONTACT_PX);

	const startTouchPan = (event: PointerEvent): void => {
		// Only one pointer drives panning at a time — a second one (e.g. an
		// incidental palm-edge contact) is ignored rather than fighting the
		// first for control.
		if (touchPan) return;
		const scrollParent = findScrollParent(el);
		if (!scrollParent) return;
		touchPan = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			scrollLeft: scrollParent.scrollLeft,
			scrollTop: scrollParent.scrollTop,
			scrollParent,
			lastX: event.clientX,
			lastY: event.clientY,
			lastTime: event.timeStamp,
			velocityX: 0,
			velocityY: 0,
		};
		capturePointer(el, event.pointerId);
		event.preventDefault();
	};

	// A second touch joining an existing one hands off from single-finger
	// scroll-pan to two-finger pinch-zoom/pan instead — the two are mutually
	// exclusive, never simultaneous.
	const startPinch = (): void => {
		if (touchPan) {
			try {
				el.releasePointerCapture(touchPan.pointerId);
			} catch {
				// Already released (e.g. the pointer that had capture is the
				// one still down) — nothing left to clean up.
			}
			touchPan = null;
		}
		const ids = [...touches.keys()] as [number, number];
		const p1 = touches.get(ids[0]);
		const p2 = touches.get(ids[1]);
		if (!p1 || !p2) return;
		const mid = midpoint(p1, p2);

		const content = el.parentElement;
		const placeholder = content?.parentElement;
		if (!content || !placeholder) return;

		const rect = placeholder.getBoundingClientRect();
		const zoom = getZoom(content);
		// The content-space (i.e. pre-transform) point currently sitting
		// under the fingers' midpoint — held fixed on screen for the rest of
		// the gesture by solving the same transform for translate on every
		// subsequent move below.
		const anchor: Point = {
			x: (mid.x - rect.left - zoom.x) / zoom.scale,
			y: (mid.y - rect.top - zoom.y) / zoom.scale,
		};
		pinch = { ids, startDistance: distance(p1, p2), startScale: zoom.scale, anchor, content, placeholder };
	};

	const onPointerDown = (event: PointerEvent) => {
		if (isImplausiblePenContact(event)) return;

		// Any contact at all halts a glide in progress — including a pen
		// coming down to write, so ink never lands on a page still sliding
		// under the tip.
		stopMomentum();

		const handlers = getHandlers();
		if (event.pointerType === 'pen') {
			handlers?.onPenButtons?.(toPoint(event), event);
			// The side button pressed with the pen in the air — the way most
			// people hold it down before writing. A tool to hold, not a
			// stroke: the stroke starts when the tip touches, which, with a
			// button already down, comes as a pointermove (below).
			if (!penTouches(event)) {
				penInAir = event.pointerId;
				event.preventDefault();
				return;
			}
		}
		const viewZoomed = !!handlers?.viewZoom;
		const touchDraws = event.pointerType === 'touch' && (handlers?.touchDraws?.() ?? false);
		const claimed =
			event.pointerType === 'touch' && !touchDraws && touches.size === 0 && (handlers?.claimsTouch?.(toPoint(event)) ?? false);

		if (touchDraws || claimed) {
			// A first finger draws.
			if (activePointerId === null && touches.size === 0 && !pinch && handlers) {
				touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
				drawingTouches.add(event.pointerId);
				activePointerId = event.pointerId;
				capturePointer(el, event.pointerId);
				event.preventDefault();
				handlers.onStart(toPoint(event), event);
				return;
			}
			// A second turns the gesture into a pinch, and what the first had
			// begun to draw is dropped: it was the start of a zoom, not ink.
			if (activePointerId !== null && drawingTouches.has(activePointerId)) {
				drawingTouches.delete(activePointerId);
				activePointerId = null;
				handlers?.onAbandon?.();
			}
		}

		// Moving about is the host's, in a view that zooms as a whole. Left
		// alone here — no capture, no preventDefault — so it bubbles to
		// attachViewNavigation.
		if (viewZoomed && (event.pointerType === 'touch' || event.button === 1)) return;

		// The middle mouse button drags the view about, the way it does in
		// most drawing programs — the one way to move around with a mouse
		// that does not mean putting the pen tool down first.
		if (event.pointerType === 'mouse' && event.button === 1) {
			startTouchPan(event);
			return;
		}
		// A mouse's other buttons draw nothing: a right-click is a request
		// for a menu, not a dot of ink.
		if (event.pointerType === 'mouse' && event.button !== 0) return;

		if (event.pointerType === 'touch') {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			if (touches.size === 2) {
				startPinch();
				capturePointer(el, event.pointerId);
				event.preventDefault();
			} else if (touches.size === 1) {
				touchTap = { pointerId: event.pointerId, startTime: event.timeStamp, x: event.clientX, y: event.clientY };
				startTouchPan(event);
			}
			if (touches.size > 1) touchTap = null;
			return;
		}

		// A gesture is already in progress on a different pointer (e.g. a
		// palm registering as a second, spurious pointer mid-stroke) —
		// ignore it rather than hijacking the active one.
		if (activePointerId !== null) return;
		if (!handlers) return;

		activePointerId = event.pointerId;
		capturePointer(el, event.pointerId);
		event.preventDefault();
		handlers.onStart(toPoint(event), event);
	};

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		}
		if (touchTap?.pointerId === event.pointerId && Math.hypot(event.clientX - touchTap.x, event.clientY - touchTap.y) > TAP_SLOP) {
			touchTap = null;
		}

		if (pinch && pinch.ids.includes(event.pointerId)) {
			const p1 = touches.get(pinch.ids[0]);
			const p2 = touches.get(pinch.ids[1]);
			if (p1 && p2) {
				const rect = pinch.placeholder.getBoundingClientRect();
				const mid = midpoint(p1, p2);
				const scale = clamp((distance(p1, p2) / pinch.startDistance) * pinch.startScale, MIN_ZOOM, MAX_ZOOM);
				const translate = clampTranslate(
					mid.x - rect.left - pinch.anchor.x * scale,
					mid.y - rect.top - pinch.anchor.y * scale,
					scale,
					rect.width,
					rect.height,
				);
				applyZoom(pinch.content, { scale, x: translate.x, y: translate.y });
				getHandlers()?.onZoomChange?.(scale);
			}
			event.preventDefault();
			return;
		}

		if (touchPan && event.pointerId === touchPan.pointerId) {
			touchPan.scrollParent.scrollLeft = touchPan.scrollLeft - (event.clientX - touchPan.startX);
			touchPan.scrollParent.scrollTop = touchPan.scrollTop - (event.clientY - touchPan.startY);

			// Tracked against the previous *sample*, not the gesture start, so
			// this reflects how fast the finger is moving right now — which is
			// what decides the flick — rather than its average over the drag.
			const elapsed = event.timeStamp - touchPan.lastTime;
			if (elapsed > 0) {
				const sampleX = (event.clientX - touchPan.lastX) / elapsed;
				const sampleY = (event.clientY - touchPan.lastY) / elapsed;
				touchPan.velocityX = touchPan.velocityX * (1 - VELOCITY_SMOOTHING) + sampleX * VELOCITY_SMOOTHING;
				touchPan.velocityY = touchPan.velocityY * (1 - VELOCITY_SMOOTHING) + sampleY * VELOCITY_SMOOTHING;
				touchPan.lastX = event.clientX;
				touchPan.lastY = event.clientY;
				touchPan.lastTime = event.timeStamp;
			}
			return;
		}
		// Hover stays on the single event: a cursor does not need sub-frame
		// resolution, and asking for coalesced samples on every hover move
		// would be work spent on a ring that is redrawn once a frame anyway.
		if (event.pointerType === 'pen' && penMoved(event)) return;
		if (event.pointerType !== 'touch') getHandlers()?.onHover?.(toPoint(event));
		if (event.pointerId !== activePointerId) return;
		const handlers = getHandlers();
		if (!handlers) return;

		// A 120Hz stylus delivers several samples per animation frame, and
		// the browser hands over only the last one per pointermove unless
		// asked for the rest. Everything else was being discarded before
		// smoothing ever saw it, which is most of why fast strokes came out
		// polygonal. Guarded because the method is absent on some WebViews,
		// and returns an empty list on others.
		const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
		if (samples.length === 0) {
			handlers.onMove(toPoint(event), event);
			return;
		}
		for (const sample of samples) handlers.onMove(toPoint(sample), sample);
	};

	// A pen's tip touching or lifting while a side button is held. The
	// browser sends a pointerdown and a pointerup only for the first button
	// pressed and the last let go, so these come as pointermoves — and
	// without this a side button held before writing never wrote (or erased)
	// anything, and one held after lifting went on erasing in the air.
	// True when it handled the event.
	const penMoved = (event: PointerEvent): boolean => {
		const handlers = getHandlers();
		handlers?.onPenButtons?.(toPoint(event), event);
		if (!handlers) return false;
		const touching = penTouches(event);
		if (touching && activePointerId === null && penInAir === event.pointerId && !isImplausiblePenContact(event)) {
			penInAir = null;
			stopMomentum();
			activePointerId = event.pointerId;
			capturePointer(el, event.pointerId);
			event.preventDefault();
			handlers.onStart(toPoint(event), event);
			return true;
		}
		if (!touching && event.buttons !== 0 && activePointerId === event.pointerId) {
			activePointerId = null;
			penInAir = event.pointerId;
			handlers.onEnd(toPoint(event), event);
			return true;
		}
		return false;
	};

	const onPointerLeave = (event: PointerEvent) => {
		if (event.pointerType === 'touch') return;
		if (event.pointerType === 'pen') getHandlers()?.onPenButtons?.(toPoint(event), event);
		getHandlers()?.onHover?.(null);
	};

	const endGesture = (event: PointerEvent, cancelled: boolean) => {
		if (penInAir === event.pointerId) penInAir = null;
		if (event.pointerType === 'pen' && event.pointerId !== activePointerId) getHandlers()?.onPenButtons?.(toPoint(event), event);
		if (event.pointerType === 'touch') touches.delete(event.pointerId);
		drawingTouches.delete(event.pointerId);

		// Ends the whole pinch as soon as either finger lifts, rather than
		// trying to seamlessly hand off to single-finger pan with the other —
		// simpler, and a deliberate two-finger gesture ending with one finger
		// still down is rare enough not to be worth the extra state.
		if (pinch && pinch.ids.includes(event.pointerId)) {
			const ended = pinch;
			pinch = null;
			const scale = getZoom(ended.content).scale;
			getHandlers()?.onZoomChange?.(scale);
			getHandlers()?.onZoomEnd?.(scale);
			return;
		}
		const tapped =
			!cancelled &&
			touchTap?.pointerId === event.pointerId &&
			event.timeStamp - touchTap.startTime <= TAP_MS &&
			Math.hypot(event.clientX - touchTap.x, event.clientY - touchTap.y) <= TAP_SLOP;
		if (touchTap?.pointerId === event.pointerId) touchTap = null;
		if (tapped) getHandlers()?.onTouchTap?.(toPoint(event));
		if (touchPan && event.pointerId === touchPan.pointerId) {
			// A cancelled pan (the browser taking the gesture over, a palm
			// landing) shouldn't fling the page — only a real lift does.
			if (!cancelled && !tapped) startMomentum(touchPan.scrollParent, touchPan.velocityX, touchPan.velocityY);
			touchPan = null;
			return;
		}
		if (event.pointerId !== activePointerId) return;
		activePointerId = null;
		const handlers = getHandlers();
		if (cancelled) handlers?.onCancel(event);
		else handlers?.onEnd(toPoint(event), event);
	};

	const onPointerUp = (event: PointerEvent) => endGesture(event, false);
	const onPointerCancel = (event: PointerEvent) => endGesture(event, true);

	// Desktop zoom. A *plain* wheel is left entirely alone — losing
	// document scroll would be a far worse trade than gaining zoom — so
	// this only acts with Ctrl (or Cmd), which is the gesture every
	// other document viewer uses for exactly this.
	let wheelSettleHandle: number | null = null;
	const onWheel = (event: WheelEvent) => {
		if (!event.ctrlKey && !event.metaKey) return;

		// The host zooms the whole view, from wherever the cursor is.
		if (getHandlers()?.viewZoom) return;

		const content = el.parentElement;
		const placeholder = content?.parentElement;
		if (!content || !placeholder) return;
		event.preventDefault();

		const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
		const scale = zoomAbout(content, placeholder, currentZoom(content) * factor, { x: event.clientX, y: event.clientY });
		getHandlers()?.onZoomChange?.(scale);

		if (wheelSettleHandle !== null) window.clearTimeout(wheelSettleHandle);
		wheelSettleHandle = window.setTimeout(() => {
			wheelSettleHandle = null;
			getHandlers()?.onZoomEnd?.(currentZoom(content));
		}, WHEEL_SETTLE_MS);
	};

	el.addEventListener('pointerdown', onPointerDown);
	el.addEventListener('pointermove', onPointerMove);
	el.addEventListener('pointerup', onPointerUp);
	el.addEventListener('pointercancel', onPointerCancel);
	el.addEventListener('pointerleave', onPointerLeave);
	// Not passive: this calls preventDefault to stop the page scrolling
	// as well as zooming, and a passive listener may not.
	el.addEventListener('wheel', onWheel, { passive: false });

	// A trackpad pinch in Safari and on an iPad arrives as WebKit's gesture
	// events, not as a Ctrl+wheel the way Chromium sends one. A pinch with
	// fingers on the glass sends them too, alongside the pointer events the
	// pinch above already follows, so they only act when no touch pinch is
	// under way.
	let gesture: { startScale: number; content: HTMLElement; placeholder: HTMLElement } | null = null;
	const onGestureStart = (event: Event) => {
		const content = el.parentElement;
		const placeholder = content?.parentElement;
		if (getHandlers()?.viewZoom || !content || !placeholder) return;
		event.preventDefault();
		gesture = pinch ? null : { startScale: currentZoom(content), content, placeholder };
	};
	const onGestureChange = (event: Event) => {
		if (!gesture) return;
		event.preventDefault();
		if (pinch) return;
		const { scale, clientX, clientY } = event as WebKitGestureEvent;
		const zoomed = zoomAbout(gesture.content, gesture.placeholder, gesture.startScale * scale, { x: clientX, y: clientY });
		getHandlers()?.onZoomChange?.(zoomed);
	};
	const onGestureEnd = (event: Event) => {
		if (!gesture) return;
		event.preventDefault();
		const scale = currentZoom(gesture.content);
		gesture = null;
		getHandlers()?.onZoomEnd?.(scale);
	};
	el.addEventListener('gesturestart', onGestureStart);
	el.addEventListener('gesturechange', onGestureChange);
	el.addEventListener('gestureend', onGestureEnd);

	// No menu over the page. A stylus's side button is a right button as far
	// as the browser is concerned, and pressing it — or a long press of a
	// finger — opened the context menu over what was being drawn.
	const onContextMenu = (event: Event) => event.preventDefault();
	el.addEventListener('contextmenu', onContextMenu);

	return () => {
		el.removeEventListener('contextmenu', onContextMenu);
		stopMomentum();
		if (wheelSettleHandle !== null) window.clearTimeout(wheelSettleHandle);
		el.removeEventListener('gesturestart', onGestureStart);
		el.removeEventListener('gesturechange', onGestureChange);
		el.removeEventListener('gestureend', onGestureEnd);
		el.removeEventListener('pointerdown', onPointerDown);
		el.removeEventListener('pointermove', onPointerMove);
		el.removeEventListener('pointerup', onPointerUp);
		el.removeEventListener('pointercancel', onPointerCancel);
		el.removeEventListener('pointerleave', onPointerLeave);
		el.removeEventListener('wheel', onWheel);
	};
}

// WebKit's pinch event (Safari, and every browser on iOS and iPadOS),
// which TypeScript's DOM library does not describe.
interface WebKitGestureEvent extends UIEvent {
	readonly scale: number;
	readonly clientX: number;
	readonly clientY: number;
}

export interface ViewNavigationOptions {
	// Parts of the view that keep their own touch handling — a panel that
	// scrolls by itself, a text field — and that a finger on should not
	// move the view.
	ignore(target: EventTarget | null): boolean;
	// Whether a pen or mouse is drawing right now. A touch landing then is a
	// hand resting on the glass, and moves nothing.
	isBusy(): boolean;
	// A pinch is starting — for whatever a finger had begun to draw to be
	// dropped (see GestureHandlers.touchDraws).
	onPinchStart?(): void;
	// A finger held still in one place: the host's to use, at that client
	// point — picking up a picture — or to decline, and the finger scrolls on.
	onLongPress?(at: Point): boolean;
	// A finger that touched and lifted without moving, at that client point.
	onTap?(at: Point): void;
}

// How long a finger has to stay put to be a long press, and how far it may
// wander meanwhile.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

// Everything that moves a whole view about, attached once to its scroll
// container rather than to each page — so that it works wherever a finger
// or the cursor happens to be, the gaps between pages and the margins
// beside them included, the way it does in a PDF reader:
//
//   - one finger drags the view in any direction, and a flick glides on;
//   - two fingers zoom and pan at once, holding still what is under them;
//   - a trackpad pinch zooms about the cursor — Chromium sends it as a
//     Ctrl+wheel, WebKit (Safari, iPad) as gesture events; Ctrl+wheel on a
//     mouse is the same thing;
//   - the middle mouse button drags the view.
//
// A pen and a mouse's main button are not touched: they draw, and the
// page's own handler (attachPointerGestures) has them.
export function attachViewNavigation(scroller: HTMLElement, zoom: ViewZoom, options: ViewNavigationOptions): () => void {
	const touches = new Map<number, Point>();
	let pan: {
		pointerId: number;
		startTime: number;
		startX: number;
		startY: number;
		scrollLeft: number;
		scrollTop: number;
		lastX: number;
		lastY: number;
		lastTime: number;
		velocityX: number;
		velocityY: number;
	} | null = null;
	let pinch: { ids: [number, number]; startDistance: number; startScale: number; anchor: ViewAnchor } | null = null;
	let gesture: { startScale: number; anchor: ViewAnchor } | null = null;
	let wheelSettleHandle: number | null = null;
	let longPress: { pointerId: number; at: Point; timer: number } | null = null;
	const cancelLongPress = () => {
		if (longPress) window.clearTimeout(longPress.timer);
		longPress = null;
	};

	const release = (pointerId: number) => {
		try {
			if (scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId);
		} catch {
			// Already gone with the pointer.
		}
	};

	const startPan = (event: PointerEvent) => {
		pan = {
			pointerId: event.pointerId,
			startTime: event.timeStamp,
			startX: event.clientX,
			startY: event.clientY,
			scrollLeft: scroller.scrollLeft,
			scrollTop: scroller.scrollTop,
			lastX: event.clientX,
			lastY: event.clientY,
			lastTime: event.timeStamp,
			velocityX: 0,
			velocityY: 0,
		};
		capturePointer(scroller, event.pointerId);
		event.preventDefault();
	};

	const onPointerDown = (event: PointerEvent) => {
		const middle = event.pointerType === 'mouse' && event.button === 1;
		if (event.pointerType !== 'touch' && !middle) return;
		if (options.ignore(event.target)) return;
		stopMomentum();

		if (middle) {
			if (!pan) startPan(event);
			return;
		}
		// A finger the page is drawing with: counted, so a second finger can
		// make a pinch with it, but it does not move the view.
		if (isDrawingTouch(event.pointerId)) {
			touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
			return;
		}
		// Busy with a pen: a touch now is the hand holding it. Busy with a
		// drawing finger is different — a second finger means a pinch.
		if (options.isBusy() && drawingTouches.size === 0 && !touches.size) return;

		touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (touches.size === 2 && !pinch) {
			drawingTouches.clear();
			options.onPinchStart?.();
			// A second finger turns a drag into a pinch. The drag stops where
			// it is, without a glide.
			if (pan) release(pan.pointerId);
			pan = null;
			gesture = null;
			const ids = [...touches.keys()] as [number, number];
			const p1 = touches.get(ids[0]);
			const p2 = touches.get(ids[1]);
			if (!p1 || !p2) return;
			pinch = { ids, startDistance: distance(p1, p2), startScale: zoom.get(), anchor: zoom.anchorAt(midpoint(p1, p2)) };
			for (const id of ids) capturePointer(scroller, id);
			event.preventDefault();
		} else if (touches.size === 1) {
			startPan(event);
			if (options.onLongPress) {
				const at = { x: event.clientX, y: event.clientY };
				const pointerId = event.pointerId;
				const timer = window.setTimeout(() => {
					longPress = null;
					if (!pan || pan.pointerId !== pointerId || !options.onLongPress?.(at)) return;
					// Taken: the finger stops moving the view.
					release(pointerId);
					pan = null;
				}, LONG_PRESS_MS);
				longPress = { pointerId, at, timer };
			}
		}
		if (touches.size > 1) cancelLongPress();
	};

	const onPointerMove = (event: PointerEvent) => {
		if (touches.has(event.pointerId)) touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (longPress?.pointerId === event.pointerId && Math.hypot(event.clientX - longPress.at.x, event.clientY - longPress.at.y) > LONG_PRESS_SLOP) {
			cancelLongPress();
		}

		if (pinch && pinch.ids.includes(event.pointerId)) {
			const p1 = touches.get(pinch.ids[0]);
			const p2 = touches.get(pinch.ids[1]);
			if (p1 && p2) zoom.zoomTo((distance(p1, p2) / pinch.startDistance) * pinch.startScale, pinch.anchor, midpoint(p1, p2));
			event.preventDefault();
			return;
		}

		if (!pan || event.pointerId !== pan.pointerId) return;
		// The pen came down while a finger was dragging: that finger is the
		// hand holding the pen, and the page must stay put under the tip.
		if (options.isBusy()) {
			release(pan.pointerId);
			pan = null;
			return;
		}
		scroller.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX);
		scroller.scrollTop = pan.scrollTop - (event.clientY - pan.startY);
		const elapsed = event.timeStamp - pan.lastTime;
		if (elapsed > 0) {
			const sampleX = (event.clientX - pan.lastX) / elapsed;
			const sampleY = (event.clientY - pan.lastY) / elapsed;
			pan.velocityX = pan.velocityX * (1 - VELOCITY_SMOOTHING) + sampleX * VELOCITY_SMOOTHING;
			pan.velocityY = pan.velocityY * (1 - VELOCITY_SMOOTHING) + sampleY * VELOCITY_SMOOTHING;
			pan.lastX = event.clientX;
			pan.lastY = event.clientY;
			pan.lastTime = event.timeStamp;
		}
		event.preventDefault();
	};

	const endPointer = (event: PointerEvent, cancelled: boolean) => {
		touches.delete(event.pointerId);
		if (longPress?.pointerId === event.pointerId) cancelLongPress();
		if (pinch && pinch.ids.includes(event.pointerId)) {
			// Over when either finger lifts. The one still down does not
			// start dragging: it was half of a pinch, not a drag.
			pinch = null;
			zoom.settle();
			return;
		}
		if (pan && event.pointerId === pan.pointerId) {
			const tap =
				!cancelled &&
				event.pointerType === 'touch' &&
				event.timeStamp - pan.startTime <= TAP_MS &&
				Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) <= TAP_SLOP;
			if (!cancelled && !tap) startMomentum(scroller, pan.velocityX, pan.velocityY);
			release(pan.pointerId);
			pan = null;
			if (tap) options.onTap?.({ x: event.clientX, y: event.clientY });
		}
	};
	const onPointerUp = (event: PointerEvent) => endPointer(event, false);
	const onPointerCancel = (event: PointerEvent) => endPointer(event, true);

	const onWheel = (event: WheelEvent) => {
		if (!event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		const at = { x: event.clientX, y: event.clientY };
		zoom.zoomTo(zoom.get() * Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY), zoom.anchorAt(at), at);
		if (wheelSettleHandle !== null) window.clearTimeout(wheelSettleHandle);
		wheelSettleHandle = window.setTimeout(() => {
			wheelSettleHandle = null;
			zoom.settle();
		}, WHEEL_SETTLE_MS);
	};

	const onGestureStart = (event: Event) => {
		event.preventDefault();
		const { clientX, clientY } = event as WebKitGestureEvent;
		const at = { x: clientX, y: clientY };
		gesture = pinch ? null : { startScale: zoom.get(), anchor: zoom.anchorAt(at) };
	};
	const onGestureChange = (event: Event) => {
		event.preventDefault();
		if (!gesture || pinch) return;
		const { scale, clientX, clientY } = event as WebKitGestureEvent;
		zoom.zoomTo(gesture.startScale * scale, gesture.anchor, { x: clientX, y: clientY });
	};
	const onGestureEnd = (event: Event) => {
		event.preventDefault();
		if (!gesture) return;
		gesture = null;
		zoom.settle();
	};

	scroller.addEventListener('pointerdown', onPointerDown);
	scroller.addEventListener('pointermove', onPointerMove);
	scroller.addEventListener('pointerup', onPointerUp);
	scroller.addEventListener('pointercancel', onPointerCancel);
	// Not passive: preventDefault is what stops a pinch scrolling the view
	// as well as zooming it, or zooming the whole app.
	scroller.addEventListener('wheel', onWheel, { passive: false });
	scroller.addEventListener('gesturestart', onGestureStart);
	scroller.addEventListener('gesturechange', onGestureChange);
	scroller.addEventListener('gestureend', onGestureEnd);

	return () => {
		stopMomentum();
		cancelLongPress();
		if (wheelSettleHandle !== null) window.clearTimeout(wheelSettleHandle);
		scroller.removeEventListener('pointerdown', onPointerDown);
		scroller.removeEventListener('pointermove', onPointerMove);
		scroller.removeEventListener('pointerup', onPointerUp);
		scroller.removeEventListener('pointercancel', onPointerCancel);
		scroller.removeEventListener('wheel', onWheel);
		scroller.removeEventListener('gesturestart', onGestureStart);
		scroller.removeEventListener('gesturechange', onGestureChange);
		scroller.removeEventListener('gestureend', onGestureEnd);
	};
}
