import { ParseSpeeds } from 'pdf-lib';

// How pdf-lib paces itself. By default it stops every hundred objects to
// parse, and every fifty to save, to let the page it assumes it is running
// on stay responsive — and each stop is a timer, which a browser rounds up
// to 4 ms. In the writer's worker there is no page to keep responsive, and a
// thick textbook paid for thousands of those stops on every open and save.
// On the main thread — the fallback for a device where the worker cannot
// start — the stops are what keeps the pen moving, so they stay.

let fullSpeed = false;

export function runAtFullSpeed(): void {
	fullSpeed = true;
}

export function loadSpeed(): { parseSpeed?: number } {
	return fullSpeed ? { parseSpeed: ParseSpeeds.Fastest } : {};
}

export function saveSpeed(): { objectsPerTick?: number } {
	return fullSpeed ? { objectsPerTick: Infinity } : {};
}
