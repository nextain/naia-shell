import { Logger } from "../../lib/logger";

const TAG = "BlackjackStudioBridge";
export const BLACKJACK_APP_ID = "land.naia.blackjack";
export const BLACKJACK_PROJECT_SLUG = "naia-blackjack-studio";

export interface CoursewareFilePayload {
	path: string;
	content: string;
}

export interface CoursewareProvisionOutput {
	projectDir: string;
	projectSlug: string;
	writtenFiles: string[];
	skippedFiles: string[];
}

export interface TutorAskResult {
	text: string;
	fromFallback: boolean;
}

export interface BlackjackStudioBridge {
	pushContext: (
		context: { type: "blackjack_studio"; data: Record<string, unknown> } | null,
	) => void;
	speak: (
		text: string,
		onDone?: (status: string) => void,
	) => { requestId: string };
	cancelSpeak: (requestId: string) => void;
	askTutor: (
		prompt: string,
		buildFallback: () => string,
	) => Promise<TutorAskResult>;
	provisionProject: (
		files: CoursewareFilePayload[],
		overwrite: boolean,
	) => Promise<
		{ ok: true; data: CoursewareProvisionOutput } | { ok: false; error: string }
	>;
	syncFiles: (
		files: CoursewareFilePayload[],
	) => Promise<
		{ ok: true; data: CoursewareProvisionOutput } | { ok: false; error: string }
	>;
	readFiles: (
		paths: string[],
	) => Promise<
		{ ok: true; files: CoursewareFilePayload[] } | { ok: false; error: string }
	>;
	openProjectsApp: () => Promise<{ ok: boolean; error?: string }>;
	subscribeHostEvents: (handlers: {
		onLocale?: (locale: string) => void;
		onContextCleared?: () => void;
		onToolCall?: (
			tool: string,
			args: unknown,
		) =>
			| { ok: true; result: Record<string, unknown> }
			| { ok: false; error: string };
	}) => () => void;
}

let seq = 0;
function nextRequestId(prefix: string): string {
	seq += 1;
	return `${prefix}-${Date.now()}-${seq}`;
}

