import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFObject, PDFPage, PDFRawStream, PDFRef } from 'pdf-lib';
import { riskyFeatures } from './compatibility';
import { isInfiniteCanvasKeywords } from './infiniteCanvas';
import {
	BACKGROUND_PATTERN_NAME,
	backgroundOperators,
	parseTemplateStyleFromKeywords,
	setTemplateStyleKeyword,
	TEMPLATE_COLORS,
	type TemplateStyle,
} from '../templates';

// Changing a page's background — blank, lined, dot grid — after the page
// was made.
//
// The ink is not in the page's content (it is annotations, see
// annotationSync.ts), so what a note page draws is its background and
// nothing else. A background put down here is content of its own, marked
// `/InklingBackground BMC … EMC` and placed under everything else, so the
// next change finds it and replaces it. One drawn before backgrounds were
// marked — every note page made so far — is recognised by what it is: a
// content stream of nothing but paths in the ruling's colours. Anything
// else on a page — the text and pictures of an imported PDF page — is
// left exactly as it was, and the new background goes underneath it.

export type BackgroundChange = { kind: 'changed'; bytes: Uint8Array; pages: number } | { kind: 'refused'; reason: string };

const MARK = 'InklingBackground';

export async function setPageBackground(
	bytes: ArrayBuffer | Uint8Array,
	target: number | 'all',
	style: TemplateStyle,
): Promise<BackgroundChange> {
	const doc = await PDFDocument.load(bytes);
	const count = doc.getPageCount();
	if (target !== 'all' && (!Number.isInteger(target) || target < 1 || target > count)) {
		return { kind: 'refused', reason: 'that page is not in this PDF' };
	}
	const risky = riskyFeatures(doc);
	if (risky.length > 0) return { kind: 'refused', reason: `the PDF contains ${risky.join(' and ')}, which rewriting it would break` };

	const infinite = isInfiniteCanvasKeywords(doc.getKeywords());
	const pages = target === 'all' ? doc.getPages() : [doc.getPage(target - 1)];
	for (const page of pages) replaceBackground(doc, page, style, infinite);
	// The note's own style, for the pages added to it next — when it is the
	// whole note that changed, or a note of one page. Only a note's: a book
	// given lined pages is still a book, not a note of this plugin's, and
	// marking it one would change what Add page puts in it.
	const isNote = parseTemplateStyleFromKeywords(doc.getKeywords()) !== null;
	if (isNote && (target === 'all' || count === 1)) setTemplateStyleKeyword(doc, style);
	return { kind: 'changed', bytes: await doc.save(), pages: pages.length };
}

function replaceBackground(doc: PDFDocument, page: PDFPage, style: TemplateStyle, infinite: boolean): void {
	const raw = page.node.get(PDFName.of('Contents'));
	const entries: PDFObject[] = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
	const read = entries.map((entry) => ({ entry, text: contentText(doc, entry) }));

	let kept = read.filter((stream) => stream.text === null || !isMarkedBackground(stream.text));
	// An old, unmarked background: the page's streams all ruling or empty
	// wrappers, and ruling among them. Anything else on the page keeps every
	// stream it has, and the new background goes under them.
	const kinds = kept.map((stream) => (stream.text === null ? 'other' : classifyStream(stream.text)));
	if (kinds.includes('ruling') && kinds.every((kind) => kind !== 'other')) kept = [];

	const removed = read.filter((stream) => !kept.includes(stream));
	const operators = backgroundOperators(doc, page, style, infinite);
	const contents = kept.map((stream) => stream.entry);
	if (operators !== '') {
		const background = doc.context.flateStream(`/${MARK} BMC\nq\n${operators}\nQ\nEMC\n`);
		contents.unshift(doc.context.register(background));
	}
	page.node.set(PDFName.of('Contents'), doc.context.obj(contents));

	// The old background's objects go too, unless another page draws them.
	const elsewhere = new Set<string>();
	for (const other of doc.getPages()) {
		if (other === page) continue;
		const theirs = other.node.get(PDFName.of('Contents'));
		for (const entry of theirs instanceof PDFArray ? theirs.asArray() : theirs ? [theirs] : []) {
			if (entry instanceof PDFRef) elsewhere.add(entry.toString());
		}
	}
	for (const { entry } of removed) {
		if (entry instanceof PDFRef && !elsewhere.has(entry.toString())) doc.context.delete(entry);
	}
}

