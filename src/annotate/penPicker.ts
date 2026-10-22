import { setTooltip } from 'obsidian';
import { setIconOrText } from '../icon';
import type { AnnotationController } from './controller';
import { drawInk } from './render';
import { prepareStroke } from './stroke';
import { defaultStyleFor, PEN_BRUSHES, type PenBrush, type Point } from './types';

// What each nib is called, and the icon it shows — on its row in the picker
// and on the pen's own button while it is the nib in hand, so the strip
// says which pen you are holding.
export const PEN_BRUSH_INFO: Record<PenBrush, { label: string; icon: string; fallback: string }> = {
	pen: { label: 'Round pen', icon: 'pencil', fallback: '✏️' },
	sharp: { label: 'Sharp pen', icon: 'pen-tool', fallback: '✒️' },
};

// The preview each row draws: a wave across the row, pressing harder in the
// middle of each swing, so the difference the pressure switch makes shows
// before the pen is used.
const PREVIEW_WIDTH = 96;
const PREVIEW_HEIGHT = 28;

function previewPoints(pressure: boolean): Point[] {
	const points: Point[] = [];
	const steps = 48;
	for (let step = 0; step <= steps; step++) {
		const t = step / steps;
		const point: Point = {
			x: 8 + t * (PREVIEW_WIDTH - 16),
			y: PREVIEW_HEIGHT / 2 + Math.sin(t * Math.PI * 2.2) * (PREVIEW_HEIGHT / 2 - 7),
		};
		if (pressure) point.p = 0.15 + 0.85 * Math.abs(Math.sin(t * Math.PI * 2.2));
		points.push(point);
	}
	return points;
}

function drawPreview(canvas: HTMLCanvasElement, brush: PenBrush, color: string, width: number, pressure: boolean): void {
	const density = window.devicePixelRatio || 1;
	canvas.width = PREVIEW_WIDTH * density;
	canvas.height = PREVIEW_HEIGHT * density;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.setTransform(density, 0, 0, density, 0, 0);
	ctx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
	// The pen's width, kept inside the row.
	const shown = Math.min(Math.max(width, 1.5), 8);
	drawInk(ctx, [
		{
			id: 'preview',
			kind: 'stroke',
			tool: 'pen',
			color,
			width: shown,
			points: prepareStroke(previewPoints(pressure), brush),
			...(brush !== 'pen' ? { brush } : {}),
		},
	]);
}

// Opens the pen picker under the pen's button: one row per pen, each with
// a sample of its line and its own switch for pressure. Pressing a row
// picks that pen up and closes the picker; the switch only changes the pen
// it sits on, and leaves the picker open to see the sample change. Returns
// a function that closes it again, which the caller also gets told about
// through `onClose` whichever way it closes — a choice, a press elsewhere,
// Escape, a scroll.
//
// Attached to the document's body and placed by the button's position on
// screen, rather than inside the tool strip: an ink block's strip sits in a
// note column that clips what overflows it, and the picker has to hang
// below the strip over the block.
export function openPenPicker(anchor: HTMLElement, controller: AnnotationController, onClose: () => void): () => void {
	const doc = anchor.ownerDocument;
	const picker = doc.body.createDiv({ cls: 'inkling-pen-picker' });
	picker.setAttribute('role', 'dialog');
	picker.setAttribute('aria-label', 'Pen');

	const current = controller.getBrush();
	const color = controller.getColor();
	const rows: HTMLElement[] = [];
	for (const brush of PEN_BRUSHES) {
		const info = PEN_BRUSH_INFO[brush];
		const row = picker.createDiv({ cls: 'inkling-pen-option' });
		row.toggleClass('is-active', brush === current);

		const choose = row.createEl('button', { cls: 'inkling-pen-option-choose' });
		choose.type = 'button';
		choose.setAttribute('aria-pressed', String(brush === current));
		setTooltip(choose, info.label);
		const icon = choose.createSpan({ cls: 'inkling-pen-option-icon' });
		setIconOrText(icon, info.icon, info.fallback);
		choose.createSpan({ cls: 'inkling-pen-option-label', text: info.label });
		const preview = choose.createEl('canvas', { cls: 'inkling-pen-option-preview' });
		preview.setAttribute('aria-hidden', 'true');
		// The pen in hand at the width it is set to; the other at its own
		// starting width.
		const width = brush === current ? controller.getWidth() : defaultStyleFor('pen', brush).width;
		const redraw = () => drawPreview(preview, brush, color, width, controller.getPressure(brush));
		redraw();
		choose.addEventListener('click', () => {
			controller.setBrush(brush);
			close();
		});

		// A switch, not a checkbox: it acts the moment it is pressed, the way
		// Obsidian's own settings toggles do.
		const toggle = row.createEl('button', { cls: 'inkling-pen-pressure' });
		toggle.type = 'button';
		toggle.setAttribute('role', 'switch');
		toggle.createSpan({ cls: 'inkling-pen-pressure-label', text: 'Pressure' });
		toggle.createSpan({ cls: 'inkling-pen-pressure-track' }).createSpan({ cls: 'inkling-pen-pressure-thumb' });
		const showPressure = () => {
			const on = controller.getPressure(brush);
			toggle.setAttribute('aria-checked', String(on));
			toggle.toggleClass('is-on', on);
			setTooltip(toggle, `${info.label}: ${on ? 'press harder for a thicker line' : 'one width, however hard you press'}`);
		};
		showPressure();
		toggle.addEventListener('click', () => {
			controller.setPressure(brush, !controller.getPressure(brush));
			showPressure();
			redraw();
		});
		rows.push(row);
	}

	// Below the button, its left edge under the button's, and pulled back
	// inside the window when that would hang off the right — a pen at the
	// end of a phone's strip.
	const rect = anchor.getBoundingClientRect();
	const win = doc.defaultView;
	const viewWidth = win?.innerWidth ?? Infinity;
	const left = Math.max(8, Math.min(rect.left, viewWidth - picker.offsetWidth - 8));
	picker.setCssProps({ '--inkling-picker-left': `${left}px`, '--inkling-picker-top': `${rect.bottom + 6}px` });

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		doc.removeEventListener('pointerdown', onPointerDown, true);
		doc.removeEventListener('keydown', onKeyDown, true);
		win?.removeEventListener('scroll', onScroll, true);
		win?.removeEventListener('resize', close);
		picker.remove();
		onClose();
	};
	// Anywhere but the picker, and but the pen's own button, whose click
	// toggles it and would otherwise reopen what this just closed.
	const onPointerDown = (event: PointerEvent) => {
		const target = event.target as Node | null;
		if (target && (picker.contains(target) || anchor.contains(target))) return;
		close();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		close();
		anchor.focus();
	};
	// The picker is fixed in the window; the button it hangs from scrolls.
	const onScroll = (event: Event) => {
		if (event.target instanceof Node && picker.contains(event.target)) return;
		close();
	};
	doc.addEventListener('pointerdown', onPointerDown, true);
	doc.addEventListener('keydown', onKeyDown, true);
	win?.addEventListener('scroll', onScroll, true);
	win?.addEventListener('resize', close);

	const active = rows.find((row) => row.classList.contains('is-active')) ?? rows[0];
	active?.querySelector<HTMLButtonElement>('.inkling-pen-option-choose')?.focus();
	return close;
}
