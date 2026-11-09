// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetCopied } from '../../src/annotate/controller';
import { boundingBox, scaleAnnotationAbout, translateAnnotation } from '../../src/annotate/geometry';
import { eraseAt } from '../../src/annotate/eraser';
import { ToolState } from '../../src/annotate/toolState';
import type { Annotation, ShapeAnnotation, TextAnnotation } from '../../src/annotate/types';
import { readInklingAnnotations, sameInFile, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { mountTestSurface, type TestSurface } from '../harness/surface';
import { parseInkBlock, serializeInkBlock } from '../../src/markdown/inkBlockFormat';

// Text typed on the page, and shapes with a line style of their own.

const words: TextAnnotation = { id: 'ink-t', kind: 'text', color: '#c92a2a', width: 14, at: { x: 100, y: 500 }, text: 'Größe: 5 €\nzweite Zeile' };

async function roundTrip(annotations: Annotation[], rotation = 0): Promise<Annotation[]> {
	const doc = await PDFDocument.create();
	const page = doc.addPage([612, 792]);
	if (rotation) page.setRotation({ type: 'degrees', angle: rotation } as never);
	writeInklingAnnotations(doc, 0, annotations);
	return readInklingAnnotations(await PDFDocument.load(await doc.save()), 0);
}

describe('text in a PDF', () => {
	it('comes back exactly, umlauts and euro included', async () => {
		const [read] = await roundTrip([words]);
		expect(read).toMatchObject({ kind: 'text', text: 'Größe: 5 €\nzweite Zeile', color: '#c92a2a', at: { x: 100, y: 500 } });
		expect(read?.width).toBeCloseTo(14, 2);
		expect(sameInFile(read, words)).toBe(true);
	});

	it('keeps characters its font cannot show', async () => {
		const [read] = await roundTrip([{ ...words, text: '日本語 ✓' }]);
		expect(read?.kind === 'text' && read.text).toBe('日本語 ✓');
	});

	it('moves, sizes and erases like anything else', () => {
		const moved = translateAnnotation(words, 10, 20) as TextAnnotation;
		expect(moved.at).toEqual({ x: 110, y: 520 });
		const doubled = scaleAnnotationAbout(words, { x: 0, y: 0 }, 2) as TextAnnotation;
		expect(doubled.width).toBe(28);
		expect(doubled.at).toEqual({ x: 200, y: 1000 });
		const box = boundingBox(words);
		expect(eraseAt([words], { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }, 5)).toHaveLength(0);
	});
});

describe('line styles in a PDF', () => {
	const shape = (over: Partial<ShapeAnnotation>): ShapeAnnotation => ({
		id: 'ink-s',
		kind: 'shape',
		tool: 'rectangle',
		color: '#1e1e1e',
		width: 2,
		start: { x: 100, y: 100 },
		end: { x: 300, y: 200 },
		...over,
	});

	it.each([
		['dashed line', { tool: 'line', dash: 'dashed' }],
		['dotted line', { tool: 'line', dash: 'dotted' }],
		['filled rectangle', { filled: true }],
		['filled, dashed oval', { tool: 'oval', filled: true, dash: 'dashed' }],
		['double arrow', { tool: 'arrow', bothEnds: true }],
	] as [string, Partial<ShapeAnnotation>][])('keeps a %s', async (_name, over) => {
		const [read] = await roundTrip([shape(over)]);
		expect(read).toMatchObject(over);
		expect(sameInFile(read, shape(over))).toBe(true);
	});

	it('tells a style change from no change', () => {
		expect(sameInFile(shape({}), shape({ dash: 'dashed' }))).toBe(false);
		expect(sameInFile(shape({}), shape({ filled: true }))).toBe(false);
	});
});

describe('in an ink block', () => {
	it('text and line styles survive the format', () => {
		const shape: ShapeAnnotation = { id: 'ink-s', kind: 'shape', tool: 'oval', color: '#000000', width: 2, start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, dash: 'dotted', filled: true };
		const text = serializeInkBlock({ version: 2, width: 800, height: 450, annotations: [words, shape] });
		const parsed = parseInkBlock(text);
		expect(parsed.malformed).toBe(false);
		expect(parsed.data.annotations).toHaveLength(2);
		expect(parsed.data.annotations[0]).toMatchObject({ kind: 'text', text: words.text });
		expect(parsed.data.annotations[1]).toMatchObject({ dash: 'dotted', filled: true });
	});
});

describe('typing on the page', () => {
	let surface: TestSurface;
	const editor = () => surface.host.querySelector<HTMLTextAreaElement>('.inkling-text-editor');
	const tap = (x: number, y: number) => {
		surface.pointer('pointerdown', x, y, { pointerType: 'pen' });
		surface.pointer('pointerup', x, y, { pointerType: 'pen', buttons: 0 });
	};
	const type = (value: string) => {
		const box = editor();
		if (!box) throw new Error('no text box');
		box.value = value;
	};

	beforeEach(() => {
		document.body.innerHTML = '';
		forgetCopied();
		surface = mountTestSurface(800, 450, { getUnitScale: () => 2 });
		surface.controller.setTool('text');
	});

	it('opens a box where it is tapped, and a press elsewhere keeps what was typed', () => {
		tap(200, 100);
		expect(editor()).not.toBeNull();
		type('Hallo');
		tap(600, 300);
		expect(editor()).toBeNull();
		const [text] = surface.annotations();
		expect(text).toMatchObject({ kind: 'text', text: 'Hallo' });
		// In points on the page: 14 of them, at this page's two pixels each.
		expect(text?.width).toBe(28);
	});

	it('is one step of undo', () => {
		tap(200, 100);
		type('Hallo');
		surface.controller.setTool('pen');
		expect(surface.annotations()).toHaveLength(1);
		surface.controller.undo();
		expect(surface.annotations()).toHaveLength(0);
	});

	it('changes text already there, and removes it when emptied', () => {
		tap(200, 100);
		type('Hallo');
		tap(600, 300);
		const [first] = surface.annotations() as TextAnnotation[];
		tap((first as TextAnnotation).at.x + 5, (first as TextAnnotation).at.y + 5);
		expect(editor()?.value).toBe('Hallo');
		// Off the page while it is being typed over.
		expect(surface.annotations()).toHaveLength(0);
		type('Tschüss');
		tap(600, 300);
		const [changed] = surface.annotations() as TextAnnotation[];
		expect(changed?.text).toBe('Tschüss');
		expect(changed?.id).toBe(first?.id);

		tap((changed as TextAnnotation).at.x + 5, (changed as TextAnnotation).at.y + 5);
		type('');
		tap(600, 300);
		expect(surface.annotations()).toHaveLength(0);
	});

	it('puts things back as they were on Escape', () => {
		tap(200, 100);
		type('Hallo');
		tap(600, 300);
		const [first] = surface.annotations() as TextAnnotation[];
		tap((first as TextAnnotation).at.x + 5, (first as TextAnnotation).at.y + 5);
		type('anders');
		editor()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(editor()).toBeNull();
		expect((surface.annotations()[0] as TextAnnotation).text).toBe('Hallo');
	});

	it('leaves nothing behind for a box left empty', () => {
		tap(200, 100);
		tap(600, 300);
		expect(surface.annotations()).toHaveLength(0);
	});

	it('takes a tap from a finger too', () => {
		surface.pointer('pointerdown', 200, 100, { pointerType: 'touch', pointerId: 9 });
		surface.pointer('pointerup', 200, 100, { pointerType: 'touch', pointerId: 9, buttons: 0 });
		expect(editor()).not.toBeNull();
	});
});

describe('the shape picker’s settings', () => {
	it('draw the next shape, and are remembered on the device', () => {
		document.body.innerHTML = '';
		const surface = mountTestSurface(800, 450);
		surface.controller.setTool('rectangle');
		surface.controller.setShapeOptions({ dash: 'dashed', filled: true });
		surface.pointer('pointerdown', 100, 100, { pointerType: 'pen' });
		surface.pointer('pointermove', 300, 200, { pointerType: 'pen' });
		surface.pointer('pointerup', 300, 200, { pointerType: 'pen', buttons: 0 });
		expect(surface.annotations()[0]).toMatchObject({ dash: 'dashed', filled: true });

		const state = new ToolState();
		state.setShapeOptions({ dash: 'dotted', bothEnds: true });
		const fresh = new ToolState();
		fresh.restore(JSON.parse(JSON.stringify(state.snapshot())));
		expect(fresh.getShapeOptions()).toMatchObject({ dash: 'dotted', bothEnds: true, filled: false });
	});

	it('only apply where they mean something', () => {
		document.body.innerHTML = '';
		const surface = mountTestSurface(800, 450);
		surface.controller.setShapeOptions({ filled: true, bothEnds: true, dash: 'solid' });
		surface.controller.setTool('line');
		surface.pointer('pointerdown', 100, 100, { pointerType: 'pen' });
		surface.pointer('pointermove', 300, 200, { pointerType: 'pen' });
		surface.pointer('pointerup', 300, 200, { pointerType: 'pen', buttons: 0 });
		const [line] = surface.annotations() as ShapeAnnotation[];
		expect(line?.filled).toBeUndefined();
		expect(line?.bothEnds).toBeUndefined();
		expect(line?.dash).toBeUndefined();
		vi.restoreAllMocks();
	});
});

describe('pasting into a surface that cannot keep it', () => {
	it('leaves out what an ink block has no room for', () => {
		document.body.innerHTML = '';
		forgetCopied();
		const pdf = mountTestSurface(800, 450);
		const note: Annotation = { id: 'ink-n', kind: 'note', color: '#000000', width: 1, at: { x: 100, y: 100 }, note: 'x' };
		const stroke: Annotation = { id: 'ink-p', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 120, y: 100 }, { x: 200, y: 100 }] };
		pdf.controller.seedPage(1, [note, stroke]);
		(pdf.controller as unknown as { selection: { pageNumber: number; ids: Set<string> } }).selection = { pageNumber: 1, ids: new Set(['ink-n', 'ink-p']) };
		pdf.controller.copySelection();

		const block = mountTestSurface(800, 450, { acceptedKinds: ['stroke', 'shape', 'text'] });
		expect(block.controller.pasteAt(1, { x: 400, y: 200 })).toBe(true);
		expect(block.annotations().map((a) => a.kind)).toEqual(['stroke']);
	});
});