// A content stream as text, or null when it cannot be read — which keeps
// it, since what cannot be read cannot be known to be a background.
function contentText(doc: PDFDocument, entry: PDFObject): string | null {
	const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
	if (!(stream instanceof PDFRawStream)) return null;
	try {
		const decoded = decodePDFRawStream(stream).decode();
		let text = '';
		for (let i = 0; i < decoded.length; i += 0x8000) text += String.fromCharCode(...decoded.subarray(i, i + 0x8000));
		return text;
	} catch {
		return null;
	}
}

function isMarkedBackground(text: string): boolean {
	return text.trimStart().startsWith(`/${MARK} BMC`);
}

// Drawing operators a ruling is made of. Text, pictures, shadings, inline
// images and anything else mean the stream is something more.
const PATH_OPERATORS = new Set([
	'q', 'Q', 'cm', 'w', 'J', 'j', 'M', 'd', 'm', 'l', 'c', 'v', 'y', 'h', 're',
	'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n', 'W', 'W*',
	'rg', 'RG', 'cs', 'CS', 'scn', 'SCN',
]);
const STROKES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const FILLS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const TOKEN = /\/[^\s/[\]()<>{}%]*|\[|\]|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z*'"]+|\S/g;

// What a content stream draws, for telling an old background from the rest:
// `ruling` paints only in the ruling's colours or with the infinite canvas's
// pattern, `nothing` paints nothing at all (pdf-lib wraps what it draws in
// streams of a lone q and Q), `other` is anything else — text, a picture,
// or a path in any other colour. Black counts as another colour, and is
// what a path is painted in when no colour was set: a diagram on an
// imported page is paths too, often with no colour of its own, and was
// taken for a background and deleted.
//
// The colours are followed as a PDF reader follows them — through q and Q,
// for strokes and fills apart — so a ruled line beside a black one is not
// mistaken for ruling either.
export type StreamKind = 'ruling' | 'nothing' | 'other';

export function classifyStream(text: string): StreamKind {
	interface Paint {
		stroke: boolean;
		fill: boolean;
	}
	// Whether the current stroke and fill colours are the ruling's own.
	let paint: Paint = { stroke: false, fill: false };
	const saved: Paint[] = [];
	const operands: string[] = [];
	let painted = false;
	for (const token of text.match(TOKEN) ?? []) {
		if (token.startsWith('/') || token === '[' || token === ']' || /^[-+.\d]/.test(token)) {
			operands.push(token);
			continue;
		}
		if (!PATH_OPERATORS.has(token)) return 'other';
		const last = operands[operands.length - 1];
		switch (token) {
			case 'q':
				saved.push({ ...paint });
				break;
			case 'Q':
				paint = saved.pop() ?? { stroke: false, fill: false };
				break;
			case 'rg':
			case 'RG': {
				const [r, g, b] = operands.slice(-3).map(Number);
				const ruled = TEMPLATE_COLORS.some(([tr, tg, tb]) => near(r, tr) && near(g, tg) && near(b, tb));
				if (token === 'rg') paint.fill = ruled;
				else paint.stroke = ruled;
				break;
			}
			// A colour space is chosen before its colour: only the pattern's
			// is ever the ruling's, and its colour comes with scn.
			case 'cs':
				paint.fill = false;
				if (last !== '/Pattern') return 'other';
				break;
			case 'CS':
				paint.stroke = false;
				if (last !== '/Pattern') return 'other';
				break;
			case 'scn':
				paint.fill = last === `/${BACKGROUND_PATTERN_NAME}`;
				if (!paint.fill) return 'other';
				break;
			case 'SCN':
				paint.stroke = last === `/${BACKGROUND_PATTERN_NAME}`;
				if (!paint.stroke) return 'other';
				break;
			default:
				if ((STROKES.has(token) && !paint.stroke) || (FILLS.has(token) && !paint.fill)) return 'other';
				if (STROKES.has(token) || FILLS.has(token)) painted = true;
		}
		operands.length = 0;
	}
	return painted ? 'ruling' : 'nothing';
}

// Whether a content stream is a background drawn before backgrounds were
// marked: paths painted only in the ruling's colours or with the infinite
// canvas's pattern, and something painted at all.
export function isTemplateDrawing(text: string): boolean {
	return classifyStream(text) === 'ruling';
}

function near(value: number | undefined, target: number): boolean {
	return value !== undefined && Math.abs(value - target) < 0.005;
}
