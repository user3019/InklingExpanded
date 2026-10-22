import { Notice } from 'obsidian';

// What a stylus tells this device, live — for finding out whether a pen's
// side button and eraser reach Obsidian at all, which depends on the device
// and its system rather than on anything here.
//
// A Samsung S Pen's button needs no Bluetooth: the screen reads it from the
// pen's own signal, which is why it works in Samsung Notes with the pen
// disconnected. Whether Obsidian's web view passes it on is what this shows.

// Read as the annotate view reads it (AnnotationController.readPenButtons):
// the right button elsewhere, the left button on a hovering pen on Android.
function sideButton(event: PointerEvent): boolean {
	if (event.pointerType !== 'pen') return false;
	if ((event.buttons & 2) !== 0 || (event.type === 'pointerdown' && event.button === 2)) return true;
	return (event.buttons & 1) !== 0 && !(event.pressure > 0);
}

export function startStylusCheck(win: Window): void {
	const notice = new Notice('', 0);
	const show = (lines: string[]) => notice.setMessage(lines.join('\n'));
	show([
		'Stylus check — touch the screen with the pen.',
		'Hold the pen just above the screen and press the side button, then touch with it held.',
		'Try the eraser end too if it has one.',
		'Tap this message to stop.',
	]);

	let frame: number | null = null;
	let last: PointerEvent | null = null;
	// Kept, unlike the live lines: a press or a cancel can come and go
	// between two frames, and these are what tell why a button does nothing.
	let sideSeen = false;
	let cancels = 0;
	const onPointer = (event: PointerEvent) => {
		// Stopped when the message is gone: a notice closes when tapped.
		if (!notice.messageEl.isConnected) {
			stop();
			return;
		}
		last = event;
		if (sideButton(event)) sideSeen = true;
		if (event.type === 'pointercancel') cancels++;
		frame ??= win.requestAnimationFrame(() => {
			frame = null;
			const sample = last;
			if (!sample) return;
			const side = sideButton(sample);
			const eraser = sample.button === 5 || (sample.buttons & 32) !== 0;
			show([
				`Input: ${sample.pointerType}${sample.pointerType === 'pen' ? '' : ' (not recognised as a pen)'}`,
				`Pressure: ${sample.pressure.toFixed(2)}`,
				`Side button: ${side ? 'pressed ✓' : 'not pressed'}`,
				`Eraser end: ${eraser ? 'in use ✓' : 'no'}`,
				`Side button seen so far: ${sideSeen ? 'yes' : 'never'} · cancelled gestures: ${cancels}`,
				`(${sample.type}, button ${sample.button}, buttons ${sample.buttons}) — tap here to stop`,
			]);
		});
	};
	const stop = () => {
		win.removeEventListener('pointerdown', onPointer, true);
		win.removeEventListener('pointermove', onPointer, true);
		win.removeEventListener('pointerup', onPointer, true);
		win.removeEventListener('pointercancel', onPointer, true);
		if (frame !== null) win.cancelAnimationFrame(frame);
		notice.hide();
	};
	win.addEventListener('pointerdown', onPointer, true);
	win.addEventListener('pointermove', onPointer, true);
	win.addEventListener('pointerup', onPointer, true);
	win.addEventListener('pointercancel', onPointer, true);
}
