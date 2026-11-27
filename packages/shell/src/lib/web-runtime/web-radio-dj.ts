/**
 * Web-only Radio DJ chatter. The native naia-agent owns the real proactive
 * speech engine; the browser worker has none. This minimal engine watches the
 * shared BGM playback state and emits the same proactive `text` chunks
 * (activityId + subscriptionEpoch + profileGeneration) that ChatArea already
 * consumes for TTS / avatar speech, so no new UI path exists.
 *
 * Moments: a track starts playing (short intro) and a track ends (hand-off to
 * the next one). If a new track starts right after an end, one combined
 * transition+intro line is spoken instead of two overlapping lines.
 */
import type { BgmPlaybackSnapshot } from "../bgm-playback";
import { interpolateMessage } from "../kiosk-demo/kb-compiler/interpolate-message";
import radioDjCopy from "../kiosk-demo/radio-dj-ko.json";

export const WEB_DJ_END_GRACE_MS = 4_000;
export const WEB_DJ_POLL_MS = 1_000;
export const WEB_DJ_OPENING_GRACE_MS = 8_000;
export const WEB_DJ_MAX_CHAT_WAIT_MS = 30_000;

export type WebDjMoment =
	| { kind: "intro"; title: string }
	| { kind: "transition"; prevTitle: string; title: string }
	| { kind: "outro"; prevTitle: string; nextTitle?: string }
	| { kind: "opening" };

