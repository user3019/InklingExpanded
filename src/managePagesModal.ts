import { App, Menu, Modal, setTooltip, TFile } from 'obsidian';
import { capturePointer, releasePointer } from './annotate/pointer';
import { setIconOrText } from './icon';
import type { PlannedPage } from './pdf/pages';

// The pages of a PDF, to arrange: select any number, then turn, duplicate,
// delete or export them, or drag them to a new place. Dragging is by a
// row's handle, as in the toolbar editor and for the same reason — pointer
// events, which reach a finger and a pen on Android and iOS where HTML drag
// and drop does not, and a handle that alone drags, so the rest of a row
// still scrolls the list. Nothing reaches the file until Save.

// A PDF to show small pictures of.
export interface PageSource {
	numPages: number;
	draw(pageNumber: number, canvas: HTMLCanvasElement): Promise<void>;
	close(): void;
}

export type PageExportFormat = 'pdf' | 'png';

// A row of the list: one page as it will come out.
interface PageRow {
	page: number;
	turn: number;
	copy: boolean;
	selected: boolean;
	el: HTMLElement;
	check: HTMLInputElement;
	label: HTMLElement;
}

const AUTOSCROLL_EDGE = 56;
const AUTOSCROLL_SPEED = 14;

export class ManagePagesModal extends Modal {
	private listEl: HTMLElement | null = null;
	// The rows, in the order the pages are in now.
	private rows: PageRow[] = [];
	private readonly rowOf = new WeakMap<Element, PageRow>();
	private lastPicked: PageRow | null = null;
	private source: PageSource | null = null;
	private observer: IntersectionObserver | null = null;
	private closed = false;
	private refreshBar: () => void = () => undefined;
	private drag: {
		pointerId: number;
		handle: HTMLElement;
		row: PageRow;
		startY: number;
		startScroll: number;
		lastY: number;
		from: number;
		to: number;
		step: number;
		frame: number | null;
	} | null = null;

