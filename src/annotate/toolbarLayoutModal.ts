import { App, Modal, setTooltip } from 'obsidian';
import { setIconOrText } from '../icon';
import {
	defaultToolbarLayout,
	moveToolbarItem,
	setToolbarItemHidden,
	toolbarItemSpec,
	type ToolbarItemId,
	type ToolbarLayout,
} from './toolbarLayout';

// How close to the top or bottom edge of the scrolling list a dragged row
// has to be before the list scrolls under it, and how fast it goes. A
// phone shows a fraction of the twenty-odd rows at once, so without this
// an item could only be moved as far as the screen happened to reach.
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_SPEED = 12;

// Rearranges the tool strip: drag a row by its handle to move it, press the
// eye to leave it out. Nothing reaches the strip until Save.
//
// Dragging is done with pointer events rather than HTML drag and drop,
// which a touch screen does not deliver at all on Android or iOS — and a
// stylus plugin whose customisation only works with a mouse would be
// missing the point. The handle alone starts a drag (and alone sets
// `touch-action: none`), so a finger anywhere else on a row still scrolls
// the list the ordinary way.
export class ToolbarLayoutModal extends Modal {
	private layout: ToolbarLayout;
	private listEl: HTMLElement | null = null;
	private rows = new Map<ToolbarItemId, HTMLElement>();
	private drag: {
		id: ToolbarItemId;
		pointerId: number;
		handle: HTMLElement;
		row: HTMLElement;
		// Where the drag began: the pointer, and how far the list was
		// scrolled, so a list that scrolls under a held row moves the row too.
		startY: number;
		startScroll: number;
		lastY: number;
		// The row's place in the order when the drag began, the place it
		// would drop into now, and how far apart neighbouring rows are.
		from: number;
		to: number;
		step: number;
		frame: number | null;
	} | null = null;

	constructor(
		app: App,
		initial: ToolbarLayout,
		private readonly onSave: (layout: ToolbarLayout) => void,
	) {
		super(app);
		this.layout = { order: [...initial.order], hidden: [...initial.hidden] };
	}

