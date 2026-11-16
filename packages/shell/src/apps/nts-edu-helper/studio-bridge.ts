import { Logger } from "../../lib/logger";

const TAG = "AxStudioBridge";
export const AX_STUDIO_APP_ID = "land.naia.nts-edu-helper";
export const AX_PROJECT_SLUG = "nts-ax-planning-studio";

export interface AxCoursewareFile {
	path: string;
	content: string;
}

export interface AxProvisionResult {
	projectDir: string;
	projectSlug: string;
	writtenFiles: string[];
	skippedFiles: string[];
}

export interface AxStudioBridge {
	pushContext: (
		context: { type: "ax_lecture_studio"; data: Record<string, unknown> } | null,
	) => void;
	speak: (
		text: string,
		onDone?: (status: string) => void,
	) => { requestId: string };
	cancelSpeak: (requestId: string) => void;
	askModel: (prompt: string) => Promise<{ ok: boolean; text: string }>;
	provisionProject: (
		files: AxCoursewareFile[],
		overwrite: boolean,
	) => Promise<
		{ ok: true; data: AxProvisionResult } | { ok: false; error: string }
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

let reqCounter = 0;
function nextId(prefix: string): string {
	reqCounter += 1;
	return `${prefix}-${Date.now()}-${reqCounter}`;
}

export function createWindowAxStudioBridge(options?: {
	unacceptedFallbackMs?: number;
	acceptedTimeoutMs?: number;
	coursewareTimeoutMs?: number;
}): AxStudioBridge {
	const unacceptedFallbackMs = options?.unacceptedFallbackMs ?? 350;
	const acceptedTimeoutMs = options?.acceptedTimeoutMs ?? 90_000;
	const coursewareTimeoutMs = options?.coursewareTimeoutMs ?? 1200;

	const postToParent = (payload: Record<string, unknown>) => {
		try {
			window.parent.postMessage(payload, "*");
		} catch (err) {
			Logger.warn(TAG, "failed posting message to parent window", {
				error: String(err),
			});
		}
	};

	const sendCourseware = (
		type: string,
		extra: Record<string, unknown>,
	): Promise<Record<string, unknown>> => {
		const id = nextId("axcw");
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
				appId: AX_STUDIO_APP_ID,
				projectSlug: AX_PROJECT_SLUG,
				...extra,
			});
		});
	};

	return {
		pushContext(context) {
			Logger.debug(TAG, "pushing ax studio context", {
				active: context !== null,
			});
			postToParent({ type: "naia-app:context", context });
		},

		speak(text, onDone) {
			const id = nextId("axspeak");
			const clipped = text.trim().slice(0, 1950);
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
				onDone?.(String(d.status ?? "finished"));
			};
			window.addEventListener("message", onSpeechEvent);
			postToParent({
				type: "naia-app:speak",
				appId: AX_STUDIO_APP_ID,
				id,
				text: clipped,
			});
			return { requestId: id };
		},

		cancelSpeak(requestId) {
			if (!requestId) return;
			postToParent({
				type: "naia-app:speak-cancel",
				appId: AX_STUDIO_APP_ID,
				id: requestId,
			});
		},

		askModel(prompt) {
			const id = nextId("axask");
			const clipped = prompt.trim().slice(0, 8800);
			return new Promise((resolve) => {
				let settled = false;
				let acceptedTimer: ReturnType<typeof setTimeout> | undefined;

				const finish = (ok: boolean, text: string) => {
					if (settled) return;
					settled = true;
					window.removeEventListener("message", onMessage);
					clearTimeout(unacceptedTimer);
					if (acceptedTimer) clearTimeout(acceptedTimer);
					resolve({ ok, text });
				};

				const onMessage = (event: MessageEvent) => {
					const d = event.data;
					if (!d || typeof d !== "object" || d.id !== id) return;
					if (d.type === "naia-app:accepted") {
						clearTimeout(unacceptedTimer);
						acceptedTimer = setTimeout(() => {
							finish(false, "");
						}, acceptedTimeoutMs);
						return;
					}
					if (d.type === "naia-app:response") {
						const txt = typeof d.text === "string" ? d.text.trim() : "";
						if (d.error || !txt) {
							finish(false, "");
						} else {
							finish(true, txt);
						}
					}
				};

				const unacceptedTimer = setTimeout(() => {
					finish(false, "");
				}, unacceptedFallbackMs);

				window.addEventListener("message", onMessage);
				postToParent({
					type: "naia-app:ask",
					appId: AX_STUDIO_APP_ID,
					id,
					prompt: clipped,
				});
			});
		},

		async provisionProject(files, overwrite) {
			const res = await sendCourseware("naia-courseware:provision", {
				files,
				overwrite,
			});
			if (res.ok === true && res.data && typeof res.data === "object") {
				const raw = res.data as Record<string, unknown>;
				return {
					ok: true,
					data: {
						projectDir: String(raw.projectDir ?? ""),
						projectSlug: String(raw.projectSlug ?? AX_PROJECT_SLUG),
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

		async openProjectsApp() {
			const res = await sendCourseware(
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
