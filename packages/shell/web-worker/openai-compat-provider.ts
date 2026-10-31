// adapters/openai-compat-provider — 실 ProviderPort (이식: old providers/zai.ts·openai.ts).
// OpenAI-호환 /chat/completions SSE 스트림(GLM coding plan·openai·vllm 공용). openai SDK 대신 raw fetch(deps 최소).
// UC1 per-chunk 스트리밍(delta.content) + UC5 slice 1b tool_calls(계약 §C: tools 전송 + delta.tool_calls 재조립).
// apiKey/baseUrl=주입(키는 wire 아님, env/CredentialPort). 실 검증=클라우드(GPU 불요).
import type { ProviderPort, ProviderChatOpts } from "@naia-agent/ports/uc1.js";
import type {
	ProviderConfig,
	ChatMessage,
	ProviderChunk,
} from "@naia-agent/domain/chat.js";

type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<{
	ok: boolean;
	status: number;
	statusText: string;
	body: {
		getReader(): {
			read(): Promise<{ done: boolean; value?: Uint8Array }>;
			cancel?(): Promise<void> | void;
		};
	} | null;
}>;

/** ChatMessage[] → OpenAI wire messages (§C.1). assistant.toolCalls·tool role 매핑, content null 규약. */
function toWireMessages(
	systemPrompt: string | undefined,
	messages: readonly ChatMessage[],
	opts?: { echoReasoningContent?: boolean },
): Array<Record<string, unknown>> {
	const wire: Array<Record<string, unknown>> = [];
	if (systemPrompt) wire.push({ role: "system", content: systemPrompt });
	for (const m of messages) {
		if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
			wire.push({
				role: "assistant",
				content: m.content === "" ? null : m.content, // content "" + toolCalls → null (OpenAI 규약)
				tool_calls: m.toolCalls.map((c) => ({
					id: c.id,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				})),
				...(opts?.echoReasoningContent && m.reasoningContent
					? { reasoning_content: m.reasoningContent }
					: {}),
			});
		} else if (m.role === "tool") {
			if (!m.toolCallId) throw new Error("tool message missing toolCallId"); // §C.1 — skip 금지(대응 깨짐)
			wire.push({
				role: "tool",
				tool_call_id: m.toolCallId,
				content: m.content,
			});
		} else {
			const content = m.inlineImages?.length
				? [
						...(m.content ? [{ type: "text", text: m.content }] : []),
						...m.inlineImages.map((image) => ({
							type: "image_url",
							image_url: {
								url: `data:${image.mimeType};base64,${image.data}`,
								detail: "auto",
							},
						})),
					]
				: m.content;
			wire.push({ role: m.role, content });
		}
	}
	return wire;
}

interface ToolAcc {
	id?: string;
	name?: string;
	args: string;
	excluded: boolean;
	conflict: boolean;
	wire?: number;
}

type ErrorBody = NonNullable<Awaited<ReturnType<FetchLike>>["body"]>;

const ERROR_BODY_READ_TIMEOUT_MS = 2000;

/** Consume a non-OK body (cap 4096) so the socket is not left dangling, then return it. */
async function readErrorBody(body: ErrorBody): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let s = "";
	const deadline = new Promise<{ done: true; value?: undefined }>((res) => {
		const t = setTimeout(() => res({ done: true }), ERROR_BODY_READ_TIMEOUT_MS);
		(t as { unref?: () => void }).unref?.();
	});
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), deadline]);
			if (done) break;
			if (value) s += decoder.decode(value, { stream: true });
			if (s.length > 4096) break;
		}
		s += decoder.decode();
	} catch {
		/* diagnostic */
	}
	try {
		await reader.cancel?.();
	} catch {
		/* isolate */
	}
	return s.slice(0, 4096);
}

/** FastAPI `detail` or OpenAI `error.message`; empty when the body has neither. */
function extractHttpErrorDetail(source: unknown): string {
	if (typeof source === "string") {
		const text = source.trim();
		if (!text) return "";
		try {
			return extractHttpErrorDetail(JSON.parse(text) as unknown);
		} catch {
			return text.slice(0, 300);
		}
	}
	if (!source || typeof source !== "object") return "";
	const o = source as Record<string, unknown>;
	if (typeof o.detail === "string" && o.detail.trim()) return o.detail.trim();
	const err = o.error;
	if (typeof err === "string" && err.trim()) return err.trim();
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message.trim();
	}
	return "";
}

