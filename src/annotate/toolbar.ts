import { App, setTooltip } from 'obsidian';
import { setIconOrText } from '../icon';
import { AnnotationController } from './controller';
import { toolbarItemSpec, type ToolbarItemId, type ToolbarLayout } from './toolbarLayout';
import { ToolbarLayoutModal } from './toolbarLayoutModal';
import { openPenPicker, PEN_BRUSH_INFO } from './penPicker';
import { MAX_WIDTH, MIN_WIDTH, ToolType, paletteFor } from './types';

// One press of the toolbar's zoom buttons. A ratio rather than a step, for
// the same reason the wheel uses one: the same press should cover the same
// proportion of the range wherever it starts from.
const ZOOM_STEP = 1.25;
// A pinch rarely lands on exactly 100% or exactly a limit.
const ZOOM_EPSILON = 0.005;

// Lucide icon names (Obsidian ships the set, and setIcon resolves them), so
// the strip reads as part of the app instead of the emoji/box-drawing mix it
// used to be — those rendered at a different weight and baseline from every
// other control in Obsidian, and at wildly different sizes across platforms
// (an emoji pencil is a full-color glyph on Windows and a thin monochrome
// one on Linux). `fallback` is the old glyph, used only if setIcon draws
// nothing: an icon renamed out from under an older Obsidian (the manifest
// still admits releases back to 1.4.4) should leave a button that's merely
// plain, never blank.
interface ButtonSpec {
	icon: string;
	fallback: string;
	title: string;
}

const TOOLS: readonly ToolType[] = ['select', 'pen', 'highlighter', 'eraser', 'note', 'line', 'rectangle', 'oval', 'arrow'];

// The button for one of the strip's items, from the one table that names
// them (see toolbarLayout.ts), so the strip and its layout editor cannot
// drift apart on what an item is called or which icon it shows.
function itemButton(className: string, id: ToolbarItemId, onClick: () => void): HTMLButtonElement {
	const spec = toolbarItemSpec(id);
	return iconButton(className, { icon: spec.icon, fallback: spec.fallback, title: spec.label }, onClick);
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	// Obsidian's own createEl rather than document.createElement, per its
	// plugin guidelines. Detached on purpose — callers append these
	// themselves, so this can't build straight into a parent.
	return createEl(tag, { cls: className, text });
}

// An icon button with a real tooltip and an accessible name. The tooltip is
// Obsidian's own (setTooltip) rather than the browser's `title=`, so it
// matches the styling and timing of every other control in the app.
//
// `clickable-icon` is Obsidian's own class for exactly this kind of button
// (its view-header actions and ribbon are built from it), and carrying it
// here is what makes the strip look native under any theme rather than only
// the default one: measured in the running app, a bare <button> in this
// vault's theme came out with a raised grey fill and a four-layer drop
// shadow, so thirteen of them in a row read as a cluttered bank of chunky
// keys instead of a tool strip. Themes style `clickable-icon` flat and
// muted, and adjust it for their own metrics — much better than fighting
// each one with overrides here.
function iconButton(className: string, spec: ButtonSpec, onClick: () => void): HTMLButtonElement {
	const button = el('button', `clickable-icon ${className}`);
	button.type = 'button';
	setIconOrText(button, spec.icon, spec.fallback);
	setTooltip(button, spec.title);
	button.setAttribute('aria-label', spec.title);
	button.addEventListener('click', onClick);
	return button;
}

function separator(): HTMLElement {
	const sep = el('div', 'inkling-toolbar-sep');
	// Decoration, not structure — a screen reader announcing "separator"
	// between every group would just be noise over a row of eight buttons.
	sep.setAttribute('aria-hidden', 'true');
	return sep;
}

export interface ToolbarOptions {
	// Offers the button that opens the layout editor. Left out, the strip
	// has no editor to open — which is how the tests build it.
	app?: App;
}

