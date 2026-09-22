import type { VRM } from "@pixiv/three-vrm";

export type EmotionName =
	| "happy"
	| "sad"
	| "angry"
	| "surprised"
	| "neutral"
	| "think";

interface EmotionState {
	expression: { name: string; fallbackName?: string; value: number }[];
	blendDuration: number;
}

/**
 * VRM 1.0 canonical names → VRM 0.0 legacy equivalents.
 * Used to auto-detect which naming convention the model uses.
 */
const VRM_NAME_MAP: Record<string, string> = {
	happy: "Joy",
	sad: "Sorrow",
	angry: "Angry",
	surprised: "Surprised",
	neutral: "Neutral",
	relaxed: "Fun",
	aa: "A",
	ih: "I",
	ou: "U",
	ee: "E",
	oh: "O",
	blink: "Blink",
	blinkLeft: "Blink_L",
	blinkRight: "Blink_R",
};

/**
 * Build a resolver that maps canonical (VRM 1.0) names to actual names in the model.
 * If the model has "Joy" but not "happy", resolves "happy" → "Joy".
 */
export function buildExpressionResolver(
	expressionMap: Record<string, unknown>,
): (canonical: string) => string | null {
	const available = new Set(Object.keys(expressionMap));
	const cache = new Map<string, string | null>();

	return (canonical: string): string | null => {
		if (cache.has(canonical)) return cache.get(canonical)!;

		// 1. Exact match (VRM 1.0 model)
		if (available.has(canonical)) {
			cache.set(canonical, canonical);
			return canonical;
		}

		// 2. VRM 0.0 fallback
		const legacy = VRM_NAME_MAP[canonical];
		if (legacy && available.has(legacy)) {
			cache.set(canonical, legacy);
			return legacy;
		}

		// 3. Case-insensitive search
		const lower = canonical.toLowerCase();
		for (const name of available) {
			if (name.toLowerCase() === lower) {
				cache.set(canonical, name);
				return name;
			}
		}

		cache.set(canonical, null);
		return null;
	};
}

const EMOTION_STATES: Record<EmotionName, EmotionState> = {
	happy: {
		expression: [
			{ name: "happy", value: 1.0 },
			{ name: "aa", value: 0.3 },
		],
		blendDuration: 0.3,
	},
	sad: {
		expression: [
			{ name: "sad", value: 1.0 },
			{ name: "oh", value: 0.2 },
		],
		blendDuration: 0.3,
	},
	angry: {
		expression: [
			{ name: "angry", value: 1.0 },
			{ name: "ee", value: 0.4 },
		],
		blendDuration: 0.2,
	},
	surprised: {
		expression: [
			{ name: "surprised", value: 1.0 },
			{ name: "oh", value: 0.6 },
		],
		blendDuration: 0.1,
	},
	neutral: {
		expression: [{ name: "neutral", value: 1.0 }],
		blendDuration: 0.5,
	},
	think: {
		expression: [{ name: "think", fallbackName: "neutral", value: 1.0 }],
		blendDuration: 0.5,
	},
};

const EMOTION_TAG_RE = /\[(HAPPY|SAD|ANGRY|SURPRISED|NEUTRAL|THINK)]\s*/gi;

const KNOWN_EMOTIONS: readonly EmotionName[] = [
	"happy",
	"sad",
	"angry",
	"surprised",
	"neutral",
	"think",
];

/**
 * Server prosody tag → avatar EmotionName.
 *
 * The voice server emits one `emotion.updated {state: <tag>}` per inline `[tag]`
 * in the reply (`state == tag`, lowercase). These are PROSODY tags (laughter /
 * sigh / breath…), NOT the six avatar emotion names, so we map them by meaning.
 *
 * Non-emotive prosody (breath / inhale / pause / hum / cough / sneeze / yawn /
 * sniff / whisper) is intentionally absent → maps to null → the avatar keeps its
 * current expression instead of flickering to neutral on every micro-pause
 * (the server asks the LLM to tag ≥70% of replies, so these are frequent).
 */
