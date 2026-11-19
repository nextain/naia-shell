import {
	buildBrowserTimedSpeechPlan,
	createBrowserTimedSpeechControllerFromWords,
	synthesizePronunciationWordsFromText,
} from "../avatar/nva-speech/browser-speech-plan";
import type {
	AudioPlaybackClock,
	SpeechPlan,
} from "../avatar/nva-speech/speech-timing";
import { Logger } from "../logger";
import { buildExpressionResolver } from "./expression";

const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
type VrmViseme = (typeof VISEMES)[number];

interface MouthPose {
	viseme: VrmViseme;
	weight: number;
}

export type VrmLipSyncSource = () => MouthPose | null;

const VOWEL_POSES = new Map<string, VrmViseme>([
	["vowel-open", "aa"],
	["vowel-spread", "ih"],
	["vowel-round", "ou"],
	["vowel-mid", "ee"],
]);

/** Use the planned shape at the sound's position and scale it by actual audio energy. */
export function sampleVrmMouth(
	plan: SpeechPlan | null,
	positionSeconds: number,
	audioLevel?: number,
): MouthPose | null {
	if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return null;
	const position = positionSeconds * 1_000_000;
	const event = plan?.events.find(
		({ start_us, end_us }) => start_us <= position && position < end_us,
	);
	const level =
		audioLevel === undefined
			? undefined
			: Number.isFinite(audioLevel)
				? Math.min(1, Math.max(0, (audioLevel - 0.005) * 14))
				: 0;
	if (level === 0 || event?.unit === "closed") return null;
	if (!event || event.unit === "sil") {
		return level ? { viseme: "aa", weight: level } : null;
	}
	const vowel = VOWEL_POSES.get(event.unit);
	return {
		viseme: vowel ?? "aa",
		weight: (vowel ? 1 : 0.4) * (level ?? 0.78),
	};
}

export function createAudioVrmLipSync(
	text: string,
	locale: string,
	playback: AudioPlaybackClock,
): VrmLipSyncSource {
	Logger.debug("VrmLipSync", "follow speech audio", {
		hasMeter: Boolean(playback.readSpeechLevel),
	});
	const words = synthesizePronunciationWordsFromText(text);
	let plan: SpeechPlan | null = null;
	let plannedDuration: number | undefined;
	return () => {
		const position = playback.clock();
		const duration = playback.duration?.();
		const actualDuration = duration && Number.isFinite(duration) ? duration : 0;
		if (actualDuration && position >= actualDuration) return null;
		if (words.length && plannedDuration !== actualDuration) {
			plan = buildBrowserTimedSpeechPlan({
				text,
				locale,
				words,
				durationSeconds: actualDuration,
			});
			plannedDuration = actualDuration;
		}
		return sampleVrmMouth(plan, position, playback.readSpeechLevel?.());
	};
}

export function createBrowserVrmLipSync(text: string, locale: string) {
	const words = synthesizePronunciationWordsFromText(text);
	const timing = createBrowserTimedSpeechControllerFromWords(
		text,
		locale,
		words,
	);
	if (!timing) {
		// Some scripts have no local pronunciation units. Browser speech still
		// exposes word boundaries even though its audio samples are private.
		let openUntil = 0;
		const markBoundary = () => {
			openUntil = performance.now() + 160;
		};
		return {
			start(): VrmLipSyncSource {
				markBoundary();
				return () =>
					performance.now() < openUntil ? { viseme: "aa", weight: 0.55 } : null;
			},
			boundary: markBoundary,
		};
	}
	let plan = timing.initialPlan;
	return {
		start(): VrmLipSyncSource {
			timing.markStarted();
			return () => sampleVrmMouth(plan, timing.clock());
		},
		boundary(charIndex: number, elapsedSeconds: number) {
			plan = timing.updateForBoundary(charIndex, elapsedSeconds) ?? plan;
		},
	};
}

interface MouthExpressions {
	expressionMap: Record<string, unknown>;
	getValue(name: string): number | null;
	setValue(name: string, weight: number): void;
}

/** Overlay speech on the model's expression mixer for the current frame. */
export function createVrmMouthController(expressions: MouthExpressions) {
	const resolve = buildExpressionResolver(expressions.expressionMap);
	const names = VISEMES.map(resolve).filter(
		(name): name is string => name !== null,
	);
	const previous = new Map<string, number>();
	return {
		restore() {
			for (const [name, weight] of previous) expressions.setValue(name, weight);
			previous.clear();
		},
		apply(pose: MouthPose | null) {
			const activeName = pose ? (resolve(pose.viseme) ?? names[0]) : undefined;
			for (const name of names) {
				const base = expressions.getValue(name) ?? 0;
				const weight = pose && name === activeName ? pose.weight : 0;
				if (weight === base) continue;
				previous.set(name, base);
				expressions.setValue(name, weight);
			}
		},
	};
}
