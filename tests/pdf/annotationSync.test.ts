import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { recordChanges } from '../../src/pdf/changeSet';
import type { Annotation } from '../../src/annotate/types';

// Fixtures are generated here rather than committed as binaries, so the repo
// holds no opaque test data.
async function blankDoc(pages = 1): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	for (let index = 0; index < pages; index++) doc.addPage([612, 792]);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

describe('annotation round trip', () => {
	it('recovers a pen stroke through a save and reload', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a',
			kind: 'stroke',
			tool: 'pen',
			color: '#e03131',
			width: 4,
			points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);

		const read = readInklingAnnotations(await reload(doc), 0);
		expect(read).toHaveLength(1);
		expect(read[0]).toMatchObject({ id: 'ink-a', kind: 'stroke', color: '#e03131', width: 4 });
		expect(read[0]).toMatchObject({ points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }] });
	});

	it('tells a highlighter apart from a pen by its opacity', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-h',
				kind: 'stroke',
				tool: 'highlighter',
				color: '#f08c00',
				width: 12,
				points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
			},
		]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({ tool: 'highlighter' });
	});

	it('recovers a rectangle at its exact bounds, with no drift per save', async () => {
		// `/Rect` is padded by half the stroke width on write and unpadded on
		// read. If those two disagree the shape creeps outward a little on
		// every single autosave.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-r',
				kind: 'shape',
				tool: 'rectangle',
				color: '#1971c2',
				width: 6,
				start: { x: 100, y: 100 },
				end: { x: 300, y: 250 },
			},
		]);

		let current = await reload(doc);
		for (let pass = 0; pass < 3; pass++) {
			const [read] = readInklingAnnotations(current, 0);
			expect(read).toMatchObject({ start: { x: 100, y: 100 }, end: { x: 300, y: 250 } });
			writeInklingAnnotations(current, 0, read ? [read] : []);
			current = await reload(current);
		}
	});

	it('recovers an arrow as an arrow, not a plain line', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [
			{
				id: 'ink-arrow',
				kind: 'shape',
				tool: 'arrow',
				color: '#2f9e44',
				width: 3,
				start: { x: 10, y: 10 },
				end: { x: 200, y: 120 },
			},
		]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({
			tool: 'arrow',
			start: { x: 10, y: 10 },
			end: { x: 200, y: 120 },
		});
	});

	it('replaces its own annotations rather than stacking duplicates', async () => {
		const doc = await blankDoc();
		const stroke: Annotation = {
			id: 'ink-a',
			kind: 'stroke',
			tool: 'pen',
			color: '#000000',
			width: 3,
			points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
		};
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		writeInklingAnnotations(doc, 0, [stroke]);
		expect(readInklingAnnotations(await reload(doc), 0)).toHaveLength(1);
	});

	it('never touches annotations authored by other software', async () => {
		const doc = await blankDoc();
		const page = doc.getPage(0);
		// A foreign annotation: no `/NM` starting with `ink-`.
		page.node.addAnnot(
			doc.context.register(
				doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4 }),
			),
		);

		writeInklingAnnotations(doc, 0, [
			{ id: 'ink-a', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
		]);

		const reloaded = await reload(doc);
		expect(readInklingAnnotations(reloaded, 0)).toHaveLength(1);
		// One of ours plus the untouched foreign one.
		expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);
	});

	it('keeps each page’s annotations to that page', async () => {
		const doc = await blankDoc(3);
		writeInklingAnnotations(doc, 1, [
			{ id: 'ink-p2', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
		]);
		const reloaded = await reload(doc);
		expect(readInklingAnnotations(reloaded, 0)).toHaveLength(0);
		expect(readInklingAnnotations(reloaded, 1)).toHaveLength(1);
		expect(readInklingAnnotations(reloaded, 2)).toHaveLength(0);
	});
});