export function createWindowBlackjackBridge(options?: {
	unacceptedFallbackMs?: number;
	acceptedTimeoutMs?: number;
	coursewareTimeoutMs?: number;
}): BlackjackStudioBridge {
	const unacceptedFallbackMs = options?.unacceptedFallbackMs ?? 350;
	const acceptedTimeoutMs = options?.acceptedTimeoutMs ?? 90_000;
	const coursewareTimeoutMs = options?.coursewareTimeoutMs ?? 1200;

	const speechCallbacks = new Map<string, (status: string) => void>();

	const postToParent = (payload: Record<string, unknown>) => {
		try {
			window.parent.postMessage(payload, "*");
		} catch (err) {
			Logger.warn(TAG, "failed posting message to parent window", {
				error: String(err),
			});
		}
	};

	const sendCoursewareRequest = (
		type: string,
		extra: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const id = nextRequestId("cw");
		return new Promise((resolve) => {
			const onMessage = (event: MessageEvent) => {
				const d = event.data;
				if (
					!d ||
					typeof d !== "object" ||
					d.type !== "naia-courseware:result" ||
					d.id !== id
				) {
					return;
				}
				window.removeEventListener("message", onMessage);
				clearTimeout(timer);
				resolve(d as Record<string, unknown>);
			};
			const timer = setTimeout(() => {
				window.removeEventListener("message", onMessage);
				resolve({ ok: false, error: "standalone_mode" });
			}, coursewareTimeoutMs);
			window.addEventListener("message", onMessage);
			postToParent({
				type,
				id,
				appId: BLACKJACK_APP_ID,
				projectSlug: BLACKJACK_PROJECT_SLUG,
				...extra,
			});
		});
	};

	return {
		pushContext(context) {
			Logger.debug(TAG, "pushing blackjack studio context", {
				active: context !== null,
			});
			postToParent({ type: "naia-app:context", context });
		},

		speak(text, onDone) {
			const id = nextRequestId("speak");
			const clipped = text.trim().slice(0, 1950);
			if (onDone) {
				speechCallbacks.set(id, onDone);
			}
			const onSpeechEvent = (event: MessageEvent) => {
				const d = event.data;
				if (
					!d ||
					typeof d !== "object" ||
					d.type !== "naia-app:speech-result" ||
					d.id !== id
				) {
					return;
				}
				window.removeEventListener("message", onSpeechEvent);
				const cb = speechCallbacks.get(id);
				speechCallbacks.delete(id);
				cb?.(String(d.status ?? "finished"));
			};
			window.addEventListener("message", onSpeechEvent);
			postToParent({
				type: "naia-app:speak",
				appId: BLACKJACK_APP_ID,
				id,
				text: clipped,
			});
			return { requestId: id };
		},

		cancelSpeak(requestId) {
			if (!requestId) return;
			speechCallbacks.delete(requestId);
			postToParent({
				type: "naia-app:speak-cancel",
				appId: BLACKJACK_APP_ID,
				id: requestId,
			});
		},

		askTutor(prompt, buildFallback) {
			const id = nextRequestId("ask");
			const clippedPrompt = prompt.trim().slice(0, 8800);
			return new Promise<TutorAskResult>((resolve) => {
				let settled = false;
				let acceptedTimer: ReturnType<typeof setTimeout> | undefined;

				const finish = (result: TutorAskResult) => {
					if (settled) return;
					settled = true;
					window.removeEventListener("message", onMessage);
					clearTimeout(unacceptedTimer);
					if (acceptedTimer) clearTimeout(acceptedTimer);
					resolve(result);
				};

				const onMessage = (event: MessageEvent) => {
					const d = event.data;
					if (!d || typeof d !== "object" || d.id !== id) return;
					if (d.type === "naia-app:accepted") {
						clearTimeout(unacceptedTimer);
						acceptedTimer = setTimeout(() => {
							finish({ text: buildFallback(), fromFallback: true });
						}, acceptedTimeoutMs);
						return;
					}
					if (d.type === "naia-app:response") {
						const replyText = typeof d.text === "string" ? d.text.trim() : "";
						if (d.error || !replyText) {
							finish({ text: buildFallback(), fromFallback: true });
						} else {
							finish({ text: replyText, fromFallback: false });
						}
					}
				};

				const unacceptedTimer = setTimeout(() => {
					finish({ text: buildFallback(), fromFallback: true });
				}, unacceptedFallbackMs);

				window.addEventListener("message", onMessage);
				postToParent({
					type: "naia-app:ask",
					appId: BLACKJACK_APP_ID,
					id,
					prompt: clippedPrompt,
				});
			});
		},

		async provisionProject(files, overwrite) {
			const res = await sendCoursewareRequest("naia-courseware:provision", {
				files,
				overwrite,
			});
			if (res.ok === true && res.data && typeof res.data === "object") {
				const raw = res.data as Record<string, unknown>;
				return {
					ok: true,
					data: {
						projectDir: String(raw.projectDir ?? ""),
						projectSlug: String(raw.projectSlug ?? BLACKJACK_PROJECT_SLUG),
						writtenFiles: Array.isArray(raw.writtenFiles)
							? raw.writtenFiles.map(String)
							: [],
						skippedFiles: Array.isArray(raw.skippedFiles)
							? raw.skippedFiles.map(String)
							: [],
					},
				};
			}
			return { ok: false, error: String(res.error ?? "provision_failed") };
		},

		async syncFiles(files) {
			const res = await sendCoursewareRequest("naia-courseware:sync-files", {
				files,
			});
			if (res.ok === true && res.data && typeof res.data === "object") {
				const raw = res.data as Record<string, unknown>;
				return {
					ok: true,
					data: {
						projectDir: String(raw.projectDir ?? ""),
						projectSlug: String(raw.projectSlug ?? BLACKJACK_PROJECT_SLUG),
						writtenFiles: Array.isArray(raw.writtenFiles)
							? raw.writtenFiles.map(String)
							: [],
						skippedFiles: Array.isArray(raw.skippedFiles)
							? raw.skippedFiles.map(String)
							: [],
					},
				};
			}
			return { ok: false, error: String(res.error ?? "sync_failed") };
		},

		async readFiles(paths) {
			const res = await sendCoursewareRequest("naia-courseware:read-files", {
				paths,
			});
			const list = Array.isArray(res.files)
				? res.files
				: Array.isArray(res.data)
					? res.data
					: null;
			if (res.ok === true && list) {
				return {
					ok: true,
					files: list
						.filter(
							(item): item is Record<string, unknown> =>
								typeof item === "object" && item !== null,
						)
						.map((item) => ({
							path: String(item.path ?? ""),
							content: String(item.content ?? ""),
						})),
				};
			}
			return { ok: false, error: String(res.error ?? "read_failed") };
		},

		async openProjectsApp() {
			const res = await sendCoursewareRequest(
				"naia-courseware:open-projects-app",
				{},
			);
			if (res.ok === true) return { ok: true };
			return { ok: false, error: String(res.error ?? "open_failed") };
		},

		subscribeHostEvents(handlers) {
			const onMessage = (event: MessageEvent) => {
				const d = event.data;
				if (!d || typeof d !== "object") return;
				if (d.type === "naia-app:locale" && typeof d.locale === "string") {
					handlers.onLocale?.(d.locale);
					return;
				}
				if (d.type === "naia-app:context-cleared") {
					handlers.onContextCleared?.();
					return;
				}
				if (
					d.type === "naia-tool-call" &&
					typeof d.id === "string" &&
					typeof d.tool === "string" &&
					handlers.onToolCall
				) {
					const outcome = handlers.onToolCall(d.tool, d.args);
					if (outcome.ok) {
						postToParent({
							type: "naia-tool-result",
							id: d.id,
							result: outcome.result,
						});
					} else {
						postToParent({
							type: "naia-tool-result",
							id: d.id,
							error: outcome.error,
						});
					}
				}
			};
			window.addEventListener("message", onMessage);
			return () => {
				window.removeEventListener("message", onMessage);
			};
		},
	};
}
