import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRawStream, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import { boundingBox } from '../annotate/geometry';
import { hasPressure, isOutlined, isSharp, SHARP_MITRE_LIMIT, strokeCentreline, strokeOutline } from '../annotate/stroke';
import { BRUSH_KEY, ID_PREFIX, INKLING_EXTRAS, PRESSURE_KEY, QUOTE_KEY } from './annotationFormat';
import type { TouchFn } from './changeSet';
import { arrowHeadOps, ellipseOps, moveLineOps, noteMarkerOps, pathOps, rectangleOps } from './contentStream';
import {
	Annotation,
	DEFAULT_COLOR,
	DEFAULT_WIDTH,
	HIGHLIGHTER_OPACITY,
	ImageAnnotation,
	isPenBrush,
	NOTE_MARKER_SIZE,
	NoteAnnotation,
	PicturePixels,
	Point,
	ShapeAnnotation,
	StrokeAnnotation,
} from '../annotate/types';

// Mirrors pdf-lib's own (unexported) PDFContext.obj()/stream() literal
// type, so a plain object literal built up across a few local variables
// still resolves to the right overload instead of widening to
// Record<string, unknown> and losing the shape TypeScript needs to pick
// between the object/array overloads.
type PdfLiteral = string | number | boolean | null | undefined | PDFObject | PdfLiteralObject | PdfLiteralArray;
interface PdfLiteralObject {
	[key: string]: PdfLiteral;
}
type PdfLiteralArray = PdfLiteral[];

// Whether an annotation dict is one of ours, by the `/NM` tag every write
// applies. Exported because verification needs the same answer (see
// src/pdf/fingerprint.ts): a fingerprint has to exclude exactly the
// annotations a save is allowed to change, and "exactly" means one
// definition, not two that can drift apart.
export function isInklingAnnotationDict(dict: PDFDict): boolean {
	try {
		return dict.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText()?.startsWith(ID_PREFIX) ?? false;
	} catch {
		// Malformed annotation dict — not ours, and not something to crash on.
		return false;
	}
}