	onOpen(): void {
		this.setTitle('Customize toolbar');
		this.modalEl.addClass('inkling-layout-modal');

		this.contentEl.createEl('p', {
			cls: 'inkling-layout-hint',
			text: 'Drag an item by its handle to move it (or focus the handle and use the arrow keys), and use the eye to show or hide it. The layout is saved on this device only.',
		});

		this.listEl = this.contentEl.createDiv({ cls: 'inkling-layout-list' });
		this.listEl.setAttribute('role', 'list');
		this.renderRows();

		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container inkling-layout-buttons' });
		const reset = buttons.createEl('button', { cls: 'inkling-layout-reset', text: 'Reset to default' });
		reset.type = 'button';
		reset.addEventListener('click', () => {
			this.layout = defaultToolbarLayout();
			this.renderRows();
		});
		const cancel = buttons.createEl('button', { cls: 'inkling-layout-cancel', text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const save = buttons.createEl('button', { cls: 'mod-cta inkling-layout-save', text: 'Save' });
		save.type = 'button';
		save.addEventListener('click', () => {
			this.onSave(this.layout);
			this.close();
		});
	}

	onClose(): void {
		this.endDrag();
		this.contentEl.empty();
		this.rows.clear();
		this.listEl = null;
	}

	private renderRows(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		this.rows.clear();
		for (const id of this.layout.order) {
			const row = this.buildRow(id);
			this.rows.set(id, row);
			list.appendChild(row);
		}
	}

	private buildRow(id: ToolbarItemId): HTMLElement {
		const spec = toolbarItemSpec(id);
		const row = createDiv({ cls: 'inkling-layout-row' });
		row.setAttribute('role', 'listitem');
		row.dataset.item = id;

		// The grip and the item's own icon together, so what you take hold
		// of is the symbol you are moving — a wider target than a grip alone,
		// which on a phone is the difference between a drag and a scroll.
		const handle = row.createEl('button', { cls: 'inkling-layout-handle' });
		handle.type = 'button';
		const grip = handle.createSpan({ cls: 'inkling-layout-grip' });
		setIconOrText(grip, 'grip-vertical', '⋮⋮');
		const icon = handle.createSpan({ cls: 'inkling-layout-icon' });
		setIconOrText(icon, spec.icon, spec.fallback);
		// Obsidian's tooltip is also the accessible name, so it says what the
		// handle does to which item; the arrow keys are in the hint above.
		setTooltip(handle, `Move ${spec.label}`);
		handle.addEventListener('pointerdown', (event) => this.startDrag(event, id, handle));
		handle.addEventListener('keydown', (event) => this.onHandleKey(event, id));

		row.createSpan({ cls: 'inkling-layout-label', text: spec.label });

		const visibility = row.createEl('button', { cls: 'clickable-icon inkling-layout-visibility' });
		visibility.type = 'button';
		visibility.addEventListener('click', () => {
			this.layout = setToolbarItemHidden(this.layout, id, !this.layout.hidden.includes(id));
			this.applyVisibility(row, visibility, id);
		});
		this.applyVisibility(row, visibility, id);
		return row;
	}

	private applyVisibility(row: HTMLElement, button: HTMLElement, id: ToolbarItemId): void {
		const hidden = this.layout.hidden.includes(id);
		row.toggleClass('is-hidden-item', hidden);
		button.empty();
		setIconOrText(button, hidden ? 'eye-off' : 'eye', hidden ? 'Hidden' : 'Shown');
		setTooltip(button, `${hidden ? 'Show' : 'Hide'} ${toolbarItemSpec(id).label}`);
	}

	// The keyboard path to the same move a drag makes: anything that can be
	// reordered with a pointer has to be reorderable without one.
	private onHandleKey(event: KeyboardEvent, id: ToolbarItemId): void {
		const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const index = this.layout.order.indexOf(id);
		this.moveTo(id, index + step);
		this.rows.get(id)?.querySelector<HTMLElement>('.inkling-layout-handle')?.focus();
	}

	private moveTo(id: ToolbarItemId, index: number): void {
		const next = moveToolbarItem(this.layout, id, index);
		if (next === this.layout) return;
		this.layout = next;
		// Reorders the existing rows rather than rebuilding them, so the row
		// being dragged keeps its pointer capture and its focus.
		const list = this.listEl;
		if (!list) return;
		for (const entry of this.layout.order) {
			const row = this.rows.get(entry);
			if (row) list.appendChild(row);
		}
	}

	// Dragging works the way a list on a phone does: the row lifts and follows
	// the pointer exactly, and the rows it passes slide aside to show where
	// it will land. Nothing is reordered until the pointer lifts. It used to
	// move the row in the list on every step, so it jumped from slot to slot
	// rather than following the finger, and the list reflowed under it.
	private startDrag(event: PointerEvent, id: ToolbarItemId, handle: HTMLElement): void {
		// Primary button only, and nothing for a second finger.
		if (event.button !== 0 || this.drag) return;
		const row = this.rows.get(id);
		const list = this.listEl;
		if (!row || !list) return;
		event.preventDefault();
		handle.setPointerCapture(event.pointerId);

		const from = this.layout.order.indexOf(id);
		const first = this.rows.get(this.layout.order[0] as ToolbarItemId);
		const second = this.rows.get(this.layout.order[1] as ToolbarItemId);
		const step = first && second ? second.offsetTop - first.offsetTop : row.offsetHeight;
		this.drag = {
			id,
			pointerId: event.pointerId,
			handle,
			row,
			startY: event.clientY,
			startScroll: list.scrollTop,
			lastY: event.clientY,
			from,
			to: from,
			step: step > 0 ? step : row.offsetHeight || 44,
			frame: null,
		};
		row.addClass('is-dragging');
		list.addClass('is-reordering');

		handle.addEventListener('pointermove', this.onDragMove);
		handle.addEventListener('pointerup', this.onDragEnd);
		handle.addEventListener('pointercancel', this.onDragCancel);
		handle.addEventListener('lostpointercapture', this.onDragCancel);
		this.scheduleAutoscroll();
	}

	private readonly onDragMove = (event: PointerEvent): void => {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId) return;
		event.preventDefault();
		drag.lastY = event.clientY;
		this.followPointer();
	};

	private readonly onDragEnd = (event: PointerEvent): void => {
		if (!this.drag || event.pointerId !== this.drag.pointerId) return;
		this.endDrag(true);
	};

	private readonly onDragCancel = (event: PointerEvent): void => {
		if (!this.drag || event.pointerId !== this.drag.pointerId) return;
		this.endDrag(false);
	};

	// Puts the held row under the pointer, works out where it would land,
	// and slides the rows between there and where it came from aside.
	private followPointer(): void {
		const drag = this.drag;
		const list = this.listEl;
		if (!drag || !list) return;
		const offset = drag.lastY - drag.startY + (list.scrollTop - drag.startScroll);
		const last = this.layout.order.length - 1;
		drag.to = Math.max(0, Math.min(last, Math.round(drag.from + offset / drag.step)));
		drag.row.setCssProps({ '--inkling-row-shift': `${offset}px` });

		this.layout.order.forEach((entry, index) => {
			if (entry === drag.id) return;
			let shift = 0;
			if (drag.from < index && index <= drag.to) shift = -drag.step;
			else if (drag.to <= index && index < drag.from) shift = drag.step;
			this.rows.get(entry)?.setCssProps({ '--inkling-row-shift': `${shift}px` });
		});
	}

	// Drops the row where it was heading, or, for a drag the browser took
	// over, back where it was.
	private endDrag(commit = false): void {
		const drag = this.drag;
		if (!drag) return;
		this.drag = null;
		if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
		drag.handle.removeEventListener('pointermove', this.onDragMove);
		drag.handle.removeEventListener('pointerup', this.onDragEnd);
		drag.handle.removeEventListener('pointercancel', this.onDragCancel);
		drag.handle.removeEventListener('lostpointercapture', this.onDragCancel);
		if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);

		// The slide is over: everything goes straight to its new place, not
		// animated back from where the shifts had it.
		this.listEl?.removeClass('is-reordering');
		drag.row.removeClass('is-dragging');
		for (const row of this.rows.values()) row.setCssProps({ '--inkling-row-shift': '0px' });
		if (commit && drag.to !== drag.from) this.moveTo(drag.id, drag.to);
	}

	// Runs once a frame for as long as a drag lasts, scrolling the list when
	// the pointer is held near its top or bottom. A pointer held still sends
	// no events, so this cannot wait for pointermove to do it. The list is
	// the only thing that scrolls in this dialog (see styles.css), on every
	// platform.
	private scheduleAutoscroll(): void {
		const drag = this.drag;
		if (!drag) return;
		drag.frame = window.requestAnimationFrame(() => {
			const current = this.drag;
			const list = this.listEl;
			if (!current || !list) return;
			const rect = list.getBoundingClientRect();
			let delta = 0;
			if (current.lastY < rect.top + AUTOSCROLL_EDGE) delta = -AUTOSCROLL_SPEED;
			else if (current.lastY > rect.bottom - AUTOSCROLL_EDGE) delta = AUTOSCROLL_SPEED;
			if (delta !== 0) {
				const before = list.scrollTop;
				list.scrollTop += delta;
				if (list.scrollTop !== before) this.followPointer();
			}
			this.scheduleAutoscroll();
		});
	}
}
