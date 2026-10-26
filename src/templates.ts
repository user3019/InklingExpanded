import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFPage, PageSizes, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib';
import { INFINITE_BASE_HEIGHT, INFINITE_BASE_WIDTH, INFINITE_CANVAS_KEYWORD, MAX_COORDINATE, type PdfBox } from './pdf/infiniteCanvas';

export type TemplateStyle = 'blank' | 'lined' | 'dot-grid';

export const TEMPLATE_STYLES: readonly TemplateStyle[] = ['blank', 'lined', 'dot-grid'];

export const TEMPLATE_STYLE_LABELS: Record<TemplateStyle, string> = {
	blank: 'Blank',
	lined: 'Lined',
	'dot-grid': 'Dot grid',
};

export const PAGE_SIZE = PageSizes.Letter;

// The paper size for new notes and for pages added to them. A setting
// rather than a constant since Track D — the original plan flagged Letter
// as an unconfirmed guess, and it is wrong for most of the world.
export type PageSizeName = 'letter' | 'a4';

// Pages of a fixed size, or one page that grows as it is written on (see
// pdf/infiniteCanvas.ts).
export type CanvasMode = 'pages' | 'infinite';

export const CANVAS_MODES: readonly CanvasMode[] = ['pages', 'infinite'];

export const CANVAS_MODE_LABELS: Record<CanvasMode, string> = {
	pages: 'Pages',
	infinite: 'Infinite canvas',
};

export function pageSizeFor(name: PageSizeName): [number, number] {
	return name === 'a4' ? PageSizes.A4 : PageSizes.Letter;
}

// A single Keywords entry, e.g. "inkling:template=dot-grid" — read back by
// "Add page" so a new page matches the note's existing style. No sidecar
// file; the PDF's own Info dictionary is the source of truth.
const TEMPLATE_KEYWORD_PREFIX = 'inkling:template=';

const RULE_SPACING = 24; // ~1/3in
const RULE_COLOR = rgb(0.7, 0.78, 0.92);
const RULE_THICKNESS = 0.75;

const DOT_MARGIN = 36; // ~0.5in
const DOT_SPACING = 18; // ~0.25in
const DOT_RADIUS = 0.6;
const DOT_COLOR = rgb(0.55, 0.55, 0.6);

// Ruled edge to edge and top to bottom, rather than inside the 0.75in
// margin this used to leave on all four sides. That margin made sense for
// paper you print and hold; on screen it just fenced the writing into a box
// with a dead border around it, and on a phone — where the page is scaled
// down to a few hundred pixels wide — the unruled band cost a noticeable
// share of the space actually available to write in.
function drawLinedRuling(page: PDFPage): void {
	const { width, height } = page.getSize();
	// Starts one full line-height below the top edge rather than at it: a
	// rule drawn exactly on y = height sits half off the page, and reads as
	// a cropped line instead of the first line to write on.
	for (let y = height - RULE_SPACING; y > 0; y -= RULE_SPACING) {
		page.drawLine({
			start: { x: 0, y },
			end: { x: width, y },
			thickness: RULE_THICKNESS,
			color: RULE_COLOR,
		});
	}
}

function drawDotGrid(page: PDFPage): void {
	const { width, height } = page.getSize();
	for (let y = height - DOT_MARGIN; y > DOT_MARGIN; y -= DOT_SPACING) {
		for (let x = DOT_MARGIN; x < width - DOT_MARGIN; x += DOT_SPACING) {
			page.drawCircle({ x, y, size: DOT_RADIUS, color: DOT_COLOR });
		}
	}
}

export function applyTemplateStyle(page: PDFPage, style: TemplateStyle): void {
	if (style === 'lined') drawLinedRuling(page);
	else if (style === 'dot-grid') drawDotGrid(page);
}

// Pure string parsing (no pdf-lib dependency) so callers that already have
// the Keywords string from somewhere cheaper than a full pdf-lib parse —
// e.g. pdf.js's getMetadata(), used to gate the "Add page"/"New handwritten
// note" affordances without paying for a second document parse on every
// file open — can use it too. Returns null (not 'blank') when the marker is
// absent entirely, which is how callers tell "not an InklingExpanded note" apart
// from "an InklingExpanded note using the blank template".
export function parseTemplateStyleFromKeywords(keywords: string | null | undefined): TemplateStyle | null {
	if (!keywords) return null;
	for (const keyword of keywords.split(/\s+/)) {
		if (!keyword.startsWith(TEMPLATE_KEYWORD_PREFIX)) continue;
		const style = keyword.slice(TEMPLATE_KEYWORD_PREFIX.length);
		if ((TEMPLATE_STYLES as readonly string[]).includes(style)) return style as TemplateStyle;
	}
	return null;
}

export function readTemplateStyle(pdf: PDFDocument): TemplateStyle {
	return parseTemplateStyleFromKeywords(pdf.getKeywords()) ?? 'blank';
}