function hexToRgb(color: string): [number, number, number] {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
	const [, r, g, b] = match ?? [];
	if (!r || !g || !b) return [0, 0, 0];
	return [parseInt(r, 16) / 255, parseInt(g, 16) / 255, parseInt(b, 16) / 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	const toHex = (v: number) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function numbersFromArray(array: PDFArray): number[] {
	return array
		.asArray()
		.filter((o): o is PDFNumber => o instanceof PDFNumber)
		.map((o) => o.asNumber());
}

// The /CA above which an ink annotation is taken to be a pen rather than a
// highlighter, on read.
//
// Derived from HIGHLIGHTER_OPACITY rather than written as a number, because
// the two are the same decision seen from opposite ends and a literal here
// is a trap: raise the highlighter's opacity past a hard-coded 0.9 one day
// and every highlight in every vault silently reads back as a pen stroke.
// The midpoint between what a highlighter writes and the 1 a pen writes
// keeps admitting older files (which carry 0.4) while leaving the widest
// margin on both sides.
const HIGHLIGHTER_OPACITY_MAX = (HIGHLIGHTER_OPACITY + 1) / 2;

// ---- Writing ----

// `1 J` is a round cap, `0 J` a flat one. Flat for a highlighter, matching
// the canvas (see the lineCap note in src/annotate/render.ts): a snapped
// highlight is one straight segment at the height of the text it covers, so
// a round cap adds a bulge of half that height past the first and last
// glyph. Round for everything else, where it is what stops a polyline
// looking chipped at its ends.
// `sharp` is the sharp pen's square ends and mitred corners (see
// annotate/stroke.ts); otherwise round joins, with round or flat ends.
function strokeHeader(color: string, width: number, flatCap = false, sharp = false): string[] {
	const [r, g, b] = hexToRgb(color);
	const ends = sharp ? `0 J 0 j ${SHARP_MITRE_LIMIT} M` : `${flatCap ? 0 : 1} J 1 j`;
	return [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`, `${width.toFixed(2)} w`, ends];
}

// The annotation dict's own `/CA` entry (below) is the spec-correct way to
// mark an annotation's overall opacity, but plenty of real-world viewers
// render an annotation's `/AP` appearance stream directly without applying
// it — which made the highlighter paint fully opaque (and cover the text
// it was supposed to sit over) in anything other than Obsidian's own
// overlay. Baking the alpha into the appearance stream itself via an
// `ExtGState` + `gs` operator means the translucency is part of what gets
// drawn, so it's correct regardless of whether the viewer also honors `/CA`.
//
// `blend` is the other half of that reasoning, and it is what makes a
// highlighter a highlighter rather than a translucent smear. Alpha alone
// paints colour *between* the reader and the words, so text under a
// highlight loses its contrast; `/BM /Multiply` makes the mark darken the
// paper instead, leaving black text black because black times anything is
// black. Its on-screen twin is the highlight layer's mix-blend-mode in
// styles.css, and the two have to agree or the saved file stops looking
// like the editor did.
//
// The alpha is kept alongside it rather than dropped: a reader that honours
// `/BM` gets the intended result, and one that ignores it still gets a
// translucent mark it can read the text through instead of an opaque bar
// covering it.
function buildAppearanceStream(
	pdfDoc: PDFDocument,
	bbox: number[],
	content: string,
	opacity = 1,
	blend?: 'Multiply',
): PDFRef {
	let resources: PdfLiteralObject = {};
	let body = content;
	if (opacity < 1 || blend) {
		const state: PdfLiteralObject = { Type: 'ExtGState', ca: opacity, CA: opacity };
		if (blend) state.BM = blend;
		const gsRef = pdfDoc.context.register(pdfDoc.context.obj(state));
		resources = { ExtGState: { GS0: gsRef } };
		body = `/GS0 gs\n${content}`;
	}
	// Deflated. An appearance is a run of path coordinates — a page of
	// handwriting is hundreds of them — and coordinates compress to a
	// fraction of their text.
	const stream = pdfDoc.context.flateStream(body, {
		Type: 'XObject',
		Subtype: 'Form',
		FormType: 1,
		BBox: bbox,
		Resources: resources,
	});
	return pdfDoc.context.register(stream);
}

function tagAndAdd(pdfDoc: PDFDocument, page: PDFPage, id: string, fields: PdfLiteralObject): void {
	const dict = pdfDoc.context.obj(fields);
	dict.set(PDFName.of('NM'), PDFString.of(id));
	page.node.addAnnot(pdfDoc.context.register(dict));
}

function fillHeader(color: string): string[] {
	const [r, g, b] = hexToRgb(color);
	return [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`];
}

// Copies the fields every annotation kind shares into a dict being built.
// The private extras dict is created lazily, so an annotation with neither
// a quote nor pressure carries no extra bytes at all.
function withSharedFields(fields: PdfLiteralObject, annotation: Annotation): PdfLiteralObject {
	const note = annotation.note?.trim();
	if (note) fields.Contents = PDFString.of(note);

	const quote = annotation.quote?.trim();
	if (quote) {
		const extras = (fields[INKLING_EXTRAS] ?? {}) as PdfLiteralObject;
		extras[QUOTE_KEY] = PDFString.of(quote);
		fields[INKLING_EXTRAS] = extras;
	}
	return fields;
}

// The other half of withSharedFields: reads both back onto an annotation.
// Empty strings are dropped rather than kept, because "" and absent are
// the same thing here and only one of them should reach the rest of the
// code.
function readSharedFields(dict: PDFDict, annotation: Annotation): Annotation {
	const note = dict.lookupMaybe(PDFName.of('Contents'), PDFString)?.decodeText().trim();
	if (note) annotation.note = note;

	const quote = dict
		.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict)
		?.lookupMaybe(PDFName.of(QUOTE_KEY), PDFString)
		?.decodeText()
		.trim();
	if (quote) annotation.quote = quote;

	return annotation;
}

function writeStroke(pdfDoc: PDFDocument, page: PDFPage, stroke: StrokeAnnotation): void {
	const [r, g, b] = hexToRgb(stroke.color);
	const box = boundingBox(stroke);
	const pad = stroke.width / 2;
	const bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];

	const isHighlight = stroke.tool === 'highlighter';
	const opacity = isHighlight ? HIGHLIGHTER_OPACITY : 1;
	// A highlighter never varies its width (see annotate/stroke.ts), so it
	// never carries pressure — recording any for one would be dead weight in
	// every file that has one.
	const varying = stroke.tool === 'pen' && hasPressure(stroke.points);
	const brush = stroke.tool === 'pen' && stroke.brush && stroke.brush !== 'pen' ? stroke.brush : null;
	// Filled outline for a pressure stroke or a nib, stroked path for
	// everything else: no PDF stroking operator can vary a line's width along
	// its length. Either way the geometry comes from the same shared module
	// the canvas draws from, so the file matches what the user watched
	// themselves draw.
	const content = isOutlined(stroke)
		? [...fillHeader(stroke.color), pathOps(strokeOutline(stroke)), 'f'].join('\n')
		: [...strokeHeader(stroke.color, stroke.width, isHighlight, isSharp(stroke)), pathOps(strokeCentreline(stroke)), 'S'].join('\n');
	const apRef = buildAppearanceStream(pdfDoc, bbox, content, opacity, isHighlight ? 'Multiply' : undefined);

	const fields: PdfLiteralObject = {
		Type: 'Annot',
		Subtype: 'Ink',
		Rect: bbox,
		// The raw path, whatever the appearance stream above does with it —
		// for a filled outline this is the only place another PDF reader can
		// find the line the pen actually took.
		InkList: [stroke.points.flatMap((p) => [p.x, p.y])],
		C: [r, g, b],
		CA: opacity,
		BS: { W: stroke.width },
		F: 4,
		AP: { N: apRef },
	};
	if (varying || brush) {
		const extras: PdfLiteralObject = {};
		if (varying) extras[PRESSURE_KEY] = stroke.points.map((p) => Math.round(Math.min(Math.max(p.p ?? 1, 0), 1) * 255));
		if (brush) extras[BRUSH_KEY] = brush;
		fields[INKLING_EXTRAS] = extras;
	}

	tagAndAdd(pdfDoc, page, stroke.id, withSharedFields(fields, stroke));
}