const SERVER_PROSODY_TO_EMOTION: Readonly<Record<string, EmotionName>> = {
	// laughter / delight → happy
	laughing: "happy",
	laugh: "happy",
	laughter: "happy",
	chuckle: "happy",
	giggle: "happy",
	cheer: "happy",
	// sigh / crying / low energy → sad
	sigh: "sad",
	exhale: "sad",
	cry: "sad",
	sob: "sad",
	moan: "sad",
	// sharp intake → surprised
	gasp: "surprised",
	// raised voice → angry
	shout: "angry",
	// unsure / polite-hard-answer beat → think
	hesitation: "think",
};

/**
 * Map a server `emotion.updated` state to an avatar EmotionName.
 *
 * Case- and bracket-insensitive. Accepts either a direct EmotionName (defensive,
 * in case a caller passes one) or a server prosody tag (the actual server wire).
 * Returns null for non-emotive / unknown tags so the caller leaves the current
 * expression unchanged (safe default).
 */
export function mapServerEmotion(state: string): EmotionName | null {
	const key = state
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	if ((KNOWN_EMOTIONS as readonly string[]).includes(key)) {
		return key as EmotionName;
	}
	return SERVER_PROSODY_TO_EMOTION[key] ?? null;
}

const LOWER_PROSODY_TAG_RE = /\[([a-z][a-z_-]{1,15})\]/g;

/**
 * Action words inside (parentheses) or *asterisks* → emotion. The cascade
 * server forbids stage directions, but LLMs are not perfectly obedient and leak
 * them, so we still react instead of speaking the literal "(smiles)".
 */
const ACTION_TO_EMOTION: Readonly<Record<string, EmotionName>> = {
	smile: "happy",
	smiles: "happy",
	smiling: "happy",
	laugh: "happy",
	laughs: "happy",
	laughing: "happy",
	giggle: "happy",
	giggles: "happy",
	grin: "happy",
	grins: "happy",
	sigh: "sad",
	sighs: "sad",
	cry: "sad",
	cries: "sad",
	crying: "sad",
	sob: "sad",
	sobs: "sad",
	frown: "sad",
	frowns: "sad",
	gasp: "surprised",
	gasps: "surprised",
	surprised: "surprised",
	shocked: "surprised",
	scowl: "angry",
	scowls: "angry",
	glare: "angry",
	glares: "angry",
	angry: "angry",
	think: "think",
	thinks: "think",
	thinking: "think",
	ponder: "think",
	ponders: "think",
};

/** `(smiles)` — a parenthetical on one line, no nested parentheses. */
const PAREN_DIRECTION_RE = /\(([^()\n]{1,40})\)/g;
/** `*sighs*` — a single-asterisk span on one line; never part of `**bold**`. */
const STAR_DIRECTION_RE = /(?<![*\w])\*([^*\n]{1,40})\*(?![*\w])/g;

/**
 * A span is a stage direction only when it is plain English words (letters,
 * spaces, `,.'-`) and at least one word is a known action word. Anything else
 * — `(Nextain)`, `*중요*`, `("quote")` — is content and must stay visible.
 */
