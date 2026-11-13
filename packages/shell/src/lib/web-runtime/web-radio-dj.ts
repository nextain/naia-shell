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

export const WEB_DJ_END_GRACE_MS = 4_000;
export const WEB_DJ_POLL_MS = 1_000;
export const WEB_DJ_MAX_CHAT_WAIT_MS = 30_000;

export type WebDjMoment =
	| { kind: "intro"; title: string }
	| { kind: "transition"; prevTitle: string; title: string }
	| { kind: "outro"; prevTitle: string; nextTitle?: string };

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

export function djPrompt(m: WebDjMoment): string {
	const base =
		"너는 개인 라디오 DJ다. 한국어로 따뜻하고 가볍게, 1~2문장만 말한다. 이모지·따옴표·목록 없이 입말로만 답한다. ";
	if (m.kind === "intro")
		return `${base}지금 막 시작한 곡의 제목은 "${m.title}"이다. 곡을 짧게 소개해라.`;
	if (m.kind === "transition")
		return `${base}방금 "${m.prevTitle}"이 끝났고 이제 "${m.title}"이 시작된다. 다음 곡으로 자연스럽게 넘어가는 멘트를 해라.`;
	return `${base}방금 "${m.prevTitle}"이 끝났다.${
		m.nextTitle ? ` 다음 곡은 "${m.nextTitle}"이다.` : ""
	} 다음 곡으로 넘어가는 짧은 멘트를 해라.`;
}

export function djFallbackLine(m: WebDjMoment): string {
	if (m.kind === "intro") return `지금 들려드릴 곡은 ${m.title}입니다.`;
	if (m.kind === "transition")
		return `${m.prevTitle}, 잘 들으셨나요? 이어서 ${m.title} 들려드릴게요.`;
	return m.nextTitle
		? `${m.prevTitle}이 끝났네요. 다음 곡은 ${m.nextTitle}입니다.`
		: `${m.prevTitle}이 끝났네요. 다음 곡으로 넘어갈게요.`;
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
		if (!snap) return;
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
			if (timer !== null) clearTimer(timer);
			timer = setTimer(tick, deps.pollMs ?? WEB_DJ_POLL_MS);
		},
		stop() {
			token += 1;
			busy = false;
			pendingEnd = null;
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