function formatCompatHttpError(
	base: string,
	status: number,
	statusText: string,
	detail: string,
): string {
	const extra = detail ? `: ${detail}` : "";
	return `OpenAI-compat ${base} failed: ${status} ${statusText}${extra}`;
}

/** #114 — 스트림 idle 데드라인: 마지막 청크 수신 후 이 시간 동안 무수신이면 abort(게이트웨이가 종료
 *  신호를 안 줄 때 턴 영구 hang 방지). 총시간 상한이 **아니다** — 정상 장문 스트림은 청크가 계속 오므로 안 끊긴다. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

type ThinkTagFlavor = "angle" | "bracket";
// deepseek(lab-proxy 게이트웨이)는 reasoning 을 content 스트림에 대괄호 [THINK]...[/THINK] 로 싣는다(#114 실측
// — 미닫힘 스트림도 관측됨). 꺾쇠 <think> 와 **대칭**으로 인식하되, 연 flavor 와 같은 flavor 의 닫는 태그만 닫는다.
// 트레이드오프(계약, 테스트로 명시): 본문 중간의 literal "[think]"/"<think>" 도 태그로 해석된다 — 오인 시 이후
// 내용이 thinking 으로 흘러 사용자에게 안 보일 수 있으나, thinking 원문이 text 로 새는 사고(#114 본질)는 없다(fail-safe).
const THINK_OPEN_TAGS: readonly {
	readonly flavor: ThinkTagFlavor;
	readonly tag: string;
}[] = [
	{ flavor: "angle", tag: "<think>" },
	{ flavor: "bracket", tag: "[think]" },
];
const THINK_CLOSE_TAGS: Record<ThinkTagFlavor, string> = {
	angle: "</think>",
	bracket: "[/think]",
};

/** buffer 끝이 tags 중 하나의 진성 접두(부분 태그)면 보류할 최대 길이(청크 경계 버퍼링 — 기존 메커니즘 일반화). */
function partialTagSuffixLen(
	lowerBuffer: string,
	tags: readonly string[],
): number {
	let retain = 0;
	for (const tag of tags) {
		for (
			let n = Math.min(lowerBuffer.length, tag.length - 1);
			n > retain;
			n--
		) {
			if (tag.startsWith(lowerBuffer.slice(-n))) {
				retain = n;
				break;
			}
		}
	}
	return retain;
}

class ThinkingTagFilter {
	private buffer = "";
	private thinking: ThinkTagFlavor | undefined;
	push(value: string): ProviderChunk[] {
		this.buffer += value;
		const out: ProviderChunk[] = [];
		while (this.buffer) {
			const lower = this.buffer.toLowerCase();
			if (this.thinking) {
				const tag = THINK_CLOSE_TAGS[this.thinking];
				const at = lower.indexOf(tag);
				if (at >= 0) {
					const content = this.buffer.slice(0, at);
					if (content) out.push({ kind: "thinking", text: content });
					this.buffer = this.buffer.slice(at + tag.length);
					this.thinking = undefined;
					continue;
				}
				const retain = partialTagSuffixLen(lower, [tag]);
				const content = this.buffer.slice(0, this.buffer.length - retain);
				if (content) out.push({ kind: "thinking", text: content });
				this.buffer = this.buffer.slice(this.buffer.length - retain);
				break;
			}
			let hit: { at: number; flavor: ThinkTagFlavor; len: number } | undefined;
			for (const { flavor, tag } of THINK_OPEN_TAGS) {
				const at = lower.indexOf(tag);
				if (at >= 0 && (hit === undefined || at < hit.at))
					hit = { at, flavor, len: tag.length };
			}
			if (hit) {
				const content = this.buffer.slice(0, hit.at);
				if (content) out.push({ kind: "text", text: content });
				this.buffer = this.buffer.slice(hit.at + hit.len);
				this.thinking = hit.flavor;
				continue;
			}
			const retain = partialTagSuffixLen(
				lower,
				THINK_OPEN_TAGS.map((t) => t.tag),
			);
			const content = this.buffer.slice(0, this.buffer.length - retain);
			if (content) out.push({ kind: "text", text: content });
			this.buffer = this.buffer.slice(this.buffer.length - retain);
			break;
		}
		return out;
	}
	/** 스트림 종료: 미닫힘 thinking 잔여는 **thinking 으로** flush — 원문을 text 로 노출하지 않는다(#114). */
	flush(): ProviderChunk[] {
		const content = this.buffer;
		this.buffer = "";
		if (!content) return [];
		return [
			this.thinking
				? { kind: "thinking", text: content }
				: { kind: "text", text: content },
		];
	}
}