// A full-width top toolbar for the shared annotation tool module — the
// Xodo/Samsung-Notes-style horizontal strip the user asked for, rather than
// a small draggable floating palette. Fronts the same controller in both the
// PDF view and Markdown ink blocks, which is why it takes a host element
// rather than reaching into either one's DOM itself.
//
// Every item is built once, up front, and the layout only decides which of
// them are attached to the strip and in what order — so rearranging it
// rewires nothing, and refresh() can keep every control current whether it
// is on show or not.
export function buildToolbar(host: HTMLElement, controller: AnnotationController, options: ToolbarOptions = {}): () => void {
	const toolbar = el('div', 'inkling-toolbar');

	const bar = el('div', 'inkling-toolbar-bar');
	const items = new Map<ToolbarItemId, HTMLElement>();

	// Pressed buttons rather than a radio group: the tools can be arranged
	// anywhere along the strip, with other controls between them, and a
	// radio group has to be one contiguous container.
	const toolButtons = new Map<ToolType, HTMLButtonElement>();
	// The nib picker, while it is open. The pen's button opens it the way
	// Samsung Notes does: the first press picks the pen up, a press on the
	// pen already in hand opens its settings — so switching back to the pen
	// from the eraser is still one tap and never pops anything up.
	let closePenPicker: (() => void) | null = null;
	const onPenPressed = (button: HTMLButtonElement) => {
		if (closePenPicker) {
			closePenPicker();
			return;
		}
		if (controller.getTool() !== 'pen') {
			controller.setTool('pen');
			return;
		}
		button.setAttribute('aria-expanded', 'true');
		closePenPicker = openPenPicker(button, controller, () => {
			closePenPicker = null;
			button.setAttribute('aria-expanded', 'false');
		});
	};
	for (const tool of TOOLS) {
		const button: HTMLButtonElement = itemButton('inkling-tool-button', tool, () =>
			tool === 'pen' ? onPenPressed(button) : controller.setTool(tool),
		);
		toolButtons.set(tool, button);
		items.set(tool, button);
	}
	// Draw with a finger. Offered only where there is a touch screen to draw
	// on: a desktop with a mouse would have a button that does nothing.
	const touchScreen = (host.ownerDocument.defaultView?.navigator.maxTouchPoints ?? 0) > 0;
	const touchDrawButton = itemButton('inkling-tool-button', 'touch-draw', () =>
		controller.setTouchDrawing(!controller.isTouchDrawing()),
	);
	if (touchScreen) items.set('touch-draw', touchDrawButton);

	const penButton = toolButtons.get('pen');
	penButton?.setAttribute('aria-haspopup', 'dialog');
	penButton?.setAttribute('aria-expanded', 'false');
	// The nib the pen button is showing, so its icon is only redrawn when
	// that changes rather than on every stroke.
	let shownBrush: string | null = null;

	const colorGroup = el('div', 'inkling-toolbar-group inkling-color-group');
	colorGroup.setAttribute('aria-label', 'Color');

	// A fixed row of swatch buttons whose *colours* are repointed at the
	// active tool's palette on every refresh, rather than a row rebuilt from
	// scratch when the tool changes. A pen and a highlighter want genuinely
	// different colours — saturated inks to mark over the page, pale tints to
	// colour the paper under it — but they want the same six positions, so
	// that "the second swatch" and the 2 key mean the same place in the strip
	// whichever tool is in hand.
	//
	// Every palette is the same length, which is what makes one row of
	// buttons enough; the assertion is worth keeping honest because a shorter
	// one would silently leave a stale swatch at the end of the strip.
	const swatchCount = Math.max(paletteFor('pen').length, paletteFor('highlighter').length);
	const colorSwatches: HTMLButtonElement[] = [];
	for (let index = 0; index < swatchCount; index++) {
		const swatch = el('button', 'clickable-icon inkling-color-swatch');
		swatch.type = 'button';
		// Reads the palette at click time rather than closing over a colour,
		// so a button always applies whatever it is currently showing.
		swatch.addEventListener('click', () => {
			const color = paletteFor(controller.getTool())[index];
			if (color) controller.setColor(color.value);
		});
		colorSwatches.push(swatch);
		colorGroup.appendChild(swatch);
	}
	const customColor = el('input', 'inkling-color-custom');
	customColor.type = 'color';
	setTooltip(customColor, 'Custom color');
	customColor.setAttribute('aria-label', 'Custom color');
	customColor.addEventListener('input', () => controller.setColor(customColor.value));
	colorGroup.appendChild(customColor);
	items.set('colors', colorGroup);

	const widthGroup = el('div', 'inkling-toolbar-group inkling-width-group');
	// A dot drawn at the current stroke width in the current color. The
	// slider and the number say what the width *is*; this shows what it will
	// look like, which is the actual question being asked at the moment
	// someone reaches for this control.
	const widthPreview = el('div', 'inkling-width-preview');
	widthPreview.setAttribute('aria-hidden', 'true');
	const widthDot = el('div', 'inkling-width-dot');
	widthPreview.appendChild(widthDot);
	const widthSlider = el('input', 'inkling-width-slider');
	widthSlider.type = 'range';
	widthSlider.min = String(MIN_WIDTH);
	widthSlider.max = String(MAX_WIDTH);
	setTooltip(widthSlider, 'Stroke width');
	widthSlider.setAttribute('aria-label', 'Stroke width');
	const widthNumber = el('input', 'inkling-width-number');
	widthNumber.type = 'number';
	widthNumber.min = String(MIN_WIDTH);
	widthNumber.max = String(MAX_WIDTH);
	widthNumber.setAttribute('aria-label', 'Stroke width');
	const setWidthFromInput = (value: string) => {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) return;
		controller.setWidth(parsed);
	};
	widthSlider.addEventListener('input', () => setWidthFromInput(widthSlider.value));
	widthNumber.addEventListener('change', () => setWidthFromInput(widthNumber.value));
	widthGroup.append(widthPreview, widthSlider, widthNumber);
	items.set('width', widthGroup);

	// Icons, where these used to be text ("Undo", "Redo", "Delete", "Clear
	// page", "Add page"). That row was wider than a phone screen on its own —
	// see .inkling-toolbar-group in styles.css for the wrapping that had to
	// be added to stop it running off-screen — and it's the same five verbs
	// every drawing app labels with icons anyway.
	const undoButton = itemButton('inkling-tool-button', 'undo', () => controller.undo());
	const redoButton = itemButton('inkling-tool-button', 'redo', () => controller.redo());
	const deleteButton = itemButton('inkling-tool-button', 'delete', () => controller.deleteSelection());
	const clearPageButton = itemButton('inkling-tool-button', 'clear-page', () => controller.clearCurrentPage());
	// Only meaningful for plugin-created handwritten notes — hidden for
	// imported PDFs (books, papers, ...) via the refresh() below, since
	// there's no notion of "add a blank/lined/dot-grid page" to a book.
	const addPageButton = itemButton('inkling-tool-button', 'add-page', () => controller.addPage());
	// The page's ruling, changed after the fact. A note's, like Add page.
	const backgroundButton: HTMLButtonElement = itemButton('inkling-tool-button', 'background', () => controller.openBackground(backgroundButton));
	// PDF pages and pictures, into a PDF. Only where the host offers it.
	const importButton: HTMLButtonElement = itemButton('inkling-tool-button', 'import', () => controller.openImport(importButton));
	// Darkens the page under the ink. A reading action like zoom, so it
	// stays available on a document that cannot be written to.
	const invertButton = itemButton('inkling-tool-button', 'invert', () => controller.toggleInversion());
	// Opens the outline and find panel. Like zoom, a reading action, so it
	// stays enabled when the document is read-only.
	const navButton = itemButton('inkling-tool-button', 'outline', () => controller.toggleNavigation());
	items.set('undo', undoButton);
	items.set('redo', redoButton);
	items.set('delete', deleteButton);
	items.set('clear-page', clearPageButton);
	items.set('add-page', addPageButton);
	items.set('background', backgroundButton);
	items.set('import', importButton);
	items.set('invert', invertButton);
	items.set('outline', navButton);

	const separators: HTMLElement[] = [];
	for (const id of ['separator-1', 'separator-2', 'separator-3', 'separator-4'] as const) {
		const sep = separator();
		separators.push(sep);
		items.set(id, sep);
	}

	// Takes up whatever room is left on its line, which pushes the items
	// after it to the far end of the strip. By default those are the
	// readouts, so the things you press stay together on the left instead
	// of being pulled apart by text that changes width as you scroll or zoom.
	const spacer = el('div', 'inkling-toolbar-spacer');
	spacer.setAttribute('aria-hidden', 'true');
	items.set('spacer', spacer);

	const pageGroup = el('div', 'inkling-toolbar-group inkling-toolbar-status');
	const zoomGroup = el('div', 'inkling-toolbar-group inkling-toolbar-status');
	// A number input rather than a readout: on a 900-page book, "jump to
	// page 412" is the single most-used navigation there is, and losing it
	// on the way into annotate mode is most of why marking up a textbook
	// used to mean losing your place.
	const pageBox = el('input', 'inkling-page-box');
	pageBox.type = 'number';
	pageBox.min = '1';
	setTooltip(pageBox, 'Go to page');
	pageBox.setAttribute('aria-label', 'Go to page');
	const goToTypedPage = () => {
		const parsed = Number(pageBox.value);
		if (Number.isFinite(parsed)) controller.goToPage(parsed);
	};
	pageBox.addEventListener('change', goToTypedPage);
	pageBox.addEventListener('keydown', (event: KeyboardEvent) => {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		goToTypedPage();
	});
	const pageLabel = el('span', 'inkling-status-label');
	setTooltip(pageLabel, 'Page count');
	// Only meaningful once a page is actually pinch-zoomed (see pointer.ts) —
	// hidden at 100% by the refresh() below rather than sitting there as
	// permanent "100%" clutter.
	// Zoom is a *reading* action, not an edit, so these stay enabled in
	// read-only mode. Deliberate — do not "fix" it by adding them to the
	// disabled sweep in refresh().
	const zoomOutButton = iconButton('inkling-tool-button', { icon: 'zoom-out', fallback: '−', title: 'Zoom out' }, () =>
		controller.zoomBy(1 / ZOOM_STEP),
	);
	const zoomInButton = iconButton('inkling-tool-button', { icon: 'zoom-in', fallback: '+', title: 'Zoom in' }, () =>
		controller.zoomBy(ZOOM_STEP),
	);
	// A button, not a label: it reads out the zoom and resets it, and
	// something you can click should be something you can tab to.
	const zoomLabel = el('button', 'inkling-status-label inkling-status-button');
	zoomLabel.type = 'button';
	setTooltip(zoomLabel, 'Reset zoom');
	zoomLabel.setAttribute('aria-label', 'Reset zoom');
	zoomLabel.addEventListener('click', () => controller.resetZoom());
	pageGroup.append(pageBox, pageLabel);
	zoomGroup.append(zoomOutButton, zoomLabel, zoomInButton);
	items.set('page', pageGroup);
	items.set('zoom', zoomGroup);

	// Opens the layout editor. Not an item of the layout itself, and kept
	// beside the collapse button at the very end: a control that could be
	// hidden by the layout would be a way to lose the only way back.
	const app = options.app;
	const layoutButton = app
		? iconButton('inkling-tool-button inkling-layout-button', { icon: 'sliders-horizontal', fallback: '⚙', title: 'Customize toolbar' }, () =>
				new ToolbarLayoutModal(app, controller.getToolbarLayout(), (layout) => controller.setToolbarLayout(layout)).open(),
			)
		: null;

	// Collapses the strip to the active tool, undo, and this button. On a
	// phone in portrait the full row is a real slice of the screen, and
	// the page you are trying to write on is underneath it.
	const collapseButton = iconButton(
		'inkling-tool-button inkling-collapse-button',
		{ icon: 'chevrons-up', fallback: '⌃', title: 'Collapse tools' },
		() => controller.setToolbarCollapsed(!controller.isToolbarCollapsed()),
	);

	toolbar.append(bar);
	host.appendChild(toolbar);

	// Attaches the items the layout shows, in its order, and detaches the
	// rest. Only when the layout has actually changed: refresh() runs on
	// every stroke, and moving elements around under a page number being
	// typed would take the focus out of it.
	let appliedLayout: ToolbarLayout | null = null;
	const applyLayout = () => {
		const layout = controller.getToolbarLayout();
		if (layout === appliedLayout) return;
		appliedLayout = layout;
		const shown: HTMLElement[] = [];
		for (const id of layout.order) {
			const item = items.get(id);
			if (item && !layout.hidden.includes(id)) shown.push(item);
		}
		if (layoutButton) shown.push(layoutButton);
		shown.push(collapseButton);
		bar.replaceChildren(...shown);
	};

	const refresh = () => {
		applyLayout();
		const activeTool = controller.getTool();

		const brush = controller.getBrush();
		if (penButton && brush !== shownBrush) {
			shownBrush = brush;
			const info = PEN_BRUSH_INFO[brush];
			penButton.empty();
			setIconOrText(penButton, info.icon, info.fallback);
			setTooltip(penButton, `${info.label} — press again for pen types`);
		}

		// Hidden, not removed: the strip is rebuilt per file already, and
		// churning its DOM on a toggle would drop focus and lose a
		// half-typed page number out of the jump box.
		const collapsed = controller.isToolbarCollapsed();
		toolbar.toggleClass('is-collapsed', collapsed);
		for (const [tool, button] of toolButtons) button.hidden = collapsed && tool !== activeTool;
		// A surface with no note editor has no note tool. Ink blocks are
		// that surface: they supply no onEditNote, so the button would
		// place notes nobody could ever type into.
		const noteButton = toolButtons.get('note');
		if (noteButton && !controller.canTakeNotes()) noteButton.hidden = true;
		for (const group of [colorGroup, widthGroup, pageGroup, zoomGroup, spacer, ...separators]) group.hidden = collapsed;
		for (const button of [redoButton, deleteButton, clearPageButton, addPageButton, backgroundButton, importButton, invertButton, navButton, touchDrawButton]) {
			button.hidden = collapsed;
		}
		const touchDrawing = controller.isTouchDrawing();
		touchDrawButton.toggleClass('is-active', touchDrawing);
		touchDrawButton.setAttribute('aria-pressed', String(touchDrawing));
		if (layoutButton) layoutButton.hidden = collapsed;
		setIconOrText(collapseButton, collapsed ? 'chevrons-down' : 'chevrons-up', collapsed ? '⌄' : '⌃');
		setTooltip(collapseButton, collapsed ? 'Show tools' : 'Collapse tools');
		for (const [tool, button] of toolButtons) {
			const active = tool === activeTool;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-pressed', String(active));
		}

		const activeColor = controller.getColor();
		const palette = paletteFor(activeTool);
		colorSwatches.forEach((button, index) => {
			const preset = palette[index];
			// A palette shorter than the row: hide the surplus rather than
			// leave a swatch showing the previous tool's colour.
			button.hidden = !preset;
			if (!preset) return;

			// The one thing about a swatch that can't live in the stylesheet:
			// its color *is* the data.
			button.setCssProps({ '--inkling-swatch-color': preset.value });
			setTooltip(button, preset.label);
			button.setAttribute('aria-label', preset.label);

			const active = preset.value === activeColor;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-pressed', String(active));
		});
		customColor.value = activeColor;

		const width = controller.getWidth();
		widthSlider.value = String(width);
		widthNumber.value = String(width);
		// Capped well below MAX_WIDTH: a 40px dot would be taller than the
		// toolbar row itself. Past the cap the dot simply stops growing,
		// which is fine — by then the number beside it is doing the talking.
		widthDot.setCssProps({
			'--inkling-dot-size': `${Math.min(width, 16)}px`,
			'--inkling-dot-color': activeColor,
		});

		const zoom = controller.getZoom();
		const range = controller.getZoomRange();
		// Only meaningful once a page is actually zoomed — a permanent
		// "100%" is clutter. The buttons stay, since they are how a mouse
		// gets to a zoom in the first place.
		zoomLabel.hidden = Math.abs(zoom - 1) < ZOOM_EPSILON;
		zoomOutButton.disabled = zoom <= range.min + ZOOM_EPSILON;
		zoomInButton.disabled = zoom >= range.max - ZOOM_EPSILON;
		zoomLabel.setText(`${Math.round(zoom * 100)}%`);

		// Hidden for a single-page surface (every Markdown ink block, and a
		// one-page note), where "1 / 1" says nothing anyone needed to know.
		const pageCount = controller.getPageCount();
		const multiPage = pageCount > 1;
		pageLabel.hidden = !multiPage;
		pageBox.hidden = !multiPage || !controller.canNavigate();
		// The group too, not only what is in it: an empty group is still a
		// flex item, and would leave a gap's worth of nothing in the strip.
		if (!collapsed) pageGroup.hidden = !multiPage;
		pageBox.max = String(pageCount);
		pageLabel.setText(`/ ${pageCount}`);
		// Not while it is being typed into, or every keystroke would be
		// overwritten by the page the reader is still sitting on.
		if (document.activeElement !== pageBox) pageBox.value = String(controller.getCurrentPageNumber());

		// Disabled rather than hidden: the strip vanishing would read as a
		// bug, where a row of greyed-out tools reads as "not here", which is
		// what the banner above the pages then explains.
		const readOnly = controller.isReadOnly();
		for (const button of toolButtons.values()) button.disabled = readOnly;
		for (const button of colorSwatches) button.disabled = readOnly;
		customColor.disabled = readOnly;
		widthSlider.disabled = readOnly;
		widthNumber.disabled = readOnly;
		clearPageButton.disabled = readOnly;

		undoButton.disabled = readOnly || !controller.canUndo;
		redoButton.disabled = readOnly || !controller.canRedo;
		deleteButton.disabled = readOnly || !controller.hasSelection();
		// Reasserted after the collapse sweep above, which hid these for a
		// different reason. A control can be hidden because the strip is
		// collapsed *or* because it does not apply to this document, and
		// the second has to win whenever the strip is open.
		if (!collapsed) {
			addPageButton.hidden = !controller.getCanManagePages();
			backgroundButton.hidden = !controller.canChangeBackground();
			importButton.hidden = !controller.canImport();
			navButton.hidden = !controller.canToggleNavigation();
			invertButton.hidden = !controller.canInvert();
		}
		invertButton.toggleClass('is-active', controller.isInverted());
		addPageButton.disabled = readOnly;
		backgroundButton.disabled = readOnly;
		importButton.disabled = readOnly;
	};
	refresh();

	const unsubscribe = controller.subscribe(refresh);

	return () => {
		unsubscribe();
		closePenPicker?.();
		toolbar.remove();
	};
}