// ---- Pictures ----
//
// A picture is a Stamp annotation — the kind the specification has for an
// image put onto a page — whose appearance draws the picture's own image
// object over its box. Every reader shows it, and reading it back out takes
// the pixels from that same image object, so they are in the file once.

const PICTURE_NAME = 'Im0';
const LOCKED_FLAG = 128;

// The image object for a picture: its JPEG as it is (a PDF reader decodes
// JPEG itself), or its RGB deflated with the alpha alongside as a soft mask.
function pictureObject(pdfDoc: PDFDocument, picture: PicturePixels): PDFRef {
	const { context } = pdfDoc;
	const base = { Type: 'XObject', Subtype: 'Image', Width: picture.width, Height: picture.height, BitsPerComponent: 8 };
	if (picture.format === 'jpeg') {
		return context.register(context.stream(picture.data, { ...base, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }));
	}
	const pixels = picture.width * picture.height;
	const rgb = new Uint8Array(pixels * 3);
	const alpha = new Uint8Array(pixels);
	for (let index = 0; index < pixels; index++) {
		rgb[index * 3] = picture.data[index * 4] ?? 0;
		rgb[index * 3 + 1] = picture.data[index * 4 + 1] ?? 0;
		rgb[index * 3 + 2] = picture.data[index * 4 + 2] ?? 0;
		alpha[index] = picture.data[index * 4 + 3] ?? 255;
	}
	const mask = context.register(context.flateStream(alpha, { ...base, ColorSpace: 'DeviceGray' }));
	return context.register(context.flateStream(rgb, { ...base, ColorSpace: 'DeviceRGB', SMask: mask }));
}

// The image object an annotation's appearance draws, if it is one of ours.
function pictureRefOf(pdfDoc: PDFDocument, ref: PDFRef): PDFRef | null {
	const dict = pdfDoc.context.lookupMaybe(ref, PDFDict);
	const appearance = dict?.lookupMaybe(PDFName.of('AP'), PDFDict)?.lookupMaybe(PDFName.of('N'), PDFStream);
	const image = appearance?.dict
		.lookupMaybe(PDFName.of('Resources'), PDFDict)
		?.lookupMaybe(PDFName.of('XObject'), PDFDict)
		?.get(PDFName.of(PICTURE_NAME));
	return image instanceof PDFRef ? image : null;
}

// `reuse` is the image object of this same picture already in the file —
// a picture moved or scaled is the same pixels in a new box, and writing
// them again would grow the file by the whole picture with every drag.
function writeImage(pdfDoc: PDFDocument, page: PDFPage, image: ImageAnnotation, reuse: PDFRef | null): void {
	const box = boundingBox(image);
	const width = box.maxX - box.minX;
	const height = box.maxY - box.minY;
	const bbox = [box.minX, box.minY, box.maxX, box.maxY];
	const picture = reuse ?? pictureObject(pdfDoc, image.picture);
	const content = `q ${width.toFixed(3)} 0 0 ${height.toFixed(3)} ${box.minX.toFixed(3)} ${box.minY.toFixed(3)} cm /${PICTURE_NAME} Do Q`;
	const appearance = pdfDoc.context.register(
		pdfDoc.context.flateStream(content, {
			Type: 'XObject',
			Subtype: 'Form',
			FormType: 1,
			BBox: bbox,
			Resources: { XObject: { [PICTURE_NAME]: picture } },
		}),
	);
	// Flags: Print (4), and Locked (128) for a locked picture — the
	// specification's own "may not be moved or resized", which other readers
	// honour too.
	const flags = image.locked ? 4 | LOCKED_FLAG : 4;
	const fields: PdfLiteralObject = { Type: 'Annot', Subtype: 'Stamp', Rect: bbox, F: flags, AP: { N: appearance } };
	tagAndAdd(pdfDoc, page, image.id, withSharedFields(fields, image));
}

function readPicture(dict: PDFDict): PicturePixels | null {
	const image = dict
		.lookupMaybe(PDFName.of('AP'), PDFDict)
		?.lookupMaybe(PDFName.of('N'), PDFStream)
		?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
		?.lookupMaybe(PDFName.of('XObject'), PDFDict)
		?.lookupMaybe(PDFName.of(PICTURE_NAME), PDFStream);
	if (!(image instanceof PDFRawStream)) return null;
	const width = image.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
	const height = image.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;
	if (!(width > 0) || !(height > 0)) return null;
	if (image.dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.decodeText() === 'DCTDecode') {
		return { format: 'jpeg', width, height, data: image.getContents() };
	}
	const rgb = decodePDFRawStream(image).decode();
	const mask = image.dict.lookupMaybe(PDFName.of('SMask'), PDFStream);
	const alpha = mask instanceof PDFRawStream ? decodePDFRawStream(mask).decode() : null;
	const pixels = width * height;
	if (rgb.length < pixels * 3) return null;
	const data = new Uint8Array(pixels * 4);
	for (let index = 0; index < pixels; index++) {
		data[index * 4] = rgb[index * 3] ?? 0;
		data[index * 4 + 1] = rgb[index * 3 + 1] ?? 0;
		data[index * 4 + 2] = rgb[index * 3 + 2] ?? 0;
		data[index * 4 + 3] = alpha?.[index] ?? 255;
	}
	return { format: 'rgba', width, height, data };
}

