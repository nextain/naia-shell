import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { syncLinkedChannels } from "../lib/channel-sync";
import {
	sendAuthUpdate,
	sendCredsUpdate,
	sendNotifyConfig,
} from "../lib/chat-service";
import { getAdkPath } from "../lib/adk-store";
import { loadConfig, loadConfigWithSecrets, saveConfig } from "../lib/config";
import { shouldMigrateNextainModel } from "../lib/llm/registry";
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
		const unlisten = listen<{ naiaKey?: string }>(
			"naia_auth_complete",
			() => {
				// The mounted login owner (SettingsTab, OnboardingWizard, or
				// AdkSetupScreen) captures the ADK that opened the browser flow.
				// This app-wide listener must not replay a callback against whatever
				// ADK is selected now: a late A callback arriving after an A→B
				// switch would otherwise be sent to B.
				void syncLinkedChannels();
			},
		);
		return () => {
			void unlisten.then((fn) => fn());
		};
	}, []);

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
			const decision = hasExplicitStructuredMainModel
				? { migrate: false as const }
				: shouldMigrateNextainModel(
						preMigrate.provider,
						preMigrate.model,
					);
			if (decision.migrate) {
				Logger.warn("App", "#248 model migration", {
					from: preMigrate.model,
					to: decision.to,
				});
				saveConfig({ ...preMigrate, model: decision.to });
			}
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
				discordWebhookUrl: cfg.discordWebhookUrl,
				googleChatWebhookUrl: cfg.googleChatWebhookUrl,
				discordDefaultUserId: cfg.discordDefaultUserId,
				discordDefaultTarget: cfg.discordDefaultTarget,
				discordDmChannelId: cfg.discordDmChannelId,
			};
			await invoke("store_startup_message", {
				adkPath: sourceAdkPath,
				message: JSON.stringify({ type: "notify_config", ...notifyPayload }),
			}).catch(() => {});
			if (active)
				await sendNotifyConfig(notifyPayload, sourceAdkPath).catch(() => {});
			if (!active) return;

			const ttsKeys: Record<string, string> = {};
			if (cfg.googleApiKey) ttsKeys.google = cfg.googleApiKey;
			if (cfg.openaiTtsApiKey) ttsKeys.openai = cfg.openaiTtsApiKey;
			if (cfg.elevenlabsApiKey) ttsKeys.elevenlabs = cfg.elevenlabsApiKey;
			const credsProvider =
				cfg.provider === "nextain" ? "naia-anyllm" : cfg.provider;
			const credsPayload = {
				keys: cfg.apiKey && cfg.provider ? { [credsProvider]: cfg.apiKey } : {},
				...(Object.keys(ttsKeys).length > 0 && { ttsKeys }),
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