/**
 * baseUrl 예: https://api.z.ai/api/coding/paas/v4 (GLM coding plan). apiKey=Bearer.
 * model(옵션): config.model 이 백엔드 카탈로그에 없을 때 강제. 미지정 시 config.model.
 * auth(옵션): "bearer"(기본, Authorization: Bearer) | "x-anyllm"(naia 게이트웨이 lab-proxy, X-AnyLLM-Key).
 * supportsReasoningEffort(옵션, UC-THINKING/FR-THINK-3): 백엔드가 `reasoning_effort` 를 받을 수 있는가.
 *   **resolver 가 판단해 주입한다**(어댑터는 baseUrl 을 스스로 해석하지 않음 — 라우팅 판단=domain).
 *   true 인 경우에만 `enableThinking===false` 를 wire 로 반영한다. 미지정=false(보수적).
 */
export async function buildPromptCacheShard(
	model: string,
	systemPrompt: string | undefined,
): Promise<string> {
	// Hash exact UTF-8 bytes. Normalizing whitespace or Unicode could merge two
	// prefixes that Azure itself treats as different cache entries.
	const input = JSON.stringify([model, systemPrompt ?? ""]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return `agent-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** #122 — 누적 args 에서 첫 완결 JSON 값과 잔여를 분리(문자열·이스케이프 인지). 실패 시 null. */
function splitFirstJsonValue(
	raw: string,
): { value: string; rest: string } | null {
	const t = raw.trimStart();
	const open = t[0];
	if (open !== "{" && open !== "[") return null;
	const close = open === "{" ? "}" : "]";
	let depth = 0,
		inStr = false,
		esc = false;
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (inStr) {
			if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0)
				return { value: t.slice(0, i + 1), rest: t.slice(i + 1) };
		}
	}
	return null;
}

export function makeOpenAICompatProvider(deps: {
	baseUrl: string;
	apiKey: string;
	model?: string;
	auth?: "bearer" | "x-anyllm";
	supportsReasoningEffort?: boolean;
	supportsThinkingLevel?: boolean;
	echoReasoningContent?: boolean;
	supportsTools?: boolean;
	promptCacheShard?: boolean;
	maxTokens?: number;
	idleTimeoutMs?: number;
	fetch?: FetchLike;
}): ProviderPort {
	const doFetch: FetchLike =
		deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const base = deps.baseUrl.replace(/\/+$/, "");
	// ⚠️ x-anyllm(naia lab-proxy): 게이트웨이는 `Bearer <token>` 형식 요구(old lab-proxy.ts 와 동일).
	//    "Bearer " 누락 시 401 "Invalid header format. Expected 'Bearer <token>'"(실 게이트웨이로 확인 2026-06-12).
	const authHeader: Record<string, string> =
		deps.auth === "x-anyllm"
			? { "X-AnyLLM-Key": `Bearer ${deps.apiKey}` }
			: { Authorization: `Bearer ${deps.apiKey}` };
	return {
		async *chat(
			config: ProviderConfig,
			messages: readonly ChatMessage[],
			opts: ProviderChatOpts,
		): AsyncIterable<ProviderChunk> {
			const wireMsgs = toWireMessages(opts.systemPrompt, messages, {
				echoReasoningContent: deps.echoReasoningContent,
			}); // tool 메시지 toolCallId 누락 시 throw(§C.1)
			const toolsBody =
				deps.supportsTools !== false && opts.tools && opts.tools.length > 0
					? opts.tools.map((s) => ({
							type: "function",
							function: {
								name: s.name,
								description: s.description,
								parameters: s.parameters,
							},
						}))
					: undefined;
			// UC-THINKING / FR-THINK-1·2 — 추론 모델이 생각(reasoning)에 출력 토큰을 다 쓰고 **본문을 못 내는**
			//   현상 차단(실측: 빈 응답의 finish_reason 은 length 가 아니라 stop → 컨텍스트를 키워도 안 낫는다).
			//   OpenAI-compat wire 에서 듣는 스위치는 `reasoning_effort:"none"` 뿐(think:false·chat_template_kwargs·
			//   /no_think 전부 무시됨 — 2026-07-14 ollama 0.32.0 실측).
			//   ⚠️ **로컬 엔진에만**(supportsReasoningEffort) — 셸이 설정을 저장했을 때만 enableThinking:false 를 전송하므로
			//      게이트 없이 붙이면 gpt-4o 등 비추론 원격 모델이 400 난다(FR-THINK-2).
			//   enableThinking 이 true/미지정이면 아무 것도 싣지 않는다(무회귀 — 추론 모델 기본=생각 켬).
			// FR-THINK-9: 게이트웨이 경로(supportsThinkingLevel)는 low/high 일 때만 reasoning_effort 전송. off/미지정은 무전송.
			// 둘이 동시에 켜질 수 없음을 코드로 보장(게이트웨이 경로는 supportsReasoningEffort=false).
			const requestModel = deps.model ?? config.model;
			const thinkingLevelBody =
				deps.supportsThinkingLevel &&
				(requestModel === "gpt-6.1-terra" || requestModel === "gpt-5.6-luna")
					? { reasoning_effort: "xhigh" as const }
					:
				deps.supportsThinkingLevel &&
				(config.thinkingLevel === "low" || config.thinkingLevel === "high")
					? { reasoning_effort: config.thinkingLevel }
					: undefined;
			const noThinkBody =
				!deps.supportsThinkingLevel &&
				deps.supportsReasoningEffort === true &&
				config.enableThinking === false
					? { reasoning_effort: "none" as const }
					: undefined;
			const promptCacheBody =
				deps.promptCacheShard === true
					? {
							prompt_cache_key: await buildPromptCacheShard(
								requestModel,
								opts.systemPrompt,
							),
						}
					: undefined;

			const resp = await doFetch(`${base}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeader },
				body: JSON.stringify({
					model: requestModel,
					messages: wireMsgs,
					stream: true,
					stream_options: { include_usage: true },
					...(deps.maxTokens ? { max_tokens: deps.maxTokens } : {}),
					...(toolsBody ? { tools: toolsBody } : {}),
					...(noThinkBody ?? {}),
					...(thinkingLevelBody ?? {}),
					...(promptCacheBody ?? {}),
				}),
				...(opts.signal ? { signal: opts.signal } : {}),
			});
			if (!resp.ok || !resp.body) {
				// ⚠️ 비-OK(429/403/404 등)도 응답 본문이 딸려온다 — throw 전 **반드시 소비/취소**한다. 안 그러면 undici
				//    소켓이 dangling 으로 남아, 호스트가 곧장 process.exit() 하는 경로(CLI once-mode)에서 libuv
				//    "UV_HANDLE_CLOSING"(async.c) 어설션 크래시를 유발(실 키 round-trip 테스트로 적발 2026-06-26).
				//    성공 경로는 아래 finally(reader.cancel)가 정리하나, 이 early-throw 는 reader 생성 전이라 누락됐었음.
				const errText = resp.body ? await readErrorBody(resp.body) : "";
				throw new Error(
					formatCompatHttpError(
						base,
						resp.status,
						resp.statusText,
						extractHttpErrorDetail(errText),
					),
				);
			}

			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let inTok = 0,
				outTok = 0;
			let finishReason: string | undefined;
			const thinkingFilter = new ThinkingTagFilter();
			const acc = new Map<number, ToolAcc>(); // 슬롯 별 tool_call 누적(§C.2)
			// #122 — any-llm(deepseek) 게이트웨이는 호출마다 wire index 를 0 으로 재사용한다(2026-08-29
			//        스트림 실측: get_time·get_weather 둘 다 index 0). 같은 index 에 '비어있지 않은 다른 id'가
			//        도착하면 손상이 아니라 **새 호출의 경계**다(OpenAI 규격 스트림은 id 를 호출 첫 델타에만
			//        싣는다) — wire index → 현재 슬롯 매핑을 갈아끼워 별도 호출로 누적한다.
			const slotByWireIndex = new Map<number, number>();
			let nextSlot = 0;

			// SSE data json 1건 처리: content → 즉시 text chunk 반환. tool_calls/usage → 누적(side effect). error → throw.
			const parseData = (payload: string): ProviderChunk[] => {
				const t = payload.trim();
				if (!t || t === "[DONE]") return [];
				let evt: unknown;
				try {
					evt = JSON.parse(t);
				} catch {
					return [];
				} // 손상 SSE 줄 skip
				if (!evt || typeof evt !== "object") return [];
				const o = evt as {
					choices?: {
						finish_reason?: unknown;
						delta?: {
							content?: string;
							reasoning_content?: string;
							reasoning?: { content?: string };
							tool_calls?: Array<{
								index?: unknown;
								id?: unknown;
								type?: unknown;
								function?: { name?: unknown; arguments?: unknown };
							}>;
						};
					}[];
					usage?: { prompt_tokens?: number; completion_tokens?: number };
					error?: unknown;
				};
				if (o.error)
					throw new Error(
						`OpenAI-compat stream error: ${JSON.stringify(o.error)}`,
					);
				const out: ProviderChunk[] = [];
				const rawFinishReason = o.choices?.[0]?.finish_reason;
				if (typeof rawFinishReason === "string" && rawFinishReason !== "")
					finishReason = rawFinishReason;
				const delta = o.choices?.[0]?.delta;
				const thinkingText =
					typeof delta?.reasoning_content === "string"
						? delta.reasoning_content
						: typeof delta?.reasoning?.content === "string"
							? delta.reasoning.content
							: undefined;
				if (thinkingText) out.push({ kind: "thinking", text: thinkingText });
				if (delta?.content) out.push(...thinkingFilter.push(delta.content));
				const tcs = delta?.tool_calls;
				if (Array.isArray(tcs)) {
					for (const tc of tcs) {
						const idx = tc.index;
						if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0)
							throw new Error("invalid tool_call index"); // §C.2 누적 전 검증
						let slot = slotByWireIndex.get(idx);
						let a = slot === undefined ? undefined : acc.get(slot);
						// #122 — 다른 nonempty id = 새 호출 경계: 이 wire index 의 새 슬롯을 연다.
						if (
							a !== undefined &&
							typeof tc.id === "string" &&
							tc.id !== "" &&
							a.id !== undefined &&
							a.id !== tc.id
						) {
							a = undefined;
							slot = undefined;
						}
						if (a === undefined) {
							slot = nextSlot++;
							slotByWireIndex.set(idx, slot);
							a = { args: "", excluded: false, conflict: false, wire: idx };
							acc.set(slot, a);
						}
						if (tc.type !== undefined && tc.type !== "function")
							a.excluded = true; // present 이면서 "function" 아님(null/number/타 문자열 포함) = 미지원

						if (a.excluded) continue; // excluded slot = 이후 모든 필드 무시
						if (typeof tc.id === "string" && tc.id !== "") {
							a.id = tc.id; // 경계 감지 후이므로 여기서는 항상 동일 id 이거나 첫 지정
						}
						const fn = tc.function;
						if (fn) {
							if (typeof fn.name === "string" && fn.name !== "") {
								if (a.name !== undefined && a.name !== fn.name)
									a.conflict = true;
								else a.name = fn.name;
							}
							if (typeof fn.arguments === "string") a.args += fn.arguments; // 조각 이어붙임
						}
					}
				}
				if (o.usage) {
					inTok = o.usage.prompt_tokens ?? inTok;
					outTok = o.usage.completion_tokens ?? outTok;
				} // 호출 누계 스냅샷
				return out;
			};

			// 단일 finalize(§C.2): abort commit-point → parse-all-then-yield 원자 → toolUse → usage → finish.
			const finalize = function* (): Generator<ProviderChunk> {
				if (opts.signal?.aborted) return; // commit point: abort 면 배치 전체 미yield
				yield* thinkingFilter.flush();
				if (finishReason === "length" || finishReason === "max_tokens") {
					throw new Error(
						`OpenAI-compat response truncated by provider (finish_reason=${finishReason})`,
					);
				}
				const indices = [...acc.keys()]
					.filter((i) => !acc.get(i)!.excluded)
					.sort((x, y) => x - y);
				// 1차: provider 제공 id 중복 거부 + used 집합 구성(합성 id 충돌 회피용).
				const used = new Set<string>();
				for (const i of indices) {
					const a = acc.get(i)!;
					if (a.id !== undefined && a.id !== "") {
						if (used.has(a.id)) throw new Error("duplicate tool_call id"); // §C.2
						used.add(a.id);
					}
				}
				// 2차: 전부 검증해 완성 배열(이 단계 throw = yield 0건). 통과 후에만 일괄 yield.
				const built: { id: string; name: string; args: unknown }[] = [];
				for (const i of indices) {
					const a = acc.get(i)!;
					if (a.conflict) throw new Error("conflicting tool_call id/name"); // §C.2
					if (a.name === undefined || a.name === "")
						throw new Error("tool_call missing name"); // 빈 name = 손상
					let args: unknown;
					if (a.args === "")
						args = {}; // 인자 없는 도구
					else {
						let p: unknown;
						try {
							p = JSON.parse(a.args);
						} catch {
							// #122 — any-llm(deepseek) 게이트웨이가 유효 args 뒤에 스퓨리어스 `\"\"` 조각을 덧붙인다
							//        (무인자 도구 실측: 조각 "" → {} → "\"\"" ⇒ 누적 `{}\"\"`). 첫 완결 JSON 값을 취하고
							//        잔여가 내용 없는 따옴표/공백/쉼표뿐일 때만 수용 — 내용 있는 잔여는 기존대로 fail-closed.
							const split = splitFirstJsonValue(a.args);
							if (split !== null && /^[\s",]*$/.test(split.rest)) {
								try {
									p = JSON.parse(split.value);
								} catch {
									throw new Error(
										`malformed tool_call arguments (name=${a.name}, head=${JSON.stringify(a.args.slice(0, 160))})`,
									);
								}
							} else {
								throw new Error(
									`malformed tool_call arguments (name=${a.name}, head=${JSON.stringify(a.args.slice(0, 160))}, tail=${JSON.stringify(a.args.slice(-80))})`,
								);
							}
						}
						if (!p || typeof p !== "object" || Array.isArray(p))
							throw new Error("tool_call arguments not an object"); // plain object 강제
						args = p;
					}
					let id = a.id;
					if (id === undefined || id === "") {
						// 빈 id → 배치 내 유일 합성(wire index 기준 — §C.2)
						const seed = a.wire ?? i;
						let cand = `call_${seed}`;
						let n = 1;
						while (used.has(cand)) cand = `call_${seed}_${n++}`;
						used.add(cand);
						id = cand;
					}
					built.push({ id, name: a.name, args });
				}
				for (const b of built)
					yield { kind: "toolUse", id: b.id, name: b.name, args: b.args };
				if (inTok > 0 || outTok > 0)
					yield { kind: "usage", inputTokens: inTok, outputTokens: outTok };
				yield { kind: "finish" };
			};

			const idleTimeoutMs = deps.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
			// #114 — 마지막 청크 수신 후 idle 데드라인 race. 초과 시 throw → runRound catch → rejected → terminal error
			//   (기존 abort/에러 배선 재사용). finally 의 reader.cancel() 이 연결을 정리한다. 총시간 기준이 아니므로
			//   청크가 계속 오는 정상 장문 스트림은 절단되지 않는다.
			const readWithIdleDeadline = async (): Promise<{
				done: boolean;
				value?: Uint8Array;
			}> => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					return await Promise.race([
						reader.read(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error(
											`OpenAI-compat stream idle for ${idleTimeoutMs}ms — no data and no termination signal from provider`,
										),
									),
								idleTimeoutMs,
							);
						}),
					]);
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};

			try {
				let sawDone = false;
				outer: for (;;) {
					const { done, value } = await readWithIdleDeadline();
					if (done) break;
					if (value) buffer += decoder.decode(value, { stream: true });
					let nl: number;
					while ((nl = buffer.indexOf("\n")) !== -1) {
						const line = buffer.slice(0, nl);
						buffer = buffer.slice(nl + 1);
						const s = line.trim();
						if (!s.startsWith("data:")) continue;
						if (s.slice(5).trim() === "[DONE]") {
							sawDone = true;
							break outer;
						} // [DONE]=종료(read 영구대기 방지)
						for (const c of parseData(s.slice(5))) yield c; // content text 즉시 방출
					}
				}
				if (!sawDone) {
					// [DONE] 없이 EOF → trailing 처리
					buffer += decoder.decode();
					const last = buffer.trim();
					if (last.startsWith("data:") && last.slice(5).trim() !== "[DONE]") {
						for (const c of parseData(last.slice(5))) yield c;
					}
				}
				yield* finalize(); // 단일 finalize(toolUse→usage→finish, abort-gated)
			} finally {
				try {
					await reader.cancel?.();
				} catch {
					/* 격리 */
				}
			}
		},
	};
}