export interface WebRadioDjDeps {
	emit: (event: string, payload: string) => void;
	getPlayback: () => BgmPlaybackSnapshot | null;
	getNextTitle?: () => string | undefined;
	/** Returns generated text, or throws/returns "" to use the fixed line. */
	generate: (prompt: string) => Promise<string>;
	/** True while a user chat turn owns the voice lane (ChatArea drops DJ text then). */
	isChatBusy?: () => boolean;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	pollMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

function formatMoment(
	copy: typeof radioDjCopy.fallback,
	moment: WebDjMoment,
): string {
	switch (moment.kind) {
		case "opening":
			return copy.opening;
		case "intro":
			return interpolateMessage(copy.intro, { title: moment.title });
		case "transition":
			return interpolateMessage(copy.transition, {
				prevTitle: moment.prevTitle,
				title: moment.title,
			});
		case "outro":
			return moment.nextTitle
				? interpolateMessage(copy.outroWithNext, {
						prevTitle: moment.prevTitle,
						nextTitle: moment.nextTitle,
					})
				: interpolateMessage(copy.outro, { prevTitle: moment.prevTitle });
	}
}

export function djPrompt(moment: WebDjMoment): string {
	return radioDjCopy.prompt.base + formatMoment(radioDjCopy.prompt, moment);
}

export function djFallbackLine(moment: WebDjMoment): string {
	return formatMoment(radioDjCopy.fallback, moment);
}

function sanitizeLine(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}

export interface WebRadioDj {
	start(opts: { subscriptionEpoch: number }): void;
	stop(): void;
	tick(): void;
	readonly running: boolean;
}

export function createWebRadioDj(deps: WebRadioDjDeps): WebRadioDj {
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
	const clearTimer =
		deps.clearTimer ??
		((h) => clearInterval(h as ReturnType<typeof setInterval>));
	let timer: unknown = null;
	let epoch = 0;
	let activityId = "";
	let token = 0;
	let seq = 0;
	let introducedId: string | null = null;
	let startedAt = -1;
	let openingSpoken = false;
	let pendingEnd: { id: string; title: string; at: number } | null = null;
	let busy = false;

	async function speak(moment: WebDjMoment, myToken: number): Promise<void> {
		busy = true;
		let text = "";
		try {
			text = sanitizeLine(await deps.generate(djPrompt(moment)));
		} catch {
			text = "";
		}
		const sleep =
			deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
		for (
			let waited = 0;
			deps.isChatBusy?.() && waited < WEB_DJ_MAX_CHAT_WAIT_MS;
			waited += WEB_DJ_POLL_MS
		) {
			await sleep(WEB_DJ_POLL_MS);
			if (myToken !== token) break;
		}
		busy = false;
		if (myToken !== token) return;
		if (!text) text = djFallbackLine(moment);
		deps.emit(
			"agent_response",
			JSON.stringify({
				type: "text",
				requestId: `web-dj-text-${++seq}`,
				activityId,
				subscriptionEpoch: epoch,
				profileGeneration: epoch,
				text,
			}),
		);
	}

	function tick(): void {
		if (timer === null || busy) return;
		const snap = deps.getPlayback();
		if (!snap) {
			// 아직 고른 곡이 없어도 시작 멘트는 나간다. 새 방문·새 대화의 첫인사다.
			if (!openingSpoken && startedAt >= 0 && now() - startedAt >= WEB_DJ_OPENING_GRACE_MS) {
				openingSpoken = true;
				void speak({ kind: "opening" }, token);
			}
			return;
		}
		const id = snap.playbackId;
		const title = snap.selected.title;
		if (snap.status === "playing" && introducedId !== id) {
			introducedId = id;
			const prev = pendingEnd;
			pendingEnd = null;
			void speak(
				prev
					? { kind: "transition", prevTitle: prev.title, title }
					: { kind: "intro", title },
				token,
			);
			return;
		}
		if (snap.status === "ended" && introducedId === id && !pendingEnd) {
			pendingEnd = { id, title, at: now() };
			return;
		}
		if (
			pendingEnd &&
			now() - pendingEnd.at >= WEB_DJ_END_GRACE_MS &&
			(snap.playbackId === pendingEnd.id || snap.status !== "playing")
		) {
			const prev = pendingEnd;
			pendingEnd = null;
			void speak(
				{
					kind: "outro",
					prevTitle: prev.title,
					nextTitle: deps.getNextTitle?.(),
				},
				token,
			);
		}
	}

	return {
		start(opts) {
			token += 1;
			epoch = opts.subscriptionEpoch;
			activityId = `web-radio-dj-${epoch}`;
			introducedId = null;
			pendingEnd = null;
			busy = false;
			startedAt = now();
			openingSpoken = false;
			if (timer !== null) clearTimer(timer);
			timer = setTimer(tick, deps.pollMs ?? WEB_DJ_POLL_MS);
		},
		stop() {
			token += 1;
			busy = false;
			pendingEnd = null;
			startedAt = -1;
			if (timer !== null) clearTimer(timer);
			timer = null;
		},
		tick,
		get running() {
			return timer !== null;
		},
	};
}

/** LLM line through the shell's normal chat path (gateway / demo settings). */
export async function generateDjLineViaChat(prompt: string): Promise<string> {
	const [{ sendChatMessage }, { LAB_GATEWAY_URL, loadConfigWithSecrets }, llm] =
		await Promise.all([
			import("../chat-service"),
			import("../config"),
			import("../llm"),
		]);
	const config = await loadConfigWithSecrets();
	if (!config) return "";
	// Same fallbacks ChatArea uses: the kiosk seed may leave provider/model unset.
	const provider = config.provider || "nextain";
	const model = config.model || llm.getDefaultLlmModel(provider);
	if (!model) return "";
	const requestId = `web-dj-llm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	let text = "";
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, 20_000);
		sendChatMessage({
			message: prompt,
			provider: {
				provider,
				model,
				apiKey: config.apiKey,
				labGatewayUrl: provider === "nextain" ? LAB_GATEWAY_URL : undefined,
			} as never,
			history: [],
			requestId,
			enableTools: false,
			onChunk: (chunk) => {
				if (chunk.type === "text") text += chunk.text ?? "";
				else if (chunk.type === "finish" || chunk.type === "error") {
					clearTimeout(timer);
					resolve();
				}
			},
		}).catch(() => {
			clearTimeout(timer);
			resolve();
		});
	});
	return text;
}