describe('rewriting a page only where it changed', () => {
	// An append carries whatever a save wrote. Rewriting every annotation on
	// the page made a one-stroke save on a page of 460 strokes a 565 KB
	// append, which blew the compaction budget and turned nearly every save
	// back into a full rewrite. So a save has to leave an annotation it did
	// not change exactly where it was: same object, not written again.
	function stroke(id: string, x: number, color = '#000000'): Annotation {
		return { id, kind: 'stroke', tool: 'pen', color, width: 3, points: [{ x, y: 10 }, { x: x + 20, y: 30 }] };
	}

	function refsOnPage(doc: PDFDocument, pageIndex = 0): PDFRef[] {
		return (doc.getPage(pageIndex).node.Annots()?.asArray() ?? []).filter((entry): entry is PDFRef => entry instanceof PDFRef);
	}

	it('keeps an unchanged annotation’s object when another is added', async () => {
		const doc = await reload(await blankDoc());
		writeInklingAnnotations(doc, 0, [stroke('ink-a', 10)]);
		const [original] = refsOnPage(doc);

		const changes = recordChanges(doc.context, (touch) =>
			writeInklingAnnotations(doc, 0, [stroke('ink-a', 10), stroke('ink-b', 100)], touch),
		);

		expect(refsOnPage(doc)[0]).toBe(original);
		expect(changes.written.has(original!)).toBe(false);
		expect(changes.freed.has(original!)).toBe(false);
		expect(readInklingAnnotations(await reload(doc), 0).map((a) => a.id)).toEqual(['ink-a', 'ink-b']);
	});

	it('records no change at all for a page saved exactly as it was', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [stroke('ink-a', 10), stroke('ink-b', 100)]);

		const changes = recordChanges(doc.context, (touch) =>
			writeInklingAnnotations(doc, 0, [stroke('ink-a', 10), stroke('ink-b', 100)], touch),
		);

		expect(changes.written.size).toBe(0);
		expect(changes.freed.size).toBe(0);
	});

	it('rewrites an annotation whose content changed under the same id', async () => {
		// Recolouring keeps the id. Matching on id alone would keep the old
		// object and silently lose the edit.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [stroke('ink-a', 10)]);
		const [original] = refsOnPage(doc);

		const changes = recordChanges(doc.context, (touch) =>
			writeInklingAnnotations(doc, 0, [stroke('ink-a', 10, '#e03131')], touch),
		);

		expect(changes.freed.has(original!)).toBe(true);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({ id: 'ink-a', color: '#e03131' });
	});

	it('frees the objects of an annotation that was erased and keeps the rest', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [stroke('ink-a', 10), stroke('ink-b', 100)]);
		const [kept, erased] = refsOnPage(doc);

		const changes = recordChanges(doc.context, (touch) => writeInklingAnnotations(doc, 0, [stroke('ink-a', 10)], touch));

		expect(changes.freed.has(erased!)).toBe(true);
		expect(changes.freed.has(kept!)).toBe(false);
		expect(refsOnPage(doc)).toEqual([kept]);
	});

	it('keeps the drawing order it was given', async () => {
		// /Annots order is paint order: a stroke later in the list draws over
		// an earlier one.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [stroke('ink-a', 10), stroke('ink-b', 100)]);

		writeInklingAnnotations(doc, 0, [stroke('ink-b', 100), stroke('ink-a', 10)]);

		expect(readInklingAnnotations(await reload(doc), 0).map((a) => a.id)).toEqual(['ink-b', 'ink-a']);
	});

	it('treats a stroke that came back through the screen as unchanged', async () => {
		// The view seeds strokes into screen space and converts them back on
		// save, which does not always return the exact number the file held —
		// and pressure is stored as a byte, so it reads back as n/255 rather
		// than what was drawn. Neither is an edit.
		const doc = await blankDoc();
		const drawn: Annotation = {
			id: 'ink-p',
			kind: 'stroke',
			tool: 'pen',
			color: '#1e1e1e',
			width: 2.5,
			points: [{ x: 100.1, y: 200.2, p: 0.5 }, { x: 150.3, y: 260.4, p: 0.7 }],
		};
		writeInklingAnnotations(doc, 0, [drawn]);
		const reloaded = await reload(doc);
		const [read] = readInklingAnnotations(reloaded, 0);
		if (read?.kind !== 'stroke') throw new Error('expected the stroke back');
		const throughScreen: Annotation = {
			...read,
			width: read.width * (1 + 1e-15),
			points: read.points.map((p) => ({ ...p, x: p.x + 1e-12, y: p.y - 1e-12 })),
		};

		const changes = recordChanges(reloaded.context, (touch) => writeInklingAnnotations(reloaded, 0, [throughScreen], touch));

		expect(changes.written.size).toBe(0);
		expect(changes.freed.size).toBe(0);
	});
});

