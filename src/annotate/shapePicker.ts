import { setTooltip } from 'obsidian';
import type { AnnotationController } from './controller';
import { hangPicker } from './penPicker';
import type { ShapeOptions } from './toolState';
import type { ShapeToolType } from './types';

const LINE_STYLES: readonly { value: ShapeOptions['dash']; label: string }[] = [
	{ value: 'solid', label: 'Solid' },
	{ value: 'dashed', label: 'Dashed' },
	{ value: 'dotted', label: 'Dotted' },
];

// The picker on a shape tool's button, opened the way the pen's is — a press
// on the tool already in hand: the line's style, and whatever else this
// shape can do.
export function openShapePicker(anchor: HTMLElement, controller: AnnotationController, tool: ShapeToolType, onClose: () => void): () => void {
	const picker = anchor.ownerDocument.body.createDiv({ cls: 'inkling-pen-picker inkling-shape-picker' });
	picker.setAttribute('role', 'dialog');
	picker.setAttribute('aria-label', 'Line style');

	const styles = picker.createDiv({ cls: 'inkling-shape-styles' });
	const buttons = LINE_STYLES.map(({ value, label }) => {
		const button = styles.createEl('button', { cls: 'inkling-shape-style' });
		button.type = 'button';
		setTooltip(button, label);
		button.setAttribute('aria-label', label);
		button.createSpan({ cls: `inkling-shape-style-line is-${value}` });
		button.addEventListener('click', () => {
			controller.setShapeOptions({ dash: value });
			show();
		});
		return { button, value };
	});

	const toggle = (label: string, read: () => boolean, write: (on: boolean) => void) => {
		const button = picker.createEl('button', { cls: 'inkling-pen-pressure inkling-shape-toggle' });
		button.type = 'button';
		button.setAttribute('role', 'switch');
		button.createSpan({ cls: 'inkling-pen-pressure-label', text: label });
		button.createSpan({ cls: 'inkling-pen-pressure-track' }).createSpan({ cls: 'inkling-pen-pressure-thumb' });
		const showToggle = () => {
			button.setAttribute('aria-checked', String(read()));
			button.toggleClass('is-on', read());
		};
		showToggle();
		button.addEventListener('click', () => {
			write(!read());
			showToggle();
		});
	};
	if (tool === 'rectangle' || tool === 'oval') {
		toggle('Fill', () => controller.getShapeOptions().filled, (filled) => controller.setShapeOptions({ filled }));
	}
	if (tool === 'arrow') {
		toggle('Both ends', () => controller.getShapeOptions().bothEnds, (bothEnds) => controller.setShapeOptions({ bothEnds }));
	}

	const show = () => {
		const current = controller.getShapeOptions().dash;
		for (const { button, value } of buttons) {
			button.toggleClass('is-active', value === current);
			button.setAttribute('aria-pressed', String(value === current));
		}
	};
	show();
	return hangPicker(picker, anchor, onClose);
}
