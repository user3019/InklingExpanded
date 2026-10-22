// How large a PDF page is laid out, and how densely its canvas is backed.
//
// The pure half of what pdfView.ts does when it renders a page — separated
// for the same reason textLines.ts is: it can be reasoned about and tested
// without a PDFPageProxy, a viewport or a DOM around it.
//
// The bug this exists to fix, measured in the running app against Obsidian's
// own PDF view, same file and same 1276px pane:
//
//     core `pdf` view   1224 x 1509 backing, 1224 x 1509 displayed
//     annotate view      810 x  999 backing,  810 x  999 displayed
//
// Both are pixel-for-pixel at their own size, so neither is being resampled.
// The annotate view was simply drawing the page two thirds the size — and so
// at two thirds the resolution — because it laid every page out at a flat
// 1.5x its size in PDF points and never looked at how much room it actually
// had. pdf.js's own viewer fits the page to the pane. That difference is the
// whole of "the quality of the PDF went down when I entered annotation
// mode": nothing had blurred, there was just a third less page there.

// The layout scale used before a page can be measured — the first-page
// estimate that reserves placeholder space at open time, and the fallback if
// the container reports no width at all. The old fixed render scale, kept
// only for those two cases.
export const RENDER_SCALE = 1.5;

// The hard ceiling on any render, zoom included. A page canvas costs four
// bytes a pixel and the view keeps several pages alive at once (see
// PAGE_RETAIN_MARGIN), so this is a memory limit rather than a quality one.
export const MAX_RENDER_SCALE = 6;

// A floor, so that a pane reporting some implausibly small width cannot
// produce a page rendered down to nothing. Deliberately far below
// RENDER_SCALE: rendering *below* the old fixed scale is correct whenever
// the page is displayed smaller than that, and forcing 1.5 there would back
// the canvas larger than the box it is shown in, which is not extra detail —
// it is a downscale, and a resampled page reads softer than one rendered at
// the size it is actually drawn at.
const MIN_RENDER_SCALE = 0.25;

function clamp(value: number, low: number, high: number): number {
	return Math.min(Math.max(value, low), high);
}

// The scale a page is laid out at: fitted to the width available to it, the
// way pdf.js's viewer fits its own. `pagePointWidth` is the page's width in
// PDF points, `availableWidth` the CSS pixels it has to fill.
export function layoutRenderScale(availableWidth: number, pagePointWidth: number): number {
	if (!(availableWidth > 0) || !(pagePointWidth > 0)) return RENDER_SCALE;
	return clamp(availableWidth / pagePointWidth, MIN_RENDER_SCALE, MAX_RENDER_SCALE);
}

// The scale that backs a page with one canvas pixel per physical device
// pixel — no more, which is wasted memory, and no less, which is a blur.
//
// `cssWidth` is the width the page is actually laid out at (see
// layoutRenderScale), so this is the layout scale times the display's
// density, and on an ordinary 1x screen the two are the same number.
// Applying density here is what src/markdown/inkBlock.ts has always done for
// ink blocks and what pdf.js's viewer does for its own canvases; only this
// view never did, which cost it a further factor of devicePixelRatio on a
// scaled desktop or a tablet.
export function baseRenderScale(cssWidth: number, pagePointWidth: number, density: number): number {
	if (!(cssWidth > 0) || !(pagePointWidth > 0) || !(density > 0)) return RENDER_SCALE;
	return clamp((cssWidth * density) / pagePointWidth, MIN_RENDER_SCALE, MAX_RENDER_SCALE);
}

// The most pixels one canvas may hold: 4096 x 4096, which is the limit
// Safari puts on a canvas on iPhone and iPad. Past it the canvas does not
// fail loudly — it simply stays blank — so a page has to be backed less
// densely instead. Only the largest pages ever meet it: a Letter page at the
// full MAX_RENDER_SCALE is just over it, an infinite canvas (see
// infiniteCanvas.ts) a few pages across is well over.
export const MAX_CANVAS_PIXELS = 4096 * 4096;

// `scale`, lowered as far as it has to be for a page of this size in points
// to fit MAX_CANVAS_PIXELS.
export function capToPixelBudget(scale: number, pagePointWidth: number, pagePointHeight: number): number {
	if (!(pagePointWidth > 0) || !(pagePointHeight > 0)) return scale;
	return Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / (pagePointWidth * pagePointHeight)));
}

// The scale a page should be re-rendered at once a pinch-zoom settles.
// `base` is what the page was backed at unzoomed, so the target keeps the
// same one-canvas-pixel-per-device-pixel relationship at the new zoom.
export function zoomedRenderScale(base: number, zoomScale: number): number {
	return Math.min(base * zoomScale, MAX_RENDER_SCALE);
}
