import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { collectAnnotations } from '../../src/extract/extract';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

// Fixtures are generated here rather than committed as binaries, the same
// way the annotationSync tests do it, so the repo holds no opaque test data.
const TEXT = 'Chapter 1: Setting Up Your Python Environment';

// A page carrying one line of real text, plus one annotation of `subtype`
// whose rectangle sits directly over that text. That overlap is the whole
// point: extraction recovers a quote from the words under an annotation, so
// an annotation type that is not markup — a link especially — otherwise
// comes back looking exactly like a highlight of whatever it covers.
async function pageWithAnnotation(subtype: string, extra: Record<string, unknown> = {}): Promise<ArrayBuffer> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page.drawText(TEXT, { x: 50, y: 700, size: 12, font });

	const dict = doc.context.obj({
		Type: 'Annot',
		Subtype: subtype,
		Rect: [40, 690, 400, 716],
		F: 4,
		...extra,
	});
	const ref = doc.context.register(dict);
	page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));

	const bytes = await doc.save();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('collectAnnotations', () => {
	// The reported bug: a book with no highlights in it produced a full
	// annotations note. Its table of contents is 201 link annotations, and
	// each one sits on the text it links from.
	it('ignores a link annotation sitting over text', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Link'))).toEqual([]);
	});

	it('ignores a form field', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Widget'))).toEqual([]);
	});

	it('ignores a popup', async () => {
		expect(await collectAnnotations(await pageWithAnnotation('Popup'))).toEqual([]);
	});

	// The other half of the boundary: filtering must not throw away the
	// annotations extraction exists for, including the subtypes InklingExpanded
	// itself writes (Ink, Text, Line, Square, Circle — see pdf/annotationSync.ts).
	it('keeps a square, which is what InklingExpanded writes for a rectangle', async () => {
		const found = await collectAnnotations(await pageWithAnnotation('Square'));
		expect(found).toHaveLength(1);
		expect(found[0]?.quote).toContain('Setting Up Your Python Environment');
	});

	it('keeps a highlight made in other PDF software', async () => {
		// QuadPoints and not just a Rect: pdf.js discards a Highlight without
		// them, so a fixture missing them tests nothing at all.
		const found = await collectAnnotations(
			await pageWithAnnotation('Highlight', { QuadPoints: [40, 716, 400, 716, 40, 690, 400, 690] }),
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.foreign).toBe(true);
	});

	it('keeps a sticky note for its contents even with no text under it', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		// PDFString, not a bare JS string: context.obj turns a string into a
		// PDFName, which writes /Contents /look here — not a text string at
		// all, and pdf.js reads it back as empty.
		const dict = doc.context.obj({
			Type: 'Annot',
			Subtype: 'Text',
			Rect: [40, 100, 60, 120],
			Contents: PDFString.of('look here'),
		});
		page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(dict)]));
		const bytes = await doc.save();
		const found = await collectAnnotations(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		expect(found).toHaveLength(1);
		expect(found[0]?.note).toBe('look here');
	});
});

describe('collectAnnotations, on InklingExpanded’s own annotations', () => {
	async function withInklingAnnotations(annotations: Annotation[], text = true): Promise<ArrayBuffer> {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		if (text) {
			const font = await doc.embedFont(StandardFonts.Helvetica);
			page.drawText(TEXT, { x: 50, y: 700, size: 12, font });
		}
		writeInklingAnnotations(doc, 0, annotations);
		const bytes = await doc.save();
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	const highlight: Annotation = {
		id: 'ink-abc123',
		kind: 'stroke',
		tool: 'highlighter',
		color: '#f08c00',
		width: 12,
		points: [{ x: 50, y: 706 }, { x: 200, y: 706 }],
		note: 'my comment here',
		quote: 'Chapter 1: Setting Up',
	};

	// pdf.js exposes no /NM at all, so every annotation used to read back as
	// somebody else's however plainly it was ours — and the block reference
	// in the extracted note was derived from a position rather than the id
	// sitting in the file, so it changed whenever the annotation moved.
	it('knows its own annotations from foreign ones, and keeps their ids', async () => {
		const found = await collectAnnotations(await withInklingAnnotations([highlight]));
		expect(found).toHaveLength(1);
		expect(found[0]?.id).toBe('ink-abc123');
		expect(found[0]?.foreign).toBe(false);
	});

	it('reads the comment back', async () => {
		const found = await collectAnnotations(await withInklingAnnotations([highlight]));
		expect(found[0]?.note).toBe('my comment here');
	});

	// The stored quote is why this works on a scan: there is no text layer to
	// recover the words from, and there does not need to be.
	it('recovers the stored quote from a page with no text at all', async () => {
		const found = await collectAnnotations(await withInklingAnnotations([highlight], false));
		expect(found).toHaveLength(1);
		expect(found[0]?.quote).toBe('Chapter 1: Setting Up');
	});

	it('keeps a note annotation, whose text is the whole of it', async () => {
		const note: Annotation = {
			id: 'ink-note1',
			kind: 'note',
			color: '#e03131',
			width: 3,
			at: { x: 300, y: 300 },
			note: 'a sticky note',
		};
		const found = await collectAnnotations(await withInklingAnnotations([note], false));
		expect(found).toHaveLength(1);
		expect(found[0]?.note).toBe('a sticky note');
		expect(found[0]?.foreign).toBe(false);
	});
});

describe('collectAnnotations, reading what other software wrote', () => {
	// A literal (note) and a hex <6E6F7465> are the same value spelled two
	// ways, and both are legal. Knowing only one loses every comment written
	// by whichever tool prefers the other.
	it('reads a comment stored as a hex string', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		const dict = doc.context.obj({
			Type: 'Annot',
			Subtype: 'Text',
			Rect: [40, 100, 60, 120],
			Contents: PDFHexString.fromText('written in hex'),
		});
		page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(dict)]));
		const bytes = await doc.save();
		const found = await collectAnnotations(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		expect(found).toHaveLength(1);
		expect(found[0]?.note).toBe('written in hex');
	});

	it('reads a grey colour, which is one component rather than three', async () => {
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		const dict = doc.context.obj({
			Type: 'Annot',
			Subtype: 'Text',
			Rect: [40, 100, 60, 120],
			Contents: PDFString.of('grey'),
			C: [0.5],
		});
		page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(dict)]));
		const bytes = await doc.save();
		const found = await collectAnnotations(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
		expect(found[0]?.color).toBe('#808080');
	});
});
