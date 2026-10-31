export interface ChatCompletionRequestWithExtraBody {
	extra_body?: {
		enable_thinking?: boolean;
	};
}

export interface EngineWithChatCompletionsLike<
	TReq extends ChatCompletionRequestWithExtraBody = ChatCompletionRequestWithExtraBody,
	TStream = unknown,
> {
	chat: {
		completions: {
			create(req: TReq): Promise<TStream>;
		};
	};
	interruptGenerate(): void | Promise<void>;
}

/**
 * WebLLM Qwen3는 `enable_thinking` (boolean) 켬/끔 두 단계만 제공한다(결정 정본 D39).
 * 옛 저장값 `low`·`high` 는 켬(`true`)으로 읽고, `off` 는 끔(`false`)으로 읽는다.
 * 시스템 프롬프트 주입 없이 `extra_body.enable_thinking` 만 제어한다.
 */
export function resolveWebChatTurnEnableThinking(
	rawLine: string | null | undefined,
	configText: string | null | undefined,
): boolean {
	const parseFlag = (obj: Record<string, unknown>): boolean | null => {
		const thinking = obj.thinking;
		if (thinking && typeof thinking === "object") {
			const lvl = (thinking as { level?: unknown }).level;
			if (lvl === "off") return false;
			if (lvl === "low" || lvl === "high" || lvl === "on") return true;
		}
		if (obj.thinkingLevel === "off") return false;
		if (
			obj.thinkingLevel === "low" ||
			obj.thinkingLevel === "high" ||
			obj.thinkingLevel === "on"
		) {
			return true;
		}
		if (typeof obj.enableThinking === "boolean") {
			return obj.enableThinking;
		}
		return null;
	};

	if (rawLine) {
		try {
			const parsed = JSON.parse(rawLine);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const fromReq = parseFlag(parsed as Record<string, unknown>);
				if (fromReq !== null) return fromReq;
			}
		} catch {
			// ignore
		}
	}

	if (configText) {
		try {
			const parsed = JSON.parse(configText);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const fromCfg = parseFlag(parsed as Record<string, unknown>);
				if (fromCfg !== null) return fromCfg;
			}
		} catch {
			// ignore
		}
	}

	return false;
}

export function wrapEngineWithEnableThinking<
	TReq extends ChatCompletionRequestWithExtraBody,
	TStream,
>(
	baseEngine: EngineWithChatCompletionsLike<TReq, TStream>,
	getEnableThinking: () => boolean,
): EngineWithChatCompletionsLike<TReq, TStream> {
	return {
		chat: {
			completions: {
				create(req: TReq) {
					return baseEngine.chat.completions.create({
						...req,
						extra_body: {
							...(req.extra_body ?? {}),
							enable_thinking: getEnableThinking(),
						},
					});
				},
			},
		},
		interruptGenerate() {
			return baseEngine.interruptGenerate();
		},
	};
}

export interface RelayPortLike {
	postMessage(data: unknown): void;
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	start(): void;
}

export function relayAgentPort(deps: {
	outer: RelayPortLike;
	inner: RelayPortLike;
	beforeChatRequest: (rawLine: string) => Promise<void>;
	diag: { log(message: string, ctx?: unknown): void };
}): { stop(): void } {
	let chain: Promise<void> = Promise.resolve();
	let stopped = false;

	const handleOuterMessage = (event: { data: unknown }) => {
		if (stopped) return;
		if (typeof event.data !== "string") {
			deps.diag.log("non-string message ignored on outer port", {
				data: event.data,
			});
			return;
		}
		const line = event.data;
		chain = chain
			.then(async () => {
				if (stopped) return;
				let isChatRequest = false;
				try {
					const parsed = JSON.parse(line);
					if (
						parsed &&
						typeof parsed === "object" &&
						parsed.type === "chat_request"
					) {
						isChatRequest = true;
					}
				} catch {
					// Invalid JSON is still forwarded
				}

				if (isChatRequest) {
					try {
						await deps.beforeChatRequest(line);
					} catch (error) {
						deps.diag.log("adk snapshot refresh failed", { error });
					}
				}

				if (!stopped) {
					deps.inner.postMessage(line);
				}
			})
			.catch((err) => {
				deps.diag.log("unexpected error in message queue", { error: err });
			});
	};

	const handleInnerMessage = (event: { data: unknown }) => {
		if (stopped) return;
		if (typeof event.data !== "string") {
			deps.diag.log("non-string message ignored on inner port", {
				data: event.data,
			});
			return;
		}
		deps.outer.postMessage(event.data);
	};

	deps.outer.addEventListener("message", handleOuterMessage);
	deps.inner.addEventListener("message", handleInnerMessage);
	deps.outer.start();
	deps.inner.start();

	const stop = () => {
		if (stopped) return;
		stopped = true;
		deps.outer.removeEventListener("message", handleOuterMessage);
		deps.inner.removeEventListener("message", handleInnerMessage);
	};

	return { stop };
}