// Whether two pictures are the same pixels. Their sizes, and every 97th
// byte: enough to tell two different pictures apart without walking a
// photo's worth of bytes on every save.
function samePicture(a: PicturePixels, b: PicturePixels): boolean {
	if (a.format !== b.format || a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
	for (let index = 0; index < a.data.length; index += 97) if (a.data[index] !== b.data[index]) return false;
	return true;
}

function writeShape(pdfDoc: PDFDocument, page: PDFPage, shape: ShapeAnnotation): void {
	const [r, g, b] = hexToRgb(shape.color);
	const box = boundingBox(shape);
	const header = strokeHeader(shape.color, shape.width);

	let subtype: string;
	let extra: PdfLiteralObject = {};
	let bbox: number[];
	let content: string;

	if (shape.tool === 'line' || shape.tool === 'arrow') {
		subtype = 'Line';
		extra = { L: [shape.start.x, shape.start.y, shape.end.x, shape.end.y] };
		const pad = shape.width / 2 + (shape.tool === 'arrow' ? 14 : 0);
		bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];
		const lines = [...header, moveLineOps([shape.start, shape.end]), 'S'];
		if (shape.tool === 'arrow') {
			extra.LE = ['None', 'OpenArrow'];
			lines.push(arrowHeadOps(shape.start, shape.end, Math.max(12, shape.width * 3)), 'S');
		}
		content = lines.join('\n');
	} else {
		// Square/Circle: `/Rect` *is* the shape's geometry (per spec, inclusive
		// of border width) — pad by exactly half the stroke width so reading
		// it back can invert the same padding and recover the exact bounds,
		// rather than drifting outward a little on every save/reopen cycle.
		const pad = shape.width / 2;
		bbox = [box.minX - pad, box.minY - pad, box.maxX + pad, box.maxY + pad];
		subtype = shape.tool === 'rectangle' ? 'Square' : 'Circle';
		content =
			shape.tool === 'rectangle'
				? [...header, rectangleOps(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY), 'S'].join('\n')
				: [
						...header,
						ellipseOps((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.maxX - box.minX) / 2, (box.maxY - box.minY) / 2),
						'S',
					].join('\n');
	}

	const apRef = buildAppearanceStream(pdfDoc, bbox, content);

	tagAndAdd(
		pdfDoc,
		page,
		shape.id,
		withSharedFields(
			{
				Type: 'Annot',
				Subtype: subtype,
				Rect: bbox,
				C: [r, g, b],
				BS: { W: shape.width },
				F: 4,
				AP: { N: apRef },
				...extra,
			},
			shape,
		),
	);
}

// A note annotation: a PDF /Text annotation, which is the standard sticky
// note. Written with an /AP of our own drawing the same marker the canvas
// draws, because a viewer left to its own devices renders /Text as its own
// house icon — a yellow speech bubble in one reader, a pushpin in another —
// and the colour that says which category this note belongs to would be
// lost with it.
function writeNote(pdfDoc: PDFDocument, page: PDFPage, note: NoteAnnotation): void {
	const [r, g, b] = hexToRgb(note.color);
	const half = NOTE_MARKER_SIZE / 2;
	const bbox = [note.at.x - half, note.at.y - half, note.at.x + half, note.at.y + half];

	const content = [`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`, noteMarkerOps(note.at, NOTE_MARKER_SIZE), 'f'].join('\n');
	const apRef = buildAppearanceStream(pdfDoc, bbox, content);

	tagAndAdd(
		pdfDoc,
		page,
		note.id,
		withSharedFields(
			{
				Type: 'Annot',
				Subtype: 'Text',
				Rect: bbox,
				Name: 'Comment',
				C: [r, g, b],
				F: 4,
				AP: { N: apRef },
				// Closed, so a reader that renders /Text popups does not open
				// every note in the document at once on load.
				Open: false,
			},
			note,
		),
	);
}

// Frees one annotation’s own indirect objects from the document context —
// its dict, its /AP appearance stream, and (highlighter strokes only) the
// ExtGState the appearance stream references for opacity. Unlinking a ref
// from a page's /Annots array (page.node.removeAnnot, below) does *not* do
// this by itself: the objects stay registered in the PDFContext and keep
// getting serialized into every future save regardless. Since
// writeInklingAnnotations (below) once rewrote every Inkling annotation on
// a page as brand-new objects on every autosave (it now rewrites only what
// changed, and this frees exactly what that leaves behind), skipping this
// step meant every edit left the *previous* generation of dicts/streams
// behind as permanent dead weight that never got reclaimed — the file only
// ever grew, compounding with every stroke across a session, eventually
// growing large enough to trip a sync tool's file-size limit.
function deleteAnnotationObjects(pdfDoc: PDFDocument, ref: PDFRef, keep: ReadonlySet<PDFRef> = new Set()): void {
	const dict = pdfDoc.context.lookupMaybe(ref, PDFDict);
	const apRef = dict?.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'));
	// A picture's image object, and its mask, go with it — unless the same
	// picture is being written again in a new place and keeps them.
	const picture = pictureRefOf(pdfDoc, ref);
	if (picture && !keep.has(picture)) {
		const mask = pdfDoc.context.lookupMaybe(picture, PDFStream)?.dict.get(PDFName.of('SMask'));
		if (mask instanceof PDFRef) pdfDoc.context.delete(mask);
		pdfDoc.context.delete(picture);
	}
	if (apRef instanceof PDFRef) {
		const apStream = pdfDoc.context.lookupMaybe(apRef, PDFStream);
		const extGState = apStream?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
		if (extGState) {
			for (const value of extGState.values()) {
				if (value instanceof PDFRef) pdfDoc.context.delete(value);
			}
		}
		pdfDoc.context.delete(apRef);
	}
	pdfDoc.context.delete(ref);
}

