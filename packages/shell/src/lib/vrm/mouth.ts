import type { VRM } from "@pixiv/three-vrm";
import { buildExpressionResolver } from "./expression";

type LipKey = "A" | "E" | "I" | "O" | "U";

/** Canonical VRM 1.0 vowel names */
const CANONICAL_VOWELS: Record<LipKey, string> = {
	A: "aa",
	E: "ee",
	I: "ih",
	O: "oh",
	U: "ou",
};

const LIP_KEYS: LipKey[] = ["A", "E", "I", "O", "U"];

const ATTACK = 50;
const RELEASE = 30;
const CAP = 0.7;

/**
 * Simulated lip sync controller.
 * Audio playback is handled by ChatPanel (HTML Audio element).
 * This controller drives VRM mouth blendshapes when isSpeaking is true,
 * using a randomized vowel pattern to simulate speech.
 */
export function createMouthController(vrm: VRM) {
	const resolve = vrm.expressionManager
		? buildExpressionResolver(vrm.expressionManager.expressionMap)
		: (_: string) => null;

	// Resolve canonical vowel names to actual model names
	const resolvedVowels: Record<LipKey, string | null> = {
		A: resolve(CANONICAL_VOWELS.A),
		E: resolve(CANONICAL_VOWELS.E),
		I: resolve(CANONICAL_VOWELS.I),
		O: resolve(CANONICAL_VOWELS.O),
		U: resolve(CANONICAL_VOWELS.U),
	};

	const smoothState: Record<LipKey, number> = {
		A: 0,
		E: 0,
		I: 0,
		O: 0,
		U: 0,
	};
	let speaking = false;
	let elapsed = 0;

	function setSpeaking(value: boolean): void {
		speaking = value;
		if (!value) elapsed = 0;
	}

	function update(delta: number): void {
		if (!vrm.expressionManager) return;

		elapsed += delta;

		const target: Record<LipKey, number> = {
			A: 0,
			E: 0,
			I: 0,
			O: 0,
			U: 0,
		};

		if (speaking) {
			// Simulated speech pattern: oscillating vowel shapes
			const t = elapsed * 8; // speed of mouth movement
			const wave = Math.sin(t) * 0.5 + 0.5;
			const wave2 = Math.sin(t * 1.7 + 1.3) * 0.5 + 0.5;

			target.A = Math.min(CAP, wave * 0.6 + 0.1);
			target.O = Math.min(CAP * 0.5, wave2 * 0.3);
			target.E = Math.min(CAP * 0.3, (1 - wave) * 0.2);
		}

		for (const key of LIP_KEYS) {
			const resolved = resolvedVowels[key];
			if (!resolved) continue;
			const from = smoothState[key];
			const to = target[key];
			const rate = 1 - Math.exp(-(to > from ? ATTACK : RELEASE) * delta);
			smoothState[key] = from + (to - from) * rate;
			const weight = (smoothState[key] <= 0.01 ? 0 : smoothState[key]) * 0.7;
			vrm.expressionManager.setValue(resolved, weight);
		}
	}

	function stop(): void {
		speaking = false;
		elapsed = 0;
	}

	return {
		setSpeaking,
		update,
		stop,
		get isSpeaking() {
			return speaking;
		},
	};
}
