/**
 * Loops one clip on two `<video>` elements that take turns, so the media
 * pipeline of a playing element is never sought or paused.
 *
 * Why: in WebKitGTK the video sink's streaming thread holds the sink lock
 * inside MediaPlayerPrivateGStreamer::triggerRepaint and waits there for the
 * main thread to draw the frame. Any main-thread call that needs the same
 * lock while a frame is in flight freezes the whole WebView, because neither
 * side can move. Three callers do that on a playing element:
 *   - the `loop` attribute: didEnd → mediaPlayerTimeChanged → seekInternal →
 *     doSeek (gdb stack of the recording shell, 2026-09-24);
 *   - `currentTime = …` from JS: seekTask → doSeek (load test, 2026-09-25);
 *   - `pause()` from JS: pauseInternal → set_state(PAUSED) (load test,
 *     2026-09-25).
 *
 * So each element plays to its natural end once (no `loop`). On `ended` the
 * other element, parked at the start with its first frame decoded, starts
 * playing and becomes the one to draw. At end of stream the frame traffic has
 * stopped and the browser has paused the element itself; it is rewound only
 * after a short delay, while it is hidden. Stopping the loop does not pause
 * anything either: the current element runs to its end, hidden, and the loop
 * simply does not hand over.
 *
 * A pipeline can also stall on its own: the element says it is playing but
 * its clock stops before the end (seen in the same load test, with and
 * without this class). An element whose time has not moved for
 * TWIN_STALL_MS is treated like an ended one, except that it is never touched
 * again: the loop hands over and swaps in a fresh element for it (see
 * `replace`). Pausing it could meet a frame in flight; it is only removed
 * once it reaches its own end, or when the loop is disposed.
 */
export const TWIN_REWIND_DELAY_MS = 250;
export const TWIN_STALL_CHECK_MS = 1000;
export const TWIN_STALL_MS = 3000;

export interface TwinLoopOptions {
	/** Makes a new element with the same clip, used in place of a stalled one. */
	replace?: () => HTMLVideoElement;
	/** Takes an element out of the page (not called for elements the host owns). */
	remove?: (element: HTMLVideoElement) => void;
}

export class TwinLoop {
	private readonly elements: [HTMLVideoElement, HTMLVideoElement];
	private active = 0;
	/** Stalled elements left alone until they end by themselves. */
	private readonly abandoned = new Set<HTMLVideoElement>();
	private watch: ReturnType<typeof setInterval> | null = null;
	private lastTime = -1;
	private stillSince = 0;
	/** True while the loop should keep handing over at each end. */
	private wanted = false;
	private disposed = false;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly listeners: Array<() => void> = [];

	constructor(
		primary: HTMLVideoElement,
		twin: HTMLVideoElement,
		private readonly options: TwinLoopOptions = {},
	) {
		this.elements = [primary, twin];
		for (const element of this.elements) this.adopt(element);
	}

	private adopt(element: HTMLVideoElement): void {
		element.loop = false;
		const onEnded = () => this.handleEnded(element);
		element.addEventListener("ended", onEnded);
		this.listeners.push(() => element.removeEventListener("ended", onEnded));
	}

	/** The element whose frames should be drawn now. */
	get current(): HTMLVideoElement {
		return this.elements[this.active];
	}

	/** Both elements, primary first. */
	get all(): readonly HTMLVideoElement[] {
		return [...this.elements, ...this.abandoned];
	}

	/** Whether the loop is wanted (it may still be finishing after stop()). */
	get isRunning(): boolean {
		return this.wanted;
	}

	setMuted(muted: boolean): void {
		for (const element of this.elements) element.muted = muted;
	}

	/**
	 * Start the loop, or keep it going. An element that is still playing is
	 * left alone (no restart, no seek); only a stopped element is played, and
	 * an ended one restarts from the start by itself.
	 */
	async play(): Promise<void> {
		if (this.disposed) return;
		this.wanted = true;
		this.startWatch();
		if (!this.current.paused) return;
		await this.current.play();
	}

	/** Stop at the end of the current pass. Nothing is paused or sought now. */
	stop(): void {
		this.wanted = false;
	}

	/** Tear down (renderer stop). Pausing is unavoidable here. */
	dispose(): void {
		this.disposed = true;
		this.wanted = false;
		if (this.watch) clearInterval(this.watch);
		this.watch = null;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const remove of this.listeners) remove();
		this.listeners.length = 0;
		for (const element of this.all) element.pause();
		for (const element of this.abandoned) this.options.remove?.(element);
		this.abandoned.clear();
	}

	private startWatch(): void {
		if (this.watch || !this.options.replace) return;
		this.watch = setInterval(() => this.checkStall(), TWIN_STALL_CHECK_MS);
	}

	/** Hand over from an element whose clock stopped while it claims to play. */
	private checkStall(): void {
		const element = this.current;
		if (this.disposed || !this.wanted || element.paused) {
			this.lastTime = -1;
			return;
		}
		const now = Date.now();
		if (element.currentTime !== this.lastTime) {
			this.lastTime = element.currentTime;
			this.stillSince = now;
			return;
		}
		if (now - this.stillSince < TWIN_STALL_MS) return;
		const replace = this.options.replace;
		if (!replace) return;
		this.lastTime = -1;
		element.muted = true;
		this.abandoned.add(element);
		const fresh = replace();
		fresh.muted = this.elements[1 - this.active].muted;
		this.adopt(fresh);
		this.elements[this.active] = fresh;
		// The other element is parked at the start; it takes over now, and the
		// fresh one gets the next turn.
		this.active = 1 - this.active;
		void this.current.play()?.catch?.(() => {});
	}

	private handleEnded(element: HTMLVideoElement): void {
		if (this.abandoned.has(element)) {
			// A stalled element that finally ended: nothing is in flight now.
			this.abandoned.delete(element);
			this.options.remove?.(element);
			return;
		}
		if (this.disposed || element !== this.current) return;
		if (this.wanted) {
			this.active = 1 - this.active;
			void this.current.play()?.catch?.(() => {});
		}
		this.rewindWhenIdle(element);
	}

	private rewindWhenIdle(element: HTMLVideoElement): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (this.disposed) return;
			// Only an element that is paused (ended) and not being shown is
			// rewound. One that was played again in the meantime restarted from
			// the start by itself.
			if (!element.paused) return;
			if (element === this.current && this.wanted) return;
			if (element.currentTime !== 0) element.currentTime = 0;
		}, TWIN_REWIND_DELAY_MS);
		this.timers.add(timer);
	}
}
