// A runtime for the `obsidian` module, which ships none.
//
// The published package is type definitions only — `"main": ""` — so any
// source file importing from it simply cannot be loaded under vitest. That
// is the whole reason the integration harness stopped at the controller:
// everything above it (inkBlock.ts, pdfView.ts, main.ts) imports the
// Obsidian API, and the controller path was tested precisely because it was
// the largest slice that does not.
//
// vitest.config.ts aliases `obsidian` here. Typechecking is unaffected:
// tsc still resolves the real obsidian.d.ts for src/, so production code is
// held to the real API and this file only has to satisfy the parts of it
// the tests actually execute.
//
// The classes matter as much as the functions. `instanceof TFile` and
// `instanceof MarkdownView` are how inkBlock.ts decides whether it may
// write, and an identity check only works when the production code and the
// test construct the same class — which they do, because both resolve
// through this one module.

// Everything a Notice was ever used to say, in order. Tests assert on this
// rather than on a spy: a save that fails silently and a save that fails
// loudly are different bugs, and the user being *told* is the behaviour
// worth pinning.
export const notices: string[] = [];

export class Notice {
	constructor(public readonly message: string) {
		notices.push(message);
	}
	hide(): void {
		// Nothing to hide in a test; kept so production code can call it.
	}
}

export abstract class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split('/').pop() ?? this.path;
	}
}

export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.[^.]+$/, '');
	}
	get extension(): string {
		return this.name.split('.').pop() ?? '';
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
}

// Obsidian's Component lifecycle, only as deep as a render child uses it.
// `load` is what a post-processor context calls when it adopts a child, and
// `unload` is what tearing the section down calls — the pair that decides
// whether a block's pending write gets flushed or dropped.
export class Component {
	private loaded = false;
	private readonly children: Component[] = [];

	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.onload();
	}
	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		for (const child of this.children.splice(0)) child.unload();
		this.onunload();
	}
	onload(): void {
		// Overridden by subclasses.
	}
	onunload(): void {
		// Overridden by subclasses.
	}
	addChild<T extends Component>(child: T): T {
		this.children.push(child);
		child.load();
		return child;
	}
	register(_cb: () => void): void {
		// Not exercised by anything under test.
	}
	registerEvent(_ref: unknown): void {
		// Not exercised by anything under test.
	}
}

export class MarkdownRenderChild extends Component {
	constructor(public containerEl: HTMLElement) {
		super();
	}
}

// The two things inkBlock.ts asks a markdown view: which file it is showing
// and whether it is in reading mode. `getMode` is the one that matters —
// returning 'preview' is how the harness reproduces the reading-view bug,
// where an editor write went into a buffer nothing persists.
export class MarkdownView {
	constructor(
		public file: TFile | null,
		public editor: unknown,
		private readonly mode: 'source' | 'preview' = 'source',
	) {}
	getMode(): 'source' | 'preview' {
		return this.mode;
	}
}

export class Plugin extends Component {}

// Every Modal opened, in order. Opening records the modal and stops there:
// what a dialog lays out inside itself is Obsidian's Setting API, which
// nothing here renders, and the question tests ask is which dialog a
// control opened.
export const openedModals: Modal[] = [];

export class Modal {
	// The dialog's own elements, as Obsidian gives a modal them — detached,
	// and only built when something asks, so a test that never opens a
	// dialog's contents needs no DOM at all.
	private elements: { modalEl: HTMLElement; contentEl: HTMLElement } | null = null;
	constructor(public app: unknown) {}
	get modalEl(): HTMLElement {
		return this.dom().modalEl;
	}
	get contentEl(): HTMLElement {
		return this.dom().contentEl;
	}
	private dom(): { modalEl: HTMLElement; contentEl: HTMLElement } {
		if (!this.elements) {
			const modalEl = document.createElement('div');
			modalEl.className = 'modal';
			const contentEl = modalEl.appendChild(document.createElement('div'));
			contentEl.className = 'modal-content';
			this.elements = { modalEl, contentEl };
		}
		return this.elements;
	}
	setTitle(title: string): this {
		this.modalEl.setAttribute('data-title', title);
		return this;
	}
	open(): void {
		openedModals.push(this);
	}
	close(): void {
		// Nothing to close in a test.
	}
}

// Obsidian's quick-switcher dialog, as far as the import flow reaches into
// it: opening is recorded, like any modal, and nothing is ever chosen.
export class FuzzySuggestModal<T> extends Modal {
	placeholder = '';
	setPlaceholder(placeholder: string): void {
		this.placeholder = placeholder;
	}
	getItems(): T[] {
		return [];
	}
}

