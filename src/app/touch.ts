/**
 * Touchscreen gestures for the UI: taps (short, still) and swipes (a step
 * per `stepPx` of travel, so a long drag scrolls several cards). Works on
 * the runtime's standard touch events dispatched on `screen`.
 */
export interface TouchHandlers {
	onTap(x: number, y: number): void;
	onSwipe(dxSteps: number, dySteps: number): void;
}

interface TouchTarget {
	addEventListener(type: 'touchstart' | 'touchmove' | 'touchend', listener: (ev: TouchEvent) => void): void;
}

const TAP_MAX_MOVE = 18;
const TAP_MAX_MS = 600;

export function attachTouch(target: TouchTarget, handlers: TouchHandlers, stepPx = 120): void {
	let id: number | undefined;
	let startX = 0;
	let startY = 0;
	let startAt = 0;
	let originX = 0;
	let originY = 0;
	let moved = false;
	const point = (t: Touch) => ({ x: t.clientX ?? t.screenX, y: t.clientY ?? t.screenY });

	target.addEventListener('touchstart', (ev) => {
		if (id !== undefined) return; // one finger drives the UI
		const t = ev.changedTouches[0];
		if (!t) return;
		id = t.identifier;
		const p = point(t);
		startX = originX = p.x;
		startY = originY = p.y;
		startAt = performance.now();
		moved = false;
	});
	target.addEventListener('touchmove', (ev) => {
		const t = Array.from(ev.changedTouches).find((c) => c.identifier === id);
		if (!t) return;
		const p = point(t);
		if (Math.abs(p.x - startX) > TAP_MAX_MOVE || Math.abs(p.y - startY) > TAP_MAX_MOVE) moved = true;
		const dx = p.x - originX;
		const dy = p.y - originY;
		if (Math.abs(dx) >= stepPx || Math.abs(dy) >= stepPx * 1.5) {
			// Dragging left brings the next card into view: a step to the right.
			const sx = Math.abs(dx) >= stepPx ? -Math.sign(dx) * Math.floor(Math.abs(dx) / stepPx) : 0;
			const sy = Math.abs(dy) >= stepPx * 1.5 ? -Math.sign(dy) : 0;
			handlers.onSwipe(sx, sy);
			originX = p.x;
			originY = p.y;
		}
	});
	target.addEventListener('touchend', (ev) => {
		const t = Array.from(ev.changedTouches).find((c) => c.identifier === id);
		if (!t) return;
		id = undefined;
		const p = point(t);
		if (!moved && performance.now() - startAt <= TAP_MAX_MS) handlers.onTap(p.x, p.y);
	});
}
