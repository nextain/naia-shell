import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import {
	sendAuthUpdate,
	sendCredsUpdate,
	sendNotifyConfig,
} from "../lib/chat-service";
import { getAdkPath } from "../lib/adk-store";
import { loadConfig, loadConfigWithSecrets, saveConfig } from "../lib/config";
import {
	shouldMigrateCodexModel,
	shouldMigrateNextainModel,
} from "../lib/llm/registry";
import { Logger } from "../lib/logger";

let startupAuthReadyNotified = false;

function notifyNaiaAuthReady(source: "startup" | "auth-complete"): void {
	if (source === "startup") {
		if (startupAuthReadyNotified) return;
		startupAuthReadyNotified = true;
	}
	window.dispatchEvent(
		new CustomEvent("naia_auth_ready", { detail: { source } }),
	);
}

export function useAgentAuthSync(
	showAdkSetup: boolean,
	showOnboarding: boolean,
	configHydrated: boolean,
): void {
	useEffect(() => {
		if (showAdkSetup || showOnboarding || !configHydrated) return;
		const preMigrate = loadConfig();
		if (preMigrate) {
			// A structured main role is the canonical persisted selection.
			// Gateway models are loaded dynamically and may not exist in the
			// static registry when startup migration runs.
			const structuredMain = preMigrate.llmRoles?.main;
			const hasExplicitStructuredMainModel = Boolean(
				structuredMain &&
					!structuredMain.inherit &&
					structuredMain.provider &&
					structuredMain.model,
			);
			let next = preMigrate;
			let changed = false;
			const nextain = hasExplicitStructuredMainModel
				? { migrate: false as const }
				: shouldMigrateNextainModel(
						preMigrate.provider,
						preMigrate.model,
					);
			if (nextain.migrate) {
				Logger.warn("App", "#248 model migration", {
					from: preMigrate.model,
					to: nextain.to,
				});
				next = { ...next, model: nextain.to };
				changed = true;
			}
			const codexFlat = shouldMigrateCodexModel(next.provider, next.model);
			if (codexFlat.migrate) {
				Logger.warn("App", "#641 Codex model migration", {
					from: next.model,
					to: codexFlat.to,
				});
				next = { ...next, model: codexFlat.to };
				changed = true;
			}
			const main = next.llmRoles?.main;
			if (main && !main.inherit && main.provider && main.model) {
				const codexMain = shouldMigrateCodexModel(main.provider, main.model);
				if (codexMain.migrate) {
					Logger.warn("App", "#641 Codex main-role migration", {
						from: main.model,
						to: codexMain.to,
					});
					next = {
						...next,
						llmRoles: {
							...next.llmRoles,
							main: { ...main, model: codexMain.to },
						},
					};
					changed = true;
				}
			}
			if (changed) saveConfig(next);
		}

		let active = true;
		async function initAuth() {
			// Capture the selected ADK before the first await.  A switch while the
			// config/secret load is pending must not label A's snapshot as B.
			const sourceAdkPath = getAdkPath();
			let cfg: Awaited<ReturnType<typeof loadConfigWithSecrets>>;
			try {
				cfg = await loadConfigWithSecrets();
			} catch (error) {
				Logger.warn("App", "initAuth config restore failed", {
					error: String(error),
				});
				return;
			}
			if (!cfg || !active) return;
			if (getAdkPath() !== sourceAdkPath) {
				Logger.warn("App", "initAuth ADK changed during config restore", {
					sourceAdkPath,
					currentAdkPath: getAdkPath(),
				});
				return;
			}

			if (cfg.naiaKey) {
				await invoke("store_startup_message", {
					adkPath: sourceAdkPath,
					message: JSON.stringify({
						type: "auth_update",
						naiaKey: cfg.naiaKey,
					}),
				}).catch(() => {});
				if (active)
					await sendAuthUpdate(cfg.naiaKey, sourceAdkPath).catch(() => {});
				if (active) notifyNaiaAuthReady("startup");
			}
			if (!active) return;

			const notifyPayload = {
				slackWebhookUrl: cfg.slackWebhookUrl,
				googleChatWebhookUrl: cfg.googleChatWebhookUrl,
			};
			await invoke("store_startup_message", {
				adkPath: sourceAdkPath,
				message: JSON.stringify({ type: "notify_config", ...notifyPayload }),
			}).catch(() => {});
			if (active)
				await sendNotifyConfig(notifyPayload, sourceAdkPath).catch(() => {});
			if (!active) return;

			const credsPayload = {
				keys:
					cfg.apiKey && cfg.provider && cfg.provider !== "nextain"
						? { [cfg.provider]: cfg.apiKey }
						: {},
				ttsKeys: {},
				...(cfg.gatewayToken !== undefined && {
					gatewayToken: cfg.gatewayToken,
				}),
			};
			await invoke("store_startup_message", {
				adkPath: sourceAdkPath,
				message: JSON.stringify({ type: "creds_update", ...credsPayload }),
			}).catch(() => {});
			if (active)
				await sendCredsUpdate(credsPayload, sourceAdkPath).catch(() => {});
		}

		void initAuth();
		return () => {
			active = false;
		};
	}, [showAdkSetup, showOnboarding, configHydrated]);
}
