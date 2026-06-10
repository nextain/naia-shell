import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JUDGE_MODEL = process.env.CAFE_E2E_JUDGE_MODEL || "gemini-2.5-flash";
const JUDGE_API_KEY =
	process.env.CAFE_E2E_API_KEY || process.env.GEMINI_API_KEY;
const JUDGE_TIMEOUT_MS = Number(
	process.env.CAFE_E2E_JUDGE_TIMEOUT_MS || "15000",
);
const SEMANTIC_LOG_DIR =
	process.env.CAFE_E2E_SEMANTIC_LOG_DIR || "/tmp/e2e-semantic-logs";

let logSeq = 0;

function logSemantic(entry: {
	task: string;
	answer: string;
	criteria: string;
	verdict: string;
	reason: string;
}): void {
	try {
		mkdirSync(SEMANTIC_LOG_DIR, { recursive: true });
		logSeq += 1;
		const ts = new Date().toISOString().replace(/[:.]/g, "-");
		const filename = `${ts}-${String(logSeq).padStart(3, "0")}-${entry.verdict}.json`;
		writeFileSync(
			join(SEMANTIC_LOG_DIR, filename),
			JSON.stringify(entry, null, 2),
			"utf-8",
		);
	} catch {
		// Logging failure should not break tests
	}
}

interface SemanticJudgeResult {
	verdict: "PASS" | "FAIL";
	reason: string;
}

function extractJson(text: string): SemanticJudgeResult {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) {
		return {
			verdict: "FAIL",
			reason: `No JSON found in judge response: ${text.slice(0, 160)}`,
		};
	}
	try {
		const parsed = JSON.parse(m[0]) as Partial<SemanticJudgeResult>;
		const verdict = parsed.verdict === "PASS" ? "PASS" : "FAIL";
		return {
			verdict,
			reason: parsed.reason ?? "No reason",
		};
	} catch (err) {
		return {
			verdict: "FAIL",
			reason: `Invalid JSON from judge: ${String(err)}`,
		};
	}
}

export async function judgeSemantics(opts: {
	task: string;
	answer: string;
	criteria: string;
}): Promise<SemanticJudgeResult> {
	if (!JUDGE_API_KEY) {
		return {
			verdict: "FAIL",
			reason: "Missing judge API key (CAFE_E2E_API_KEY or GEMINI_API_KEY)",
		};
	}

	const prompt = `You are a strict E2E semantic judge.\nTask: ${opts.task}\nAnswer: ${opts.answer}\nCriteria: ${opts.criteria}\nReturn JSON only: {"verdict":"PASS|FAIL","reason":"..."}\n`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent?key=${JUDGE_API_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: prompt }] }],
				generationConfig: {
					temperature: 0,
				},
			}),
			signal: controller.signal,
		},
	).catch((err) => {
		return {
			ok: false,
			status: 599,
			json: async () => ({}),
			__err: String(err),
		} as unknown as Response;
	});
	clearTimeout(timeoutId);

	if (!res.ok) {
		return {
			verdict: "FAIL",
			reason: `Judge HTTP ${res.status}`,
		};
	}

	const body = await res.json();
	const text: string =
		body?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? "";
	return extractJson(text);
}

/**
 * Assert that an AI response semantically satisfies the given criteria.
 * Throws an assertion error (via expect) if the judge returns FAIL.
 *
 * Usage:
 *   const text = await getLastAssistantMessage();
 *   await assertSemantic(text, "서울 날씨 알려줘", "AI가 실제 날씨/기온 정보를 제공했는가");
 */
export async function assertSemantic(
	answer: string,
	task: string,
	criteria: string,
): Promise<void> {
	if (!answer || answer.trim().length === 0) {
		logSemantic({
			task,
			answer: "(empty)",
			criteria,
			verdict: "FAIL",
			reason: "Empty answer",
		});
		throw new Error(`Semantic FAIL — empty answer for task: "${task}"`);
	}
	const result = await judgeSemantics({ task, answer, criteria });
	logSemantic({
		task,
		answer,
		criteria,
		verdict: result.verdict,
		reason: result.reason,
	});
	if (result.verdict !== "PASS") {
		throw new Error(
			`Semantic FAIL — task: "${task}"\n` +
				`  answer: "${answer.slice(0, 500)}"\n` +
				`  reason: ${result.reason}`,
		);
	}
}

