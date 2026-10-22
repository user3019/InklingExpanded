export interface Point {
	x: number;
	y: number;
	// Stylus pressure at this sample, 0 to 1.
	//
	// Optional, and that is the whole compatibility story: every annotation
	// already in a vault, every ink block already in a note, and every
	// /InkList read back out of a PDF parses unchanged and simply has none.
	// A stroke with no pressure on any point draws exactly as it always did
	// (see annotate/stroke.ts).
	p?: number;
}

export type DrawToolType = 'pen' | 'highlighter';

// Which pen a pen stroke was drawn with. 'pen' is the round pen, smooth
// with round ends, which every stroke was drawn with before there was a
// choice — a stroke with no brush at all is one of those. 'sharp' follows
// the hand exactly, corners and all, and ends square. How each draws is in
// annotate/stroke.ts.
export type PenBrush = 'pen' | 'sharp';

export const PEN_BRUSHES: readonly PenBrush[] = ['pen', 'sharp'];

export function isPenBrush(value: unknown): value is PenBrush {
	return typeof value === 'string' && (PEN_BRUSHES as readonly string[]).includes(value);
}
export type ShapeToolType = 'line' | 'rectangle' | 'oval' | 'arrow';
export type ToolType = 'select' | DrawToolType | 'eraser' | 'note' | ShapeToolType;

interface BaseAnnotation {
	id: string;
	color: string;
	width: number;
	// The document text this annotation covers, captured when it was
	// drawn. Optional and never relied on: extraction recomputes it
	// geometrically when it is absent, which is what lets highlights made
	// before this existed — and ones made in other PDF software — extract
	// too. Stored only as a shortcut, so the common case needs no text
	// layer at all.
	quote?: string;
	// What the user wrote about it. Serialized to the annotation’s own
	// /Contents, which is the standard field, so other PDF readers show
	// it as a tooltip rather than losing it.
	note?: string;
}

export interface StrokeAnnotation extends BaseAnnotation {
	kind: 'stroke';
	tool: DrawToolType;
	points: Point[];
	// A pen stroke's nib. Absent for the plain pen, so that every stroke
	// drawn before nibs existed, and every one drawn with the plain pen
	// since, is stored exactly as it always was.
	brush?: PenBrush;
}

// A comment pinned to a spot on the page. Unlike a stroke or a shape it
// has no extent of its own: it is a marker of fixed size, and the text
// is the content. `note` is required here where it is optional on the
// base, because a note annotation with nothing in it is not a note.
export interface NoteAnnotation extends BaseAnnotation {
	kind: 'note';
	at: Point;
	note: string;
}

export interface ShapeAnnotation extends BaseAnnotation {
	kind: 'shape';
	tool: ShapeToolType;
	start: Point;
	end: Point;
}

// A picture's pixels, as a page holds them. JPEG bytes for a picture with
// nothing see-through in it, which is nearly every photo and keeps one
// small; raw RGBA otherwise, so a transparent PNG keeps its transparency.
// Either way exactly what goes into the PDF, so reading one back out of a
// file gives back what was put in.
export interface PicturePixels {
	format: 'jpeg' | 'rgba';
	width: number;
	height: number;
	data: Uint8Array;
}

// A picture placed on a page: an image imported from the vault or the
// device, which can be moved, scaled and deleted like a drawing, and is
// drawn beneath the ink so it can be written on. `start` and `end` are
// opposite corners of the box it fills.
export interface ImageAnnotation extends BaseAnnotation {
	kind: 'image';
	start: Point;
	end: Point;
	picture: PicturePixels;
	// Locked in place: it can still be selected — which is how it is
	// unlocked again — but not moved, sized or deleted, and a lasso drawn
	// round the writing on it leaves it where it is.
	locked?: boolean;
}

export function isLockedPicture(annotation: Annotation): boolean {
	return annotation.kind === 'image' && annotation.locked === true;
}

export type Annotation = StrokeAnnotation | ShapeAnnotation | NoteAnnotation | ImageAnnotation;

// The marker a note annotation draws, in the surface’s own coordinate
// space. Fixed rather than derived from stroke width: a note has no
// width, and a marker that shrank with the pen would become untappable
// exactly when someone had chosen a fine pen to annotate densely.
export const NOTE_MARKER_SIZE = 18;

export interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export const DEFAULT_COLOR = '#1e1e1e';

// Named, not just hex: the swatches' tooltips read "Red" rather than
// "#e03131", which is what a person picking a pen color actually wants to
// see on hover.
export interface PresetColor {
	value: string;
	label: string;
}

// What a pen (and every shape, and a note marker) draws in: saturated inks
// meant to be read *as* marks on top of the page.
export const PEN_COLORS: readonly PresetColor[] = [
	{ value: DEFAULT_COLOR, label: 'Ink' },
	{ value: '#e03131', label: 'Red' },
	{ value: '#f08c00', label: 'Orange' },
	{ value: '#2f9e44', label: 'Green' },
	{ value: '#1971c2', label: 'Blue' },
	{ value: '#9c36b5', label: 'Purple' },
];