// A context menu: its items, recorded so a test can read and press them.
export interface MenuItemRecord {
	title: string;
	icon: string;
	click: () => void;
	label?: boolean;
}
export const shownMenus: MenuItemRecord[][] = [];

export class Menu {
	private readonly items: MenuItemRecord[] = [];
	addItem(
		build: (item: {
			setTitle(t: string): unknown;
			setIcon(i: string): unknown;
			setWarning(w: boolean): unknown;
			setIsLabel(l: boolean): unknown;
			setChecked(c: boolean | null): unknown;
			setDisabled(d: boolean): unknown;
			onClick(f: () => void): unknown;
		}) => unknown,
	): this {
		const record: MenuItemRecord = { title: '', icon: '', click: () => undefined };
		const item = {
			setTitle: (title: string) => ((record.title = title), item),
			setIcon: (icon: string) => ((record.icon = icon), item),
			setWarning: () => item,
			setIsLabel: (label: boolean) => ((record.label = label), item),
			setChecked: () => item,
			setDisabled: () => item,
			onClick: (click: () => void) => ((record.click = click), item),
		};
		build(item);
		this.items.push(record);
		return this;
	}
	addSeparator(): this {
		return this;
	}
	showAtPosition(): void {
		shownMenus.push(this.items);
	}
	showAtMouseEvent(): void {
		shownMenus.push(this.items);
	}
}

export class Setting {
	constructor(public containerEl: HTMLElement) {}
}

// The declarative half only (Obsidian 1.13): definitions are data, and the
// base class's own control accessors, which read and write
// `plugin.settings[key]`, are what a subclass overrides.
export class PluginSettingTab {
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	refreshDomState(): void {
		// Nothing renders in a test.
	}

	getSettingDefinitions(): unknown[] {
		return [];
	}
	update(): void {
		// Nothing renders in a test.
	}
}

// View and FileView, as far as a view's lifecycle goes — and in the order
// Obsidian 1.13.7's app.js runs it, because the order is the whole point.
// `View.close` detaches, unloads, then awaits `onClose`. `FileView.onClose`
// is where `loadFile(null)` happens, and `loadFile` is the only thing that
// calls `onUnloadFile`. A subclass that overrides `onClose` without calling
// super therefore never has `onUnloadFile` called on close at all — which is
// how the PDF view lost the flush it relied on, and a page of ink with it.
export class View extends Component {
	app: unknown;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	constructor(public leaf: { app?: unknown }) {
		super();
		this.app = leaf.app;
		this.containerEl = document.createElement('div');
		this.contentEl = this.containerEl.appendChild(document.createElement('div'));
	}
	async open(): Promise<void> {
		this.load();
		await this.onOpen();
	}
	async close(): Promise<void> {
		this.containerEl.remove();
		this.unload();
		await this.onClose();
	}
	async onOpen(): Promise<void> {
		// Overridden by subclasses.
	}
	async onClose(): Promise<void> {
		// Overridden by subclasses.
	}
	addAction(_icon: string, _title: string, _callback: () => void): HTMLElement {
		return document.createElement('div');
	}
	// Attached for real, so a test can dispatch the event and see the view
	// respond. Never detached: a test view lives only as long as its test.
	registerDomEvent(el: EventTarget, type: string, cb: (event: Event) => void): void {
		el.addEventListener(type, cb);
	}
}

export class FileView extends View {
	file: TFile | null = null;
	async onClose(): Promise<void> {
		this.contentEl.replaceChildren();
		await this.loadFile(null);
	}
	async loadFile(file: TFile | null): Promise<void> {
		const previous = this.file;
		if (previous === file) return;
		if (previous) await this.onUnloadFile(previous);
		this.file = null;
		if (!file) return;
		this.file = file;
		await this.onLoadFile(file);
	}
	async onLoadFile(_file: TFile): Promise<void> {
		// Overridden by subclasses.
	}
	async onUnloadFile(_file: TFile): Promise<void> {
		// Overridden by subclasses.
	}
}

// Recorded rather than rendered. Obsidian's own setIcon leaves an empty
// <svg> behind for a name the running build does not know, which is a blank
// button and no error — the failure that cost this plugin its block toggle
// twice on a phone. A test cannot tell a good name from a bad one, but it
// can tell that an icon was asked for at all.
export const iconRequests: { name: string; el: HTMLElement }[] = [];

export function setIcon(el: HTMLElement, name: string): void {
	iconRequests.push({ name, el });
	const svg = el.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('data-icon', name);
	el.appendChild(svg);
}

export function setTooltip(el: HTMLElement, tooltip: string): void {
	el.setAttribute('aria-label', tooltip);
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export function resetObsidianStubs(): void {
	notices.length = 0;
	openedModals.length = 0;
	shownMenus.length = 0;
	iconRequests.length = 0;
}