function writeTemplateStyle(pdf: PDFDocument, style: TemplateStyle, mode: CanvasMode): void {
	const keywords = [`${TEMPLATE_KEYWORD_PREFIX}${style}`];
	if (mode === 'infinite') keywords.push(INFINITE_CANVAS_KEYWORD);
	pdf.setKeywords(keywords);
}

export async function createHandwrittenNoteBytes(
	style: TemplateStyle,
	size: PageSizeName = 'letter',
	mode: CanvasMode = 'pages',
): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	if (mode === 'infinite') {
		const page = pdf.addPage([INFINITE_BASE_WIDTH, INFINITE_BASE_HEIGHT]);
		fillInfiniteBackground(pdf, page, style);
	} else {
		const page = pdf.addPage(pageSizeFor(size));
		applyTemplateStyle(page, style);
	}
	writeTemplateStyle(pdf, style, mode);
	return pdf.save();
}

// ---- Infinite canvas background ----
//
// The ruling of a page that grows is drawn once, as a PDF tiling pattern
// filled over the whole area the page is ever allowed to reach, and the
// MediaBox decides how much of it shows. So growing a canvas changes its
// box and nothing else: no new content, no seams where one stretch of
// ruling meets the next, and a file the same size at 2 feet as at 11
// inches. Drawing the dots one by one, the way a fixed page does, would
// have cost a few hundred bytes per dot — megabytes for a large canvas.
//
// Pattern space is the page's default user space, whatever the box, so
// the grid is anchored to the same origin however far the box has moved.

const BACKGROUND_PATTERN = 'InklingBackground';
// Lines tile in long strips, so that a renderer which leaves a hairline
// where tiles meet leaves as few of them as possible.
const LINE_TILE_WIDTH = 288;
// The four-Bézier circle approximation's control distance.
const CIRCLE_KAPPA = 0.5522847498;

function num(value: number): string {
	return Number(value.toFixed(4)).toString();
}

function colorOperands(color: ReturnType<typeof rgb>): string {
	return `${num(color.red)} ${num(color.green)} ${num(color.blue)}`;
}

function dotTile(): string {
	const c = DOT_SPACING / 2;
	const r = DOT_RADIUS;
	const k = r * CIRCLE_KAPPA;
	return [
		`${colorOperands(DOT_COLOR)} rg`,
		`${num(c + r)} ${num(c)} m`,
		`${num(c + r)} ${num(c + k)} ${num(c + k)} ${num(c + r)} ${num(c)} ${num(c + r)} c`,
		`${num(c - k)} ${num(c + r)} ${num(c - r)} ${num(c + k)} ${num(c - r)} ${num(c)} c`,
		`${num(c - r)} ${num(c - k)} ${num(c - k)} ${num(c - r)} ${num(c)} ${num(c - r)} c`,
		`${num(c + k)} ${num(c - r)} ${num(c + r)} ${num(c - k)} ${num(c + r)} ${num(c)} c`,
		'f',
	].join('\n');
}

function lineTile(): string {
	const y = RULE_SPACING / 2;
	return [`${colorOperands(RULE_COLOR)} RG`, `${num(RULE_THICKNESS)} w`, `0 ${num(y)} m ${LINE_TILE_WIDTH} ${num(y)} l S`].join('\n');
}

function fillInfiniteBackground(pdf: PDFDocument, page: PDFPage, style: TemplateStyle): void {
	if (style === 'blank') return;
	const [width, height, content] =
		style === 'lined' ? [LINE_TILE_WIDTH, RULE_SPACING, lineTile()] : [DOT_SPACING, DOT_SPACING, dotTile()];

	const context = pdf.context;
	const pattern = context.flateStream(content, {
		Type: 'Pattern',
		PatternType: 1,
		// Coloured: the tile carries its own colour.
		PaintType: 1,
		// Constant spacing, so a grid never drifts by a pixel between tiles.
		TilingType: 1,
		BBox: [0, 0, width, height],
		XStep: width,
		YStep: height,
		Resources: {},
	});
	const { Resources } = page.node.normalizedEntries();
	Resources.set(PDFName.of('Pattern'), context.obj({ [BACKGROUND_PATTERN]: context.register(pattern) }));

	const extent = MAX_COORDINATE;
	page.pushOperators(
		pushGraphicsState(),
		PDFOperator.of(PDFOperatorNames.NonStrokingColorspace, [PDFName.of('Pattern')]),
		PDFOperator.of(PDFOperatorNames.NonStrokingColorN, [PDFName.of(BACKGROUND_PATTERN)]),
		PDFOperator.of(
			PDFOperatorNames.AppendRectangle,
			[-extent, -extent, extent * 2, extent * 2].map((value) => PDFNumber.of(value)),
		),
		PDFOperator.of(PDFOperatorNames.FillNonZero),
		popGraphicsState(),
	);
}

// Gives an infinite canvas's page a new box. The CropBox follows if the
// file has one, since a reader shows the smaller of the two.
export function setInfiniteCanvasBox(page: PDFPage, box: PdfBox): void {
	const width = box.right - box.left;
	const height = box.top - box.bottom;
	page.setMediaBox(box.left, box.bottom, width, height);
	if (page.node.get(PDFName.of('CropBox'))) page.setCropBox(box.left, box.bottom, width, height);
}