describe('highlighter appearance in the file', () => {
	const highlight: Annotation = {
		id: 'ink-h',
		kind: 'stroke',
		tool: 'highlighter',
		color: '#ffd43b',
		width: 12,
		points: [{ x: 10, y: 20 }, { x: 90, y: 20 }],
	};

	// The appearance stream is what every other PDF reader actually paints,
	// so whatever makes a highlight look right on screen has to be stated
	// here too or the saved file stops matching the editor.
	//
	// Read out of the object graph rather than by scanning the saved bytes:
	// pdf-lib deflates stream contents on save, so the operators are not
	// there to grep for.
	async function appearanceOf(annotation: Annotation): Promise<{ ops: string; blend: string | undefined }> {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [annotation]);

		const annots = doc.getPage(0).node.Annots();
		const dict = annots?.lookup(0, PDFDict);
		const ref = dict?.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'));
		const stream = ref ? doc.context.lookup(ref) : undefined;
		if (!(stream instanceof PDFRawStream)) throw new Error('no appearance stream was written');

		const blend = stream.dict
			.lookupMaybe(PDFName.of('Resources'), PDFDict)
			?.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
			?.lookupMaybe(PDFName.of('GS0'), PDFDict)
			?.lookupMaybe(PDFName.of('BM'), PDFName)
			?.decodeText();

		// Deflated in the file, as every appearance is; read as a reader would.
		return { ops: new TextDecoder().decode(decodePDFRawStream(stream).decode()), blend };
	}

	it('multiplies the highlight into the page rather than painting over it', async () => {
		expect((await appearanceOf(highlight)).blend).toBe('Multiply');
	});

	it('leaves a pen stroke opaque and unblended', async () => {
		expect((await appearanceOf({ ...highlight, id: 'ink-p', tool: 'pen', color: '#1e1e1e' })).blend).toBeUndefined();
	});

	it('gives a highlight flat ends, not the pen’s round cap', async () => {
		// `0 J` is butt cap, `1 J` round. A round cap on a text-height bar
		// bulges half that height past the first and last glyph.
		expect((await appearanceOf(highlight)).ops).toContain('0 J');
		expect((await appearanceOf({ ...highlight, id: 'ink-p', tool: 'pen' })).ops).toContain('1 J');
	});

	it('still round-trips as a highlighter after the opacity changed', async () => {
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [highlight]);
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({ tool: 'highlighter' });
	});

	it('still reads highlights written before the opacity changed', async () => {
		// Files already in vaults carry CA 0.4. The threshold has to keep
		// admitting them, not just the value this version happens to write.
		const doc = await blankDoc();
		writeInklingAnnotations(doc, 0, [highlight]);
		const dict = doc.getPage(0).node.Annots()?.lookup(0, PDFDict);
		dict?.set(PDFName.of('CA'), PDFNumber.of(0.4));
		expect(readInklingAnnotations(await reload(doc), 0)[0]).toMatchObject({ tool: 'highlighter' });
	});
});