export async function judgeAllSemantics(opts: {
	task: string;
	answers: string[];
	criteria: string;
}): Promise<SemanticJudgeResult> {
	if (opts.answers.length === 0) {
		return {
			verdict: "FAIL",
			reason: "No assistant messages to judge",
		};
	}

	for (const answer of opts.answers) {
		if (
			/Tool Call:|print\s*\(\s*skill_[a-z0-9_-]+\s*\)|잠시만 기다려/i.test(
				answer,
			)
		) {
			return {
				verdict: "FAIL",
				reason: "Placeholder/tool-call-only message detected",
			};
		}
	}

	const reasons: string[] = [];
	for (const answer of opts.answers) {
		const judged = await judgeSemantics({
			task: opts.task,
			answer,
			criteria: opts.criteria,
		});
		reasons.push(judged.reason);
		if (judged.verdict !== "PASS") {
			return {
				verdict: "FAIL",
				reason: judged.reason,
			};
		}
	}

	return {
		verdict: "PASS",
		reason: reasons.join(" | "),
	};
}

export async function judgeVisualSemantics(opts: {
	task: string;
	screenshotBase64: string;
	criteria: string;
}): Promise<SemanticJudgeResult> {
	if (!JUDGE_API_KEY) {
		return {
			verdict: "FAIL",
			reason: "Missing judge API key (CAFE_E2E_API_KEY or GEMINI_API_KEY)",
		};
	}

	const prompt = `You are a strict E2E semantic judge.\nTask: ${opts.task}\nCriteria: ${opts.criteria}\nAnalyze the provided screenshot and return JSON only: {"verdict":"PASS|FAIL","reason":"..."}\n`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${JUDGE_MODEL}:generateContent?key=${JUDGE_API_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{ text: prompt },
							{
								inlineData: {
									mimeType: "image/png",
									data: opts.screenshotBase64,
								},
							},
						],
					},
				],
				generationConfig: {
					temperature: 0,
				},
			}),
			signal: controller.signal,
		},
	).catch((err) => {
		return {
			ok: false,
			status: 599,
			json: async () => ({}),
			__err: String(err),
		} as unknown as Response;
	});
	clearTimeout(timeoutId);

	if (!res.ok) {
		return {
			verdict: "FAIL",
			reason: `Judge HTTP ${res.status}`,
		};
	}

	const body = await res.json();
	const text: string =
		body?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? "";
	return extractJson(text);
}

/**
 * Assert that an AI response semantically satisfies the given criteria using a screenshot.
 * Throws an assertion error (via expect) if the judge returns FAIL.
 *
 * Usage:
 *   const screenshot = await browser.takeScreenshot();
 *   await assertVisual(screenshot, "아바타 표정 확인", "아바타가 웃고 있는 표정이어야 한다");
 */
export async function assertVisual(
	screenshotBase64: string,
	task: string,
	criteria: string,
): Promise<void> {
	if (!screenshotBase64 || screenshotBase64.trim().length === 0) {
		logSemantic({
			task,
			answer: "(empty screenshot)",
			criteria,
			verdict: "FAIL",
			reason: "Empty screenshot data",
		});
		throw new Error(
			`Visual Semantic FAIL — empty screenshot for task: "${task}"`,
		);
	}
	const result = await judgeVisualSemantics({
		task,
		screenshotBase64,
		criteria,
	});
	logSemantic({
		task,
		answer: "(screenshot)",
		criteria,
		verdict: result.verdict,
		reason: result.reason,
	});
	if (result.verdict !== "PASS") {
		throw new Error(
			`Visual Semantic FAIL — task: "${task}"\n` + `  reason: ${result.reason}`,
		);
	}
}
