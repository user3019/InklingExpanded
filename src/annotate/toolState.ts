import { defaultToolbarLayout, normalizeToolbarLayout, toolbarLayoutsEqual, type ToolbarLayout } from './toolbarLayout';
import { DEFAULT_COLOR, DEFAULT_WIDTH, MAX_WIDTH, MIN_WIDTH, ToolType, defaultStyleFor, isPenBrush, type PenBrush } from './types';

export interface ToolStyle {
	color: string;
	width: number;
}

// Which half of the state moved. Listeners need to tell them apart: a
// controller drops any in-flight drag and clears a selection the new tool
// can't act on when the *tool* changes, but must leave that selection alone
// on a *style* change — recoloring a selection is exactly what the color
// swatches do while something is selected.
// 'chrome' is neither: it is how the strip looks, not what the pen
// does. Listeners that only care about the pen (the controller drops
// an in-flight drag on a tool change) must not react to it.
// 'layout' is the strip's arrangement, told apart from 'chrome' because
// it is the one change that has to be written back to the device.
export type ToolStateChange = 'tool' | 'style' | 'chrome' | 'layout';

// Every tool there is, for reading a stored one back.
const TOOLS: readonly ToolType[] = ['select', 'pen', 'highlighter', 'eraser', 'note', 'line', 'rectangle', 'oval', 'arrow'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

// The pen as the user left it — which tool is in hand, and the colour and
// width each tool was last used at — in a form that can be stored and read
// back. See snapshot and restore.
export interface ToolStateSnapshot {
	tool: ToolType;
	chosen: boolean;
	brush: PenBrush;
	pressure: Record<PenBrush, boolean>;
	touchDrawing: boolean;
	// Keyed by tool, and for the pen by nib as well (see styleKey).
	styles: Record<string, ToolStyle>;
}

// Where a tool's colour and width are kept. Each nib of the pen has its own,
// the way Samsung Notes keeps a fine black ballpoint and a broad blue brush
// pen side by side: switching nib switches to that nib's last settings
// rather than dragging the previous nib's along. The plain pen keeps the
// key it always had, so a pen set up before nibs existed is still that pen.
function styleKey(tool: ToolType, brush: PenBrush): string {
	return tool === 'pen' && brush !== 'pen' ? `pen:${brush}` : tool;
}

function isStyleKey(key: string): boolean {
	if (key.startsWith('pen:')) {
		const brush = key.slice('pen:'.length);
		return isPenBrush(brush) && brush !== 'pen';
	}
	return (TOOLS as readonly string[]).includes(key) && key !== 'select';
}

function readStyle(value: unknown): ToolStyle | null {
	if (typeof value !== 'object' || value === null) return null;
	const { color, width } = value as { color?: unknown; width?: unknown };
	if (typeof color !== 'string' || !HEX_COLOR.test(color)) return null;
	if (typeof width !== 'number' || !Number.isFinite(width)) return null;
	return { color: color.toLowerCase(), width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width)) };
}