// This page's Inkling annotation refs, in /Annots order.
function inklingAnnotationRefs(pdfDoc: PDFDocument, page: PDFPage): PDFRef[] {
	const annots = page.node.Annots();
	if (!annots) return [];

	const refs: PDFRef[] = [];
	for (const entry of annots.asArray()) {
		if (!(entry instanceof PDFRef)) continue;
		try {
			const dict = pdfDoc.context.lookupMaybe(entry, PDFDict);
			if (dict && isInklingAnnotationDict(dict)) refs.push(entry);
		} catch {
			// Malformed annotation dict — leave it alone rather than crash.
		}
	}
	return refs;
}

function removeInklingAnnotations(pdfDoc: PDFDocument, page: PDFPage): boolean {
	const toRemove = inklingAnnotationRefs(pdfDoc, page);
	for (const ref of toRemove) {
		page.node.removeAnnot(ref);
		deleteAnnotationObjects(pdfDoc, ref);
	}
	return toRemove.length > 0;
}

// ---- Deciding what a save has to rewrite ----

// How far apart two coordinates can be and still be the same mark, in PDF
// units — a thousandth of a point, 1/72000 of an inch.
//
// Not zero, because an unchanged stroke does not come back as the same
// numbers. The view converts a page's annotations into screen space when it
// seeds them and back into PDF space when it saves, and that pair of float
// transforms can move a coordinate in its last few bits. Exact comparison
// would call every such stroke edited and rewrite the whole page — the thing
// this exists to stop. Nothing a person draws moves by a thousandth of a point.
const COORDINATE_TOLERANCE = 1e-3;

function near(a: number, b: number): boolean {
	return Math.abs(a - b) <= COORDINATE_TOLERANCE;
}

function nearPoint(a: Point, b: Point): boolean {
	return near(a.x, b.x) && near(a.y, b.y);
}

// Pressure as writeStroke stores it — one byte a sample, and only for a pen
// stroke that has any — so a pressure read back as n/255 compares equal to
// the one it was written from.
function storedPressures(stroke: StrokeAnnotation): number[] | null {
	if (stroke.tool !== 'pen' || !hasPressure(stroke.points)) return null;
	return stroke.points.map((p) => Math.round(Math.min(Math.max(p.p ?? 1, 0), 1) * 255));
}

function sameText(a: string | undefined, b: string | undefined): boolean {
	return (a?.trim() || undefined) === (b?.trim() || undefined);
}

// Whether writing `incoming` would put the same annotation in the file that
// `existing` — read back out of it — already describes.
//
// Compared only on what the file stores, and on all of it: every field the
// writers above serialize, and nothing they do not. A difference in something
// the file cannot hold is not an edit the file can lose; a field left out of
// this comparison is an edit that would be kept as the old object and
// silently dropped. Any doubt answers "changed" — a needless rewrite costs
// bytes, a wrong "unchanged" costs the user's ink.
function sameAsWritten(existing: Annotation, incoming: Annotation): boolean {
	if (existing.kind !== incoming.kind) return false;
	if (existing.color.toLowerCase() !== incoming.color.toLowerCase()) return false;
	if (!sameText(existing.note, incoming.note) || !sameText(existing.quote, incoming.quote)) return false;

	if (existing.kind === 'note' && incoming.kind === 'note') {
		// No width: a note's /BS is never written, so there is nothing to
		// compare it against.
		return nearPoint(existing.at, incoming.at);
	}
	if (!near(existing.width, incoming.width)) return false;

	if (existing.kind === 'stroke' && incoming.kind === 'stroke') {
		if (existing.tool !== incoming.tool || existing.points.length !== incoming.points.length) return false;
		if ((existing.brush ?? 'pen') !== (incoming.brush ?? 'pen')) return false;
		if (!existing.points.every((point, index) => nearPoint(point, incoming.points[index] ?? { x: NaN, y: NaN }))) return false;
		return JSON.stringify(storedPressures(existing)) === JSON.stringify(storedPressures(incoming));
	}

	if (existing.kind === 'image' && incoming.kind === 'image') {
		const a = boundingBox(existing);
		const b = boundingBox(incoming);
		return (
			(existing.locked === true) === (incoming.locked === true) &&
			near(a.minX, b.minX) &&
			near(a.minY, b.minY) &&
			near(a.maxX, b.maxX) &&
			near(a.maxY, b.maxY) &&
			samePicture(existing.picture, incoming.picture)
		);
	}

	if (existing.kind === 'shape' && incoming.kind === 'shape') {
		if (existing.tool !== incoming.tool) return false;
		if (incoming.tool === 'line' || incoming.tool === 'arrow') {
			return nearPoint(existing.start, incoming.start) && nearPoint(existing.end, incoming.end);
		}
		// A rectangle or oval is stored as its box, so one dragged out
		// bottom-right to top-left reads back with its corners swapped.
		const a = boundingBox(existing);
		const b = boundingBox(incoming);
		return near(a.minX, b.minX) && near(a.minY, b.minY) && near(a.maxX, b.maxX) && near(a.maxY, b.maxY);
	}
	return false;
}