function stageDirectionEmotion(inner: string): EmotionName | null {
	const text = inner.trim().toLowerCase();
	if (!/^[a-z][a-z\s,.'-]*$/.test(text)) return null;
	for (const word of text.split(/[^a-z]+/)) {
		if (word && ACTION_TO_EMOTION[word]) return ACTION_TO_EMOTION[word];
	}
	return null;
}

/**
 * Robustly extract an avatar emotion + clean display text from one assistant
 * output string, tolerant of the several formats an LLM may produce even when
 * the server prompt asks only for lowercase prosody tags:
 *   - uppercase emotion tag   [HAPPY]            → direct
 *   - lowercase prosody tag    [laughing]/[sigh] → mapped (server prosody vocab)
 *   - stage direction          (smiles) / *sigh* → action-word mapped + stripped
 *     (only single-line, letters-only spans containing a known action word;
 *     every other parenthesis, asterisk and markdown span is preserved)
 *
 * Returns `emotion: null` when nothing matches so the caller leaves the current
 * expression unchanged — it NEVER forces neutral (LLM output is imperfect; a
 * missing cue must not reset the face). `cleanText` has all of the above removed
 * for the chat row. First cue wins (the leading tag is the turn's intent).
 */
export function extractExpression(text: string): {
	emotion: EmotionName | null;
	cleanText: string;
} {
	let emotion: EmotionName | null = null;
	const take = (e: EmotionName | null) => {
		if (!emotion && e) emotion = e;
	};
	// Markdown code is executable/document content, never avatar stage direction.
	// Protect complete and currently-streaming fences before stripping `(smiles)`
	// or `*sigh*`, otherwise valid calls such as `print('naia')` are corrupted.
	const fencedCode: string[] = [];
	const protectedText = text.replace(
		/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,
		(block) => {
			const index = fencedCode.push(block) - 1;
			return `\u0000NAIA_CODE_${index}\u0000`;
		},
	);

	// 1) uppercase emotion tag (highest-intent, persona-style)
	let clean = protectedText.replace(EMOTION_TAG_RE, (_m, tag: string) => {
		take(tag.toLowerCase() as EmotionName);
		return "";
	});
	// 2) lowercase server prosody tag
	clean = clean.replace(LOWER_PROSODY_TAG_RE, (_m, tag: string) => {
		take(mapServerEmotion(tag));
		return "";
	});
	// 3) leaked stage direction (forbidden by server, but tolerate + strip)
	clean = clean.replace(PAREN_DIRECTION_RE, (match, inner: string) => {
		const cue = stageDirectionEmotion(inner);
		if (cue) {
			take(cue);
			return "";
		}
		return match;
	});
	clean = clean.replace(STAR_DIRECTION_RE, (match, inner: string) => {
		const cue = stageDirectionEmotion(inner);
		if (cue) {
			take(cue);
			return "";
		}
		return match;
	});

	clean = clean
		.replace(/(?<=\S)[ \t]{2,}(?=\S)/g, " ")
		.replace(/[ \t]+([.,!?。、！？])/g, "$1")
		.trim();
	clean = clean.replace(
		/\u0000NAIA_CODE_(\d+)\u0000/g,
		(_match, index: string) => fencedCode[Number(index)] ?? "",
	);
	return { emotion, cleanText: clean };
}

export function parseEmotion(text: string): {
	emotion: EmotionName;
	cleanText: string;
} {
	let firstEmotion: EmotionName | null = null;
	const cleanText = text
		.replace(EMOTION_TAG_RE, (_, tag) => {
			if (!firstEmotion) {
				firstEmotion = tag.toLowerCase() as EmotionName;
			}
			return "";
		})
		.trim();
	return {
		emotion: firstEmotion ?? "neutral",
		cleanText,
	};
}

function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function createEmotionController(vrm: VRM) {
	const resolve = vrm.expressionManager
		? buildExpressionResolver(vrm.expressionManager.expressionMap)
		: (_: string) => null;

	let currentEmotion: EmotionName | null = null;
	let isTransitioning = false;
	let transitionProgress = 0;
	const currentValues = new Map<string, number>();
	const targetValues = new Map<string, number>();

	function setEmotion(name: EmotionName, intensity = 1) {
		const state = EMOTION_STATES[name];
		if (!state) return;

		currentEmotion = name;
		isTransitioning = true;
		transitionProgress = 0;
		currentValues.clear();
		targetValues.clear();

		const clamped = Math.min(1, Math.max(0, intensity));

		// Reset all expressions to 0 first
		if (vrm.expressionManager) {
			for (const exprName of Object.keys(vrm.expressionManager.expressionMap)) {
				vrm.expressionManager.setValue(exprName, 0);
			}
		}

		for (const expr of state.expression) {
			const resolved =
				resolve(expr.name) ??
				(expr.fallbackName ? resolve(expr.fallbackName) : null);
			if (!resolved) continue;
			const current = vrm.expressionManager?.getValue(resolved) ?? 0;
			currentValues.set(resolved, current);
			targetValues.set(resolved, expr.value * clamped);
		}
	}

	function update(delta: number) {
		if (!isTransitioning || !currentEmotion) return;

		const state = EMOTION_STATES[currentEmotion];
		const blendDuration = state.blendDuration;

		transitionProgress += delta / blendDuration;
		if (transitionProgress >= 1.0) {
			transitionProgress = 1.0;
			isTransitioning = false;
		}

		const easedT = easeInOutCubic(transitionProgress);

		for (const [exprName, target] of targetValues) {
			const start = currentValues.get(exprName) ?? 0;
			const value = start + (target - start) * easedT;
			vrm.expressionManager?.setValue(exprName, value);
		}
	}

	return { setEmotion, update };
}