// ---- A background drawn on its own ----
//
// For changing a page's background after the fact (pdf/pageBackground.ts):
// the ruling as content of its own, separate from whatever else the page
// shows, so that it can be found and replaced again. The same lines and
// dots as above, at the same spacing; an infinite canvas gets its tiling
// pattern.

// The colours the ruling is drawn in, which is how a background drawn
// before backgrounds were marked is recognised.
export const TEMPLATE_COLORS: ReadonlyArray<readonly [number, number, number]> = [
	[RULE_COLOR.red, RULE_COLOR.green, RULE_COLOR.blue],
	[DOT_COLOR.red, DOT_COLOR.green, DOT_COLOR.blue],
];

export const BACKGROUND_PATTERN_NAME = BACKGROUND_PATTERN;

function circlePath(cx: number, cy: number, r: number): string {
	const k = r * CIRCLE_KAPPA;
	return [
		`${num(cx + r)} ${num(cy)} m`,
		`${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c`,
		`${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c`,
		`${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c`,
		`${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c`,
	].join('\n');
}

// The operators that draw `style` on `page`, or an empty string for a blank
// one. An infinite canvas's pattern is registered in the page's resources.
export function backgroundOperators(pdf: PDFDocument, page: PDFPage, style: TemplateStyle, infinite: boolean): string {
	if (style === 'blank') return '';
	if (infinite) {
		const [width, height, content] =
			style === 'lined' ? [LINE_TILE_WIDTH, RULE_SPACING, lineTile()] : [DOT_SPACING, DOT_SPACING, dotTile()];
		const context = pdf.context;
		const pattern = context.flateStream(content, {
			Type: 'Pattern',
			PatternType: 1,
			PaintType: 1,
			TilingType: 1,
			BBox: [0, 0, width, height],
			XStep: width,
			YStep: height,
			Resources: {},
		});
		const { Resources } = page.node.normalizedEntries();
		const patterns = Resources.lookupMaybe(PDFName.of('Pattern'), PDFDict);
		if (patterns) patterns.set(PDFName.of(BACKGROUND_PATTERN), context.register(pattern));
		else Resources.set(PDFName.of('Pattern'), context.obj({ [BACKGROUND_PATTERN]: context.register(pattern) }));
		const extent = MAX_COORDINATE;
		return `/Pattern cs /${BACKGROUND_PATTERN} scn ${-extent} ${-extent} ${extent * 2} ${extent * 2} re f`;
	}

	// Drawn the way the page is shown: a page turned a quarter (a scan read
	// sideways, often) shows its own x axis down the screen, and lines drawn
	// across the page itself would stand upright. So the ruling is laid out
	// on the page as it appears — `width` by `height`, upright — and turned
	// onto the page by the matrix that undoes the page's rotation.
	const { x: left, y: bottom, width: pageWidth, height: pageHeight } = page.getMediaBox();
	const rotation = ((page.getRotation().angle % 360) + 360) % 360;
	const turned = rotation === 90 || rotation === 270;
	const width = turned ? pageHeight : pageWidth;
	const height = turned ? pageWidth : pageHeight;
	const matrix =
		rotation === 90
			? [0, 1, -1, 0, left + pageWidth, bottom]
			: rotation === 180
				? [-1, 0, 0, -1, left + pageWidth, bottom + pageHeight]
				: rotation === 270
					? [0, -1, 1, 0, left, bottom + pageHeight]
					: [1, 0, 0, 1, left, bottom];
	const place = `${matrix.map(num).join(' ')} cm`;

	if (style === 'lined') {
		const lines = [place, `${colorOperands(RULE_COLOR)} RG`, `${num(RULE_THICKNESS)} w`];
		for (let y = height - RULE_SPACING; y > 0; y -= RULE_SPACING) {
			lines.push(`0 ${num(y)} m ${num(width)} ${num(y)} l S`);
		}
		return lines.join('\n');
	}
	const dots = [place, `${colorOperands(DOT_COLOR)} rg`];
	for (let y = height - DOT_MARGIN; y > DOT_MARGIN; y -= DOT_SPACING) {
		for (let x = DOT_MARGIN; x < width - DOT_MARGIN; x += DOT_SPACING) dots.push(circlePath(x, y, DOT_RADIUS), 'f');
	}
	return dots.join('\n');
}

// Records `style` as the note's, for pages added to it from now on, and
// leaves any other keywords — the infinite canvas's among them — as they were.
export function setTemplateStyleKeyword(pdf: PDFDocument, style: TemplateStyle): void {
	const others = (pdf.getKeywords() ?? '').split(/\s+/).filter((keyword) => keyword !== '' && !keyword.startsWith(TEMPLATE_KEYWORD_PREFIX));
	pdf.setKeywords([`${TEMPLATE_KEYWORD_PREFIX}${style}`, ...others]);
}