// Whether two annotations in PDF space are the same mark, as the file
// would hold them — what merging another device's save into an open view
// asks (see pdfView.ts). Within the file's own rounding, so a stroke read
// back from it is not mistaken for one that was edited.
export function sameInFile(a: Annotation | undefined, b: Annotation | undefined): boolean {
	if (!a || !b) return a === b;
	return a.id === b.id && sameAsWritten(a, b);
}

// The annotation this ref's dict describes, or null when it cannot be read
// — which sameAsWritten never matches, so an unreadable one is rewritten.
function readRef(pdfDoc: PDFDocument, ref: PDFRef): Annotation | null {
	try {
		const dict = pdfDoc.context.lookupMaybe(ref, PDFDict);
		const id = dict?.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText();
		if (!dict || !id) return null;
		const annotation = readOne(id, dict);
		return annotation ? readSharedFields(dict, annotation) : null;
	} catch {
		return null;
	}
}

// Reports every indirect object a page mutation writes into, which no hook
// on PDFContext can see because pdf-lib mutates parsed objects in place.
//
// Three slots matter, and all three are mutated by pdf-lib's own
// PDFPageLeaf.normalize(), which runs on the first addAnnot against a
// *parsed* page (PDFObjectParser builds page leaves with autoNormalizeCTM
// on, so this is every page in every real book):
//
//   /Annots     — pushed onto by addAnnot; a separate object when indirect.
//   /Resources  — normalize sets /Font, /XObject and /ExtGState into it, and
//                 in a real book it is usually indirect and sometimes shared
//                 with other pages through inheritance.
//   /Contents   — normalize wraps a single stream in an array and pushes the
//                 shared push/pop-graphics-state streams into it.
//
// Called before and after the mutation, and the union taken, because
// normalize can replace an indirect slot with a direct one: the object that
// used to be there still needs rewriting, and so does the page dict that now
// holds it inline.
function touchPageContainers(page: PDFPage, touch: TouchFn): void {
	touch(page.ref);
	for (const key of ['Annots', 'Resources', 'Contents']) {
		const slot = page.node.get(PDFName.of(key));
		if (slot instanceof PDFRef) touch(slot);
	}
}

// Resyncs one page's Inkling-authored annotations to match `annotations` (in
// PDF space — see src/pdfView.ts for the canvas<->PDF conversion), in the
// order given. Foreign annotations (no matching `/NM` prefix) are never
// touched.
//
// Only what changed is written. An annotation already on the page under the
// same id, describing the same mark, keeps its existing objects: they are
// relinked, never re-registered, so they never enter the change set and an
// append carries none of them. Everything else is written fresh, and anything
// no longer wanted — erased, or replaced by an edited version — is freed.
//
// This is what makes an append the size of the edit. Rewriting the whole page
// made one stroke on a page of 460 a 565 KB append, past the compaction
// budget, and nearly every save fell back to rewriting the file.
//
// `touch` is how the incremental save path learns which objects this
// rewrote; see src/pdf/changeSet.ts. It defaults to a no-op, so the full
// rewrite path calls this exactly as it always did.
export function writeInklingAnnotations(
	pdfDoc: PDFDocument,
	pageIndex: number,
	annotations: Annotation[],
	touch: TouchFn = () => undefined,
): void {
	const page = pdfDoc.getPage(pageIndex);
	const existing = inklingAnnotationRefs(pdfDoc, page);

	// Each existing ref can be claimed once, by the first incoming annotation
	// with its id that still matches it.
	const claimable = new Map<string, { ref: PDFRef; annotation: Annotation | null }>();
	for (const ref of existing) {
		const annotation = readRef(pdfDoc, ref);
		if (annotation && !claimable.has(annotation.id)) claimable.set(annotation.id, { ref, annotation });
	}
	const plan = annotations.map((annotation): PDFRef | Annotation => {
		const match = claimable.get(annotation.id);
		if (!match?.annotation || !sameAsWritten(match.annotation, annotation)) return annotation;
		claimable.delete(annotation.id);
		return match.ref;
	});

	// Nothing added, nothing dropped, nothing edited, nothing reordered: the
	// page is already right, and touching even its /Annots would put the page
	// into an append for no change at all.
	if (plan.length === existing.length && plan.every((item, index) => item === existing[index])) return;

	const kept = new Set(plan.filter((item): item is PDFRef => item instanceof PDFRef));

	// A picture coming back in a new box keeps the image object it already
	// has in the file (see writeImage).
	const reusedPictures = new Map<string, PDFRef>();
	for (const item of plan) {
		if (item instanceof PDFRef || item.kind !== 'image') continue;
		const previous = claimable.get(item.id);
		if (previous?.annotation?.kind !== 'image' || !samePicture(previous.annotation.picture, item.picture)) continue;
		const picture = pictureRefOf(pdfDoc, previous.ref);
		if (picture) reusedPictures.set(item.id, picture);
	}
	const keepPictures = new Set(reusedPictures.values());

	touchPageContainers(page, touch);
	// Every one of ours comes off, so the relink below can put them back in
	// the order given — /Annots order is paint order. Only the ones not
	// coming back are freed.
	for (const ref of existing) {
		page.node.removeAnnot(ref);
		if (!kept.has(ref)) deleteAnnotationObjects(pdfDoc, ref, keepPictures);
	}
	for (const item of plan) {
		if (item instanceof PDFRef) page.node.addAnnot(item);
		else if (item.kind === 'stroke') writeStroke(pdfDoc, page, item);
		else if (item.kind === 'note') writeNote(pdfDoc, page, item);
		else if (item.kind === 'image') writeImage(pdfDoc, page, item, reusedPictures.get(item.id) ?? null);
		else writeShape(pdfDoc, page, item);
	}
	// Again afterwards: normalize() may have replaced an indirect slot with a
	// direct one, or created the /Annots array that did not exist before.
	touchPageContainers(page, touch);
}