// The selected tool and its color/width, held *outside* any one controller.
//
// This exists because a Markdown ink block's controller does not survive the
// user drawing in it. Saving a block rewrites its own fenced source, which
// makes Obsidian re-render that section, which unloads the render child and
// builds a fresh InkBlockView — so anything the user had set on the old
// controller (pen 8px, red) died with it about a second after they finished
// a stroke, and the next stroke came out at the defaults. Keeping tool
// state here, owned by the plugin and handed to every controller, means a
// re-render rebuilds the surface without disturbing the choices made about
// what to draw with.
//
// Sharing it across surfaces is deliberate rather than merely convenient:
// picking red 8px in one ink block and finding the pen black 3px again in
// the next block down (or in a PDF) is the same "it forgot" complaint one
// scope up. Every drawing app treats the pen as one pen.
export class ToolState {
	private tool: ToolType = 'select';
	// Whether `tool` reflects a choice the user actually made, as opposed to
	// the starting default. See suggestTool.
	private toolChosen = false;
	private color: string = DEFAULT_COLOR;
	private width: number = DEFAULT_WIDTH;
	// Color/width are remembered per tool (pen, highlighter, eraser, each
	// shape) rather than as one global pair — otherwise picking a color/size
	// for the highlighter and then switching to the pen would carry the
	// highlighter's values over, which reads as the pen "forgetting" its own
	// last-used settings. 'select' has no style of its own; it just reflects
	// whatever the most recently used styled tool left behind.
	private readonly styles = new Map<string, ToolStyle>();
	// Which pen is in hand. See PenBrush.
	private brush: PenBrush = 'pen';
	// Whether each pen varies its width with how hard it is pressed. The
	// round pen starts without — a line that stays one width whatever the
	// hand does — and the sharp pen with; either can be switched in the pen
	// picker.
	private readonly pressure: Record<PenBrush, boolean> = { pen: false, sharp: true };
	// Whether a finger draws rather than scrolls. Off, which is palm
	// rejection: the pen draws and the hand moves the page. On for a stylus
	// that reports itself as a finger — passive styluses, and some Android
	// tablets' own — and for drawing on a phone with no stylus at all.
	private touchDrawing = false;
	// Whether the tool strip is collapsed to a single row. Lives here
	// rather than in a toolbar, for the same reason the pen does: an ink
	// block's toolbar is destroyed and rebuilt on every save, so a strip
	// collapsed to get it out of the way would spring back open a second
	// after every burst of handwriting.
	private toolbarCollapsed = false;
	// Which controls the strip shows, and in what order. Here for the same
	// reason again, and because two surfaces open side by side should not
	// show two different strips. See annotate/toolbarLayout.ts.
	private toolbarLayout: ToolbarLayout = defaultToolbarLayout();
	private readonly listeners = new Set<(change: ToolStateChange) => void>();

	getTool(): ToolType {
		return this.tool;
	}

	setTool(tool: ToolType): void {
		this.toolChosen = true;
		if (tool === this.tool) return;
		this.tool = tool;
		if (tool !== 'select') {
			const style = this.styleFor(tool);
			this.color = style.color;
			this.width = style.width;
		}
		this.notify('tool');
	}

	// A surface's preferred starting tool, applied only while the user has
	// not picked one themselves. Ink blocks want to open ready to write
	// rather than in select mode — a block you added specifically to
	// handwrite into where a stylus does nothing is just broken-feeling —
	// but that preference must not keep reasserting itself: a block
	// re-renders on every save, and hard-setting the tool there would drag
	// the user out of the lasso every time they deleted a selection.
	suggestTool(tool: ToolType): void {
		if (this.toolChosen) return;
		this.setTool(tool);
		this.toolChosen = false;
	}

	getColor(): string {
		return this.color;
	}

	setColor(color: string): void {
		if (color === this.color) return;
		this.color = color;
		if (this.tool !== 'select') this.styles.set(styleKey(this.tool, this.brush), { ...this.styleFor(this.tool), color });
		this.notify('style');
	}

	getWidth(): number {
		return this.width;
	}

	setWidth(width: number): void {
		const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
		if (clamped === this.width) return;
		this.width = clamped;
		if (this.tool !== 'select') this.styles.set(styleKey(this.tool, this.brush), { ...this.styleFor(this.tool), width: clamped });
		this.notify('style');
	}

	isToolbarCollapsed(): boolean {
		return this.toolbarCollapsed;
	}

	setToolbarCollapsed(collapsed: boolean): void {
		if (collapsed === this.toolbarCollapsed) return;
		this.toolbarCollapsed = collapsed;
		this.notify('chrome');
	}

	snapshot(): ToolStateSnapshot {
		const styles: Record<string, ToolStyle> = {};
		for (const [key, style] of this.styles) styles[key] = { ...style };
		return { tool: this.tool, chosen: this.toolChosen, brush: this.brush, pressure: { ...this.pressure }, touchDrawing: this.touchDrawing, styles };
	}

