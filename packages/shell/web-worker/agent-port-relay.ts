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