// Builds a display-only copy for pdf.js to render from: our own Inkling
// annotations stripped out, everything else — crucially, annotations from
// other PDF software (Xodo, Acrobat, ...) — left exactly as they were.
// pdf.js's default annotation-baking render (see src/pdfView.ts) has no way
// to selectively bake some annotations and not others, so this exists to
// keep it from doubling up with our own live overlay of *our* annotations
// while still letting it show *foreign* ones, which we never render
// ourselves. Returns whether anything was actually stripped, so the caller
// (annotationWriter.worker.ts) can skip building this copy — and paying for
// its own save() — entirely for the common case of a file with no Inkling
// annotations yet.
export function stripInklingAnnotations(pdfDoc: PDFDocument): boolean {
	let removedAny = false;
	for (const page of pdfDoc.getPages()) {
		if (removeInklingAnnotations(pdfDoc, page)) removedAny = true;
	}
	return removedAny;
}

// A one-time sweep for damage from before deleteAnnotationObjects existed:
// every prior version of removeInklingAnnotations only unlinked a ref from
// a page's /Annots array without freeing the dict/AP-stream/ExtGState
// objects themselves, so every autosave left the *previous* generation of
// each edited page's annotation objects behind, permanently, as dead
// weight nothing pointed to any more but that still got serialized into
// every subsequent save regardless — a file only ever grew, compounding
// with every stroke across every session, until it was large enough to
// trip a sync tool's file-size limit. Finds every Inkling-tagged
// annotation dict (the same /NM `ink-` prefix used everywhere else here)
// that no page's /Annots array links to any more, and frees it the same
// way a normal edit now does. Called once when a file is opened for
// editing (see annotationWriter.worker.ts) so a file bloated by past
// sessions shrinks back down on the very next save.
export function pruneOrphanedInklingAnnotations(pdfDoc: PDFDocument): boolean {
	const linked = new Set<PDFRef>();
	for (const page of pdfDoc.getPages()) {
		const annots = page.node.Annots();
		if (!annots) continue;
		for (const entry of annots.asArray()) {
			if (entry instanceof PDFRef) linked.add(entry);
		}
	}

	let prunedAny = false;
	for (const [ref, object] of pdfDoc.context.enumerateIndirectObjects()) {
		if (linked.has(ref) || !(object instanceof PDFDict)) continue;
		if (!isInklingAnnotationDict(object)) continue;
		deleteAnnotationObjects(pdfDoc, ref);
		prunedAny = true;
	}
	return prunedAny;
}

// ---- Reading ----

function readColor(dict: PDFDict): string {
	const array = dict.lookupMaybe(PDFName.of('C'), PDFArray);
	const [r, g, b] = array ? numbersFromArray(array) : [];
	if (r === undefined || g === undefined || b === undefined) return DEFAULT_COLOR;
	return rgbToHex(r, g, b);
}

function readWidth(dict: PDFDict): number {
	return dict.lookupMaybe(PDFName.of('BS'), PDFDict)?.lookupMaybe(PDFName.of('W'), PDFNumber)?.asNumber() ?? DEFAULT_WIDTH;
}