	// Puts back a snapshot read from storage. Whatever is stored was written
	// by some version of this plugin, or edited by hand, so every part is
	// checked, and a part that does not check out is left at its default
	// rather than taking the rest of the snapshot down with it.
	restore(raw: unknown): void {
		if (typeof raw !== 'object' || raw === null) return;
		const stored = raw as { tool?: unknown; chosen?: unknown; brush?: unknown; pressure?: unknown; styles?: unknown };

		if (typeof stored.pressure === 'object' && stored.pressure !== null) {
			for (const [brush, on] of Object.entries(stored.pressure)) {
				if (isPenBrush(brush) && typeof on === 'boolean') this.pressure[brush] = on;
			}
		}

		this.styles.clear();
		if (typeof stored.styles === 'object' && stored.styles !== null) {
			for (const [key, value] of Object.entries(stored.styles)) {
				const style = readStyle(value);
				if (style && isStyleKey(key)) this.styles.set(key, style);
			}
		}
		this.brush = isPenBrush(stored.brush) ? stored.brush : 'pen';
		this.touchDrawing = (raw as { touchDrawing?: unknown }).touchDrawing === true;

		const tool = (TOOLS as readonly string[]).includes(stored.tool as string) ? (stored.tool as ToolType) : this.tool;
		this.tool = tool;
		// Kept as it was: a pen the user picked last time is a pen they
		// picked, and an ink block must not swap it for its own preference.
		this.toolChosen = stored.chosen === true;
		if (tool !== 'select') {
			const style = this.styleFor(tool);
			this.color = style.color;
			this.width = style.width;
		}
		this.notify('tool');
	}

	// A tool's own colour and width, whichever tool is in hand — for a
	// stroke drawn with a stylus button held, which borrows another tool for
	// just that stroke.
	styleOf(tool: ToolType): ToolStyle {
		return { ...this.styleFor(tool) };
	}

	isTouchDrawing(): boolean {
		return this.touchDrawing;
	}

	setTouchDrawing(on: boolean): void {
		if (on === this.touchDrawing) return;
		this.touchDrawing = on;
		this.notify('style');
	}

	getToolbarLayout(): ToolbarLayout {
		return this.toolbarLayout;
	}

	setToolbarLayout(layout: ToolbarLayout): void {
		const normalized = normalizeToolbarLayout(layout);
		if (toolbarLayoutsEqual(normalized, this.toolbarLayout)) return;
		this.toolbarLayout = normalized;
		this.notify('layout');
	}

	// The tool's own default until the user overrides it, not one shared
	// pair: a highlighter that starts on the pen's fine black nib draws a
	// hairline smear the first time it is picked up, which is not a
	// highlighter at all. See defaultStyleFor.
	private styleFor(tool: ToolType): ToolStyle {
		return this.styles.get(styleKey(tool, this.brush)) ?? defaultStyleFor(tool, this.brush);
	}

	getBrush(): PenBrush {
		return this.brush;
	}

	getPressure(brush: PenBrush = this.brush): boolean {
		return this.pressure[brush];
	}

	// 'style', like a colour or a width: it changes what the next stroke
	// looks like, not which tool is in hand.
	setPressure(brush: PenBrush, on: boolean): void {
		if (this.pressure[brush] === on) return;
		this.pressure[brush] = on;
		this.notify('style');
	}

	// Picks a nib, and puts the pen in hand with it: choosing a fountain pen
	// is choosing to write with one. The colour and width become that
	// nib's own.
	setBrush(brush: PenBrush): void {
		const changed = brush !== this.brush || this.tool !== 'pen';
		this.brush = brush;
		this.toolChosen = true;
		this.tool = 'pen';
		const style = this.styleFor('pen');
		this.color = style.color;
		this.width = style.width;
		if (changed) this.notify('tool');
	}

	// Lets every live controller repaint its toolbar when the state changes
	// under it — two ink blocks in one note, or a note beside a PDF, are
	// separate controllers over this one selection, and a strip still
	// showing the old width would be lying about what the next stroke does.
	subscribe(listener: (change: ToolStateChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(change: ToolStateChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