// What a highlighter draws in, which is a different job and so a different
// set: pale tints meant to colour the paper *under* the words rather than
// mark over them. The pen's inks are all far too dark for that — a
// highlighter is multiplied into the page (see HIGHLIGHTER_OPACITY), and
// multiplying #1e1e1e into a line of text just blacks it out.
//
// The two palettes are the same six hues from the same family, one rung
// bright and one rung pale, so the strip does not change character when the
// tool does. The yellow is the one exception, for the reason below.
export const HIGHLIGHTER_COLORS: readonly PresetColor[] = [
	// The only swatch here that is not from Open Color, because Open Color
	// has no yellow that survives the multiply as one — and because getting
	// this right took two numbers, not one.
	//
	// What the page shows is 0.4 + 0.6 x colour. That arithmetic barely
	// moves hue: yellow-4 (#ffd43b, what this opened on) composites to hue
	// 47 and yellow-3 (#ffe066, tried next) to 48, both golds, which is what
	// "it looks orange" was reporting twice. But hue alone was not the whole
	// fault either. #faf14a, tried third, reached hue 57 by raising green —
	// and raising green toward red is moving the colour *toward white*, so
	// its chroma fell to 106 against the gold's 118 and it was reported
	// duller than the colour it replaced. A pale yellow at high lightness
	// reads olive, not bright.
	//
	// Blue is the channel that decides chroma here, and it is the one both
	// earlier attempts left alone. Composited blue is 102 + 0.6 x blue, so
	// zero is the floor and 153 the most chroma this multiply can carry.
	// This sits on it: rgb(255, 255, 102), hue 60, chroma 153 — a pure
	// yellow at the top of the range rather than a compromise inside it,
	// which is also what highlighter ink itself looks like on paper.
	{ value: '#ffff00', label: 'Yellow' },
	{ value: '#a9e34b', label: 'Green' },
	{ value: '#ffa8a8', label: 'Pink' },
	{ value: '#66d9e8', label: 'Blue' },
	// Kept, unlike in the first attempt at this, which retired the orange on
	// the grounds that the strip held two of them. That was true of a strip
	// whose "yellow" was a gold; against a yellow at hue 57 an orange at 31
	// is a different colour, and retiring it would cost the palette a hue to
	// fix a clash that is no longer there.
	{ value: '#ffa94d', label: 'Orange' },
	{ value: '#d0bfff', label: 'Purple' },
];

// Retired from the strip, still nameable.
//
// A colour that leaves the palette must not leave this file. Extraction
// names a colour from ALL_PRESET_COLORS and the settings tab builds its
// category labels from the same list, so a hue simply deleted would turn
// every annotation already drawn in it into a bare hex code in the extracted
// note — a silent regression in files the user cannot re-make, since the
// highlights are already in the books.
const RETIRED_COLORS: readonly PresetColor[] = [{ value: '#ffd43b', label: 'Gold' }];

// Every colour the plugin can label or offer anywhere, in one list. The
// settings tab's category names key off this rather than off PEN_COLORS
// alone, so a highlighter tint can carry a meaning ("Yellow = definition")
// the same way an ink colour can.
export const ALL_PRESET_COLORS: readonly PresetColor[] = [...PEN_COLORS, ...HIGHLIGHTER_COLORS, ...RETIRED_COLORS];

// Which swatches the toolbar shows for a given tool. Only the highlighter
// differs; a shape or a note is drawn in ink like the pen is.
export function paletteFor(tool: ToolType): readonly PresetColor[] {
	return tool === 'highlighter' ? HIGHLIGHTER_COLORS : PEN_COLORS;
}

export const DEFAULT_WIDTH = 3;

// A highlighter's default, in the same units. Freehand highlighting with a
// 3px nib is just a pale pen — a highlighter has to be about as tall as a
// line of text before it reads as one at all. (A highlighter dragged over
// real text is snapped to the line's own height instead; see
// highlightBarHeight in src/pdf/textLines.ts. This is what it draws with in
// a margin, over a diagram, or in an ink block with no text under it.)
export const DEFAULT_HIGHLIGHTER_WIDTH = 16;

// How strongly a highlighter tints the page beneath it.
//
// Applied as a *multiply*, not as paint laid over the top — on screen via
// the highlight layer's mix-blend-mode (styles.css), and in the file via a
// /BM /Multiply ExtGState (src/pdf/annotationSync.ts). That distinction is
// the whole reason highlights used to look wrong: source-over at any alpha
// puts colour *between* the reader and the words, so black text under a
// highlight came out grey and the page looked washed. Multiplied, the
// arithmetic protects the text for free — black times anything is black —
// and this number only ever controls how saturated the *paper* goes.
//
// Kept meaningfully below 1 for a second reason: it is also the annotation's
// /CA in the file, and that is how a stroke is told apart from a highlight
// when read back (see HIGHLIGHTER_OPACITY_MAX in src/pdf/annotationSync.ts).
export const HIGHLIGHTER_OPACITY = 0.6;

export const MIN_WIDTH = 1;
export const MAX_WIDTH = 40;

// A tool's colour and width before the user has expressed any preference.
// Per tool rather than one global pair, because "the default" genuinely
// differs: a pen wants a fine dark nib and a highlighter wants a broad pale
// one, and starting the highlighter on the pen's defaults is what made it
// draw a hairline black smear the first time anyone reached for it.
export function defaultStyleFor(tool: ToolType, brush: PenBrush = 'pen'): { color: string; width: number } {
	if (tool === 'highlighter') {
		return { color: HIGHLIGHTER_COLORS[0]?.value ?? DEFAULT_COLOR, width: DEFAULT_HIGHLIGHTER_WIDTH };
	}
	if (tool === 'pen') return { color: DEFAULT_COLOR, width: DEFAULT_BRUSH_WIDTHS[brush] };
	return { color: DEFAULT_COLOR, width: DEFAULT_WIDTH };
}

// Each pen's starting width.
const DEFAULT_BRUSH_WIDTHS: Record<PenBrush, number> = {
	pen: DEFAULT_WIDTH,
	sharp: DEFAULT_WIDTH,
};