function readOne(id: string, dict: PDFDict): Annotation | null {
	const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
	const color = readColor(dict);
	const width = readWidth(dict);

	if (subtype === 'Ink') {
		const inkList = dict.lookupMaybe(PDFName.of('InkList'), PDFArray);
		const first = inkList?.lookupMaybe(0, PDFArray);
		const flat = first ? numbersFromArray(first) : [];
		const points: Point[] = [];
		for (let i = 0; i + 1 < flat.length; i += 2) {
			const x = flat[i];
			const y = flat[i + 1];
			if (x !== undefined && y !== undefined) points.push({ x, y });
		}
		if (points.length < 2) return null;

		const extras = dict.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict);
		// A nib name, if one of ours. Anything else in the key — a newer
		// build's nib, a hand edit — reads as the plain pen rather than as
		// nothing at all.
		const brushName = extras?.lookupMaybe(PDFName.of(BRUSH_KEY), PDFName)?.decodeText();
		const brush = isPenBrush(brushName) && brushName !== 'pen' ? brushName : undefined;
		const opacity = dict.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber() ?? 1;
		// A nib means a pen, whatever its opacity says: a pencil's graphite is
		// translucent too, and must not come back as a highlighter.
		const tool = !brush && opacity <= HIGHLIGHTER_OPACITY_MAX ? 'highlighter' : 'pen';

		// Applied only when it describes exactly these points. A length
		// mismatch means something else edited the path without knowing about
		// our private key, and stretching the old pressures over a different
		// number of samples would be inventing data about how hard someone
		// pressed.
		const pressures = dict
			.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict)
			?.lookupMaybe(PDFName.of(PRESSURE_KEY), PDFArray);
		const values = pressures ? numbersFromArray(pressures) : [];
		if (values.length === points.length) {
			for (let index = 0; index < points.length; index++) {
				const point = points[index];
				const value = values[index];
				if (point && value !== undefined) point.p = Math.min(Math.max(value / 255, 0), 1);
			}
		}

		return { id, kind: 'stroke', tool, color, width, points, ...(brush ? { brush } : {}) };
	}

	if (subtype === 'Line') {
		const nums = dict.lookupMaybe(PDFName.of('L'), PDFArray);
		const [x1, y1, x2, y2] = nums ? numbersFromArray(nums) : [];
		if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;

		const endStyle = dict.lookupMaybe(PDFName.of('LE'), PDFArray)?.lookupMaybe(1, PDFName)?.decodeText();
		return {
			id,
			kind: 'shape',
			tool: endStyle === 'OpenArrow' ? 'arrow' : 'line',
			color,
			width,
			start: { x: x1, y: y1 },
			end: { x: x2, y: y2 },
		};
	}

	if (subtype === 'Text') {
		const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
		const [rx0, ry0, rx1, ry1] = rect ? numbersFromArray(rect) : [];
		if (rx0 === undefined || ry0 === undefined || rx1 === undefined || ry1 === undefined) return null;
		// The text itself comes from /Contents via readSharedFields, which
		// runs for every annotation kind — so an empty string here is
		// filled in a moment later, not lost.
		return { id, kind: 'note', color, width, at: { x: (rx0 + rx1) / 2, y: (ry0 + ry1) / 2 }, note: '' };
	}

	if (subtype === 'Stamp') {
		const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
		const [rx0, ry0, rx1, ry1] = rect ? numbersFromArray(rect) : [];
		const picture = readPicture(dict);
		if (rx0 === undefined || ry0 === undefined || rx1 === undefined || ry1 === undefined || !picture) return null;
		const flags = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
		const locked = (flags & LOCKED_FLAG) !== 0;
		return { id, kind: 'image', color, width, start: { x: rx0, y: ry0 }, end: { x: rx1, y: ry1 }, picture, ...(locked ? { locked } : {}) };
	}

	if (subtype === 'Square' || subtype === 'Circle') {
		const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
		const [rx0, ry0, rx1, ry1] = rect ? numbersFromArray(rect) : [];
		if (rx0 === undefined || ry0 === undefined || rx1 === undefined || ry1 === undefined) return null;

		const half = width / 2;
		return {
			id,
			kind: 'shape',
			tool: subtype === 'Square' ? 'rectangle' : 'oval',
			color,
			width,
			start: { x: rx0 + half, y: ry0 + half },
			end: { x: rx1 - half, y: ry1 - half },
		};
	}

	return null;
}

// Reads back this page's previously-saved Inkling annotations, in PDF
// space. Anything not tagged with our `/NM` prefix — including annotations
// this same page already had from other software — is left untouched and
// simply not returned; see the plan's "must gracefully handle foreign
// annotations" note.
export function readInklingAnnotations(pdfDoc: PDFDocument, pageIndex: number): Annotation[] {
	const page = pdfDoc.getPage(pageIndex);
	const annots = page.node.Annots();
	if (!annots) return [];

	const result: Annotation[] = [];
	for (const entry of annots.asArray()) {
		if (!(entry instanceof PDFRef)) continue;
		try {
			const dict = pdfDoc.context.lookupMaybe(entry, PDFDict);
			if (!dict) continue;
			const id = dict.lookupMaybe(PDFName.of('NM'), PDFString)?.decodeText();
			if (!id || !id.startsWith(ID_PREFIX)) continue;

			const annotation = readOne(id, dict);
			if (annotation) result.push(readSharedFields(dict, annotation));
		} catch (error) {
			console.error('Inkling: skipping an unreadable annotation while loading a page.', error);
		}
	}
	return result;
}
