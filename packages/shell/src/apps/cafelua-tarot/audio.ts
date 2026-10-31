export interface BgmElement {
	volume: number;
	loop: boolean;
	paused: boolean;
	play: () => Promise<void> | void;
	pause: () => void;
}

export interface FlipAudioContext {
	currentTime: number;
	destination: AudioNode;
	close?: () => Promise<void>;
	createOscillator: () => OscillatorNode;
	createGain: () => GainNode;
	resume: () => Promise<void>;
}

export class TarotAudioController {
	private muted = false;
	private nodes = new Set<OscillatorNode>();
	private context: FlipAudioContext | null = null;

	constructor(
		private readonly bgm: BgmElement,
		private readonly createContext: () => FlipAudioContext,
		private readonly reportPlayback: (playing: boolean) => void = () => {},
	) {
		this.bgm.loop = true;
		this.bgm.volume = 0.42;
	}

	get isMuted(): boolean {
		return this.muted;
	}

	async startBgm(): Promise<boolean> {
		if (this.muted) return false;
		try {
			await this.bgm.play();
			this.reportPlayback(true);
			return true;
		} catch {
			this.reportPlayback(false);
			return false;
		}
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		if (muted) {
			this.bgm.pause();
			for (const node of this.nodes) {
				try {
					node.stop();
				} catch {
					// Already stopped after its short envelope.
				}
			}
			this.nodes.clear();
			this.reportPlayback(false);
		} else {
			void this.startBgm();
		}
	}

	async playFlip(): Promise<boolean> {
		if (this.muted) return false;
		try {
			this.context ??= this.createContext();
			await this.context.resume();
			if (this.muted) return false;
			const now = this.context.currentTime;
			const gain = this.context.createGain();
			gain.gain.setValueAtTime(0.0001, now);
			gain.gain.exponentialRampToValueAtTime(0.14, now + 0.012);
			gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
			gain.connect(this.context.destination);
			const oscillator = this.context.createOscillator();
			oscillator.type = "triangle";
			oscillator.frequency.setValueAtTime(980, now);
			oscillator.frequency.exponentialRampToValueAtTime(310, now + 0.13);
			oscillator.connect(gain);
			oscillator.onended = () => this.nodes.delete(oscillator);
			this.nodes.add(oscillator);
			oscillator.start(now);
			oscillator.stop(now + 0.17);
			return true;
		} catch {
			return false;
		}
	}

	dispose(): void {
		this.setMuted(true);
		void this.context?.close?.();
		this.context = null;
	}
}

export function createBrowserAudioController(
	bgm: HTMLAudioElement,
	reportPlayback: (playing: boolean) => void,
): TarotAudioController {
	return new TarotAudioController(
		bgm,
		() => new AudioContext() as unknown as FlipAudioContext,
		reportPlayback,
	);
}