	constructor(
		app: App,
		private readonly file: TFile,
		private readonly focusPage: number,
		private readonly openSource: (file: TFile) => Promise<PageSource>,
		private readonly onSave: (plan: PlannedPage[]) => void,
		private readonly onExport: (plan: PlannedPage[], format: PageExportFormat) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Pages of “${this.file.basename}”`);
		this.modalEl.addClass('inkling-layout-modal');
		this.contentEl.createEl('p', {
			cls: 'inkling-layout-hint',
			text: 'Tap pages to select them. Drag by the handle to move them, or focus the handle and use the arrow keys.',
		});
		this.buildBar();
		this.listEl = this.contentEl.createDiv({ cls: 'inkling-layout-list' });
		this.listEl.setAttribute('role', 'list');

		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container inkling-layout-buttons' });
		const cancel = buttons.createEl('button', { cls: 'inkling-layout-cancel', text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const save = buttons.createEl('button', { cls: 'mod-cta inkling-layout-save', text: 'Save' });
		save.type = 'button';
		save.addEventListener('click', () => {
			const plan = this.planOf(this.rows);
			this.close();
			this.onSave(plan);
		});

		void this.openSource(this.file).then(
			(source) => {
				if (this.closed) {
					source.close();
					return;
				}
				this.source = source;
				this.buildRows(source.numPages);
			},
			(error: unknown) => {
				console.error('InklingExpanded: could not read this PDF to arrange its pages.', error);
				this.close();
			},
		);
	}

	onClose(): void {
		this.closed = true;
		this.endDrag(false);
		this.observer?.disconnect();
		this.observer = null;
		this.source?.close();
		this.source = null;
		this.contentEl.empty();
		this.rows = [];
		this.lastPicked = null;
		this.listEl = null;
	}

	private planOf(rows: readonly PageRow[]): PlannedPage[] {
		return rows.map(({ page, turn }) => (turn === 0 ? { page } : { page, turn }));
	}

	private selectedRows(): PageRow[] {
		return this.rows.filter((row) => row.selected);
	}

	private buildBar(): void {
		const bar = this.contentEl.createDiv({ cls: 'inkling-pages-bar' });
		const all = bar.createEl('button', { cls: 'inkling-pages-all' });
		all.type = 'button';
		const count = bar.createSpan({ cls: 'inkling-pages-count' });
		bar.createDiv({ cls: 'inkling-pages-spacer' });

		const action = (cls: string, icon: string, fallback: string, tooltip: string, run: (event: MouseEvent) => void) => {
			const button = bar.createEl('button', { cls: `inkling-pages-action ${cls}` });
			button.type = 'button';
			setIconOrText(button, icon, fallback);
			setTooltip(button, tooltip);
			button.setAttribute('aria-label', tooltip);
			button.addEventListener('click', run);
			return button;
		};
		const needingSelection = [
			action('inkling-pages-left', 'rotate-ccw', '⟲', 'Turn left', () => this.turnSelection(-90)),
			action('inkling-pages-right', 'rotate-cw', '⟳', 'Turn right', () => this.turnSelection(90)),
			action('inkling-pages-copy', 'copy', '⧉', 'Duplicate', () => this.duplicateSelection()),
			action('inkling-pages-export', 'download', '↓', 'Export', (event) => this.showExportMenu(event)),
		];
		const remove = action('inkling-pages-delete', 'trash-2', '✕', 'Delete', () => this.deleteSelection());

		all.addEventListener('click', () => {
			const on = this.selectedRows().length < this.rows.length;
			for (const row of this.rows) this.setSelected(row, on);
			this.refreshBar();
		});
		this.refreshBar = () => {
			const selected = this.selectedRows().length;
			all.setText(selected > 0 && selected === this.rows.length ? 'Select none' : 'Select all');
			count.setText(selected > 0 ? `${selected} selected` : '');
			for (const button of needingSelection) button.disabled = selected === 0;
			// A PDF needs at least one page.
			remove.disabled = selected === 0 || selected === this.rows.length;
		};
		this.refreshBar();
	}

	private buildRows(count: number): void {
		const list = this.listEl;
		if (!list) return;
		// Pictures only as rows come into view: a book has hundreds.
		this.observer =
			typeof IntersectionObserver === 'function'
				? new IntersectionObserver((entries) => this.drawRows(entries), { root: list, rootMargin: '300px 0px' })
				: null;
		this.rows = Array.from({ length: count }, (_, index) => {
			const row = this.buildRow(index + 1, 0, false);
			list.appendChild(row.el);
			this.observer?.observe(row.el);
			return row;
		});
		this.rows[this.focusPage - 1]?.el.scrollIntoView({ block: 'center' });
		this.refreshBar();
	}

	private buildRow(page: number, turn: number, copy: boolean): PageRow {
		const el = createDiv({ cls: 'inkling-layout-row inkling-reorder-row' });
		el.setAttribute('role', 'listitem');
		el.dataset.page = String(page);
		el.toggleClass('is-focus', page === this.focusPage && !copy);

		const handle = el.createEl('button', { cls: 'inkling-layout-handle' });
		handle.type = 'button';
		setIconOrText(handle.createSpan({ cls: 'inkling-layout-grip' }), 'grip-vertical', '⋮⋮');
		setTooltip(handle, `Move page ${page}`);

		const check = el.createEl('input', { cls: 'inkling-reorder-check', type: 'checkbox' });
		check.setAttribute('aria-label', `Select page ${page}`);
		const frame = el.createDiv({ cls: 'inkling-reorder-frame' });
		frame.createEl('canvas', { cls: 'inkling-reorder-thumb' });
		const label = el.createSpan({ cls: 'inkling-layout-label' });
		const row: PageRow = { page, turn, copy, selected: false, el, check, label };
		this.rowOf.set(el, row);
		this.showTurn(row);

		handle.addEventListener('pointerdown', (event) => this.startDrag(event, row, handle));
		handle.addEventListener('keydown', (event) => this.onHandleKey(event, row, handle));
		// A tap anywhere else on the row picks it; a tap that scrolls the
		// list is no click.
		el.addEventListener('click', (event) => {
			if (event.target instanceof Element && event.target.closest('.inkling-layout-handle')) return;
			this.pick(row, event.target === check ? check.checked : !row.selected, event.shiftKey);
		});
		return row;
	}

	private showTurn(row: PageRow): void {
		row.el.setCssProps({ '--inkling-page-turn': `${row.turn}deg` });
		const parts = [`Page ${row.page}`];
		if (row.copy) parts.push('(copy)');
		if (row.turn !== 0) parts.push(`· ${row.turn}°`);
		row.label.setText(parts.join(' '));
	}

	private setSelected(row: PageRow, on: boolean): void {
		row.selected = on;
		row.check.checked = on;
		row.el.toggleClass('is-selected', on);
	}

	// With shift held, everything from the row last picked to this one.
	private pick(row: PageRow, on: boolean, range: boolean): void {
		const from = range && this.lastPicked ? this.rows.indexOf(this.lastPicked) : -1;
		const to = this.rows.indexOf(row);
		if (from >= 0) for (let index = Math.min(from, to); index <= Math.max(from, to); index++) this.setSelected(this.rows[index] as PageRow, on);
		else this.setSelected(row, on);
		this.lastPicked = row;
		this.refreshBar();
	}

	private turnSelection(by: number): void {
		for (const row of this.selectedRows()) {
			row.turn = (row.turn + by + 360) % 360;
			this.showTurn(row);
		}
	}

	private duplicateSelection(): void {
		const list = this.listEl;
		if (!list) return;
		for (const row of this.selectedRows()) {
			const copy = this.buildRow(row.page, row.turn, true);
			this.rows.splice(this.rows.indexOf(row) + 1, 0, copy);
			list.insertBefore(copy.el, row.el.nextSibling);
			this.observer?.observe(copy.el);
		}
		this.refreshBar();
	}

	private deleteSelection(): void {
		const selected = this.selectedRows();
		if (selected.length === 0 || selected.length === this.rows.length) return;
		for (const row of selected) {
			this.observer?.unobserve(row.el);
			row.el.remove();
		}
		this.rows = this.rows.filter((row) => !row.selected);
		this.lastPicked = null;
		this.refreshBar();
	}

	private showExportMenu(event: MouseEvent): void {
		const plan = this.planOf(this.selectedRows());
		if (plan.length === 0) return;
		const pictures = plan.length === 1 ? 'As a PNG picture' : `As ${plan.length} PNG pictures`;
		new Menu()
			.addItem((item) => item.setTitle('As a new PDF').setIcon('file-text').onClick(() => this.onExport(plan, 'pdf')))
			.addItem((item) => item.setTitle(pictures).setIcon('image').onClick(() => this.onExport(plan, 'png')))
			.showAtMouseEvent(event);
	}

	private drawRows(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			const row = entry.target as HTMLElement;
			this.observer?.unobserve(row);
			const canvas = row.querySelector('canvas');
			const page = this.rowOf.get(row)?.page;
			if (canvas && page !== undefined && this.source) {
				this.source.draw(page, canvas).catch((error: unknown) => {
					if (!this.closed) console.warn('InklingExpanded: could not draw a page preview.', error);
				});
			}
		}
	}

	// What a press on this row's handle moves: the whole selection when the
	// row is part of it, otherwise just the row.
	private groupOf(row: PageRow): PageRow[] {
		return row.selected ? this.selectedRows() : [row];
	}

	private onHandleKey(event: KeyboardEvent, row: PageRow, handle: HTMLElement): void {
		const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
		if (step === 0) return;
		event.preventDefault();
		const group = this.groupOf(row);
		const moving = new Set(group);
		const before = this.rows.slice(0, this.rows.indexOf(row)).filter((other) => !moving.has(other)).length;
		this.placeGroup(group, before + step);
		handle.focus();
		row.el.scrollIntoView({ block: 'nearest' });
	}

	// Puts `group` together, in the order it is in, after `gap` of the rows
	// that are not in it. Moves only those rows, so the rest of a long list
	// keeps its pictures and its place.
	private placeGroup(group: readonly PageRow[], gap: number): void {
		const list = this.listEl;
		if (!list) return;
		const moving = new Set(group);
		const rest = this.rows.filter((row) => !moving.has(row));
		const at = Math.max(0, Math.min(rest.length, gap));
		this.rows = [...rest.slice(0, at), ...group, ...rest.slice(at)];
		const next = rest[at]?.el ?? null;
		for (const row of group) list.insertBefore(row.el, next);
	}

	private startDrag(event: PointerEvent, row: PageRow, handle: HTMLElement): void {
		const list = this.listEl;
		if (event.button !== 0 || this.drag || !list) return;
		event.preventDefault();
		capturePointer(handle, event.pointerId);
		const [first, second] = this.rows;
		const step = first && second ? second.el.offsetTop - first.el.offsetTop : row.el.offsetHeight;
		const from = this.rows.indexOf(row);
		this.drag = {
			pointerId: event.pointerId,
			handle,
			row,
			startY: event.clientY,
			startScroll: list.scrollTop,
			lastY: event.clientY,
			from,
			to: from,
			step: step > 0 ? step : row.el.offsetHeight || 80,
			frame: null,
		};
		row.el.addClass('is-dragging');
		const group = this.groupOf(row);
		for (const other of group) if (other !== row) other.el.addClass('is-carried');
		if (group.length > 1) row.el.dataset.carrying = `${group.length}`;
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
		if (this.drag?.pointerId === event.pointerId) this.endDrag(true);
	};

	private readonly onDragCancel = (event: PointerEvent): void => {
		if (this.drag?.pointerId === event.pointerId) this.endDrag(false);
	};

	private followPointer(): void {
		const drag = this.drag;
		const list = this.listEl;
		if (!drag || !list) return;
		const offset = drag.lastY - drag.startY + (list.scrollTop - drag.startScroll);
		const previous = drag.to;
		drag.to = Math.max(0, Math.min(this.rows.length - 1, Math.round(drag.from + offset / drag.step)));
		drag.row.el.setCssProps({ '--inkling-row-shift': `${offset}px` });

		// Only the rows that could have changed: in a book, this runs on
		// every sample of the pointer, and there are hundreds of the others.
		const low = Math.min(drag.from, drag.to, previous);
		const high = Math.max(drag.from, drag.to, previous);
		for (let index = low; index <= high; index++) {
			if (index === drag.from) continue;
			let shift = 0;
			if (drag.from < index && index <= drag.to) shift = -drag.step;
			else if (drag.to <= index && index < drag.from) shift = drag.step;
			this.rows[index]?.el.setCssProps({ '--inkling-row-shift': `${shift}px` });
		}
	}

	private endDrag(commit: boolean): void {
		const drag = this.drag;
		if (!drag) return;
		this.drag = null;
		if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
		drag.handle.removeEventListener('pointermove', this.onDragMove);
		drag.handle.removeEventListener('pointerup', this.onDragEnd);
		drag.handle.removeEventListener('pointercancel', this.onDragCancel);
		drag.handle.removeEventListener('lostpointercapture', this.onDragCancel);
		releasePointer(drag.handle, drag.pointerId);
		this.listEl?.removeClass('is-reordering');
		drag.row.el.removeClass('is-dragging');
		delete drag.row.el.dataset.carrying;
		const group = this.groupOf(drag.row);
		for (const other of group) other.el.removeClass('is-carried');
		const low = Math.min(drag.from, drag.to);
		const high = Math.max(drag.from, drag.to);
		for (let index = low; index <= high; index++) this.rows[index]?.el.setCssProps({ '--inkling-row-shift': '0px' });
		drag.row.el.setCssProps({ '--inkling-row-shift': '0px' });
		if (commit && drag.to !== drag.from) {
			// Where the dragged row landed, counted in the rows not going
			// with it.
			const moving = new Set(group);
			const others = this.rows.filter((row) => row !== drag.row);
			this.placeGroup(group, others.slice(0, drag.to).filter((row) => !moving.has(row)).length);
		}
	}

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
