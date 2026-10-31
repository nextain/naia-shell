import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { getAdkPath, writeNaiaConfigAtPath } from "../lib/adk-store";
import {
	sendAuthUpdate,
	sendCredsUpdate,
	sendNotifyConfig,
} from "../lib/chat-service";
import {
	type AppConfig,
	LAB_GATEWAY_URL,
	loadConfig,
	loadConfigWithSecrets,
	saveConfig,
} from "../lib/config";
import {
	fetchNaiaModelMetadata,
	gatewayServedModelIds,
	shouldMigrateNextainModel,
} from "../lib/llm/registry";
import { Logger } from "../lib/logger";
import { isWebMode } from "../lib/web-runtime/web-assets";

let startupAuthReadyNotified = false;

/**
 * A structured main role is the canonical persisted selection.
 * Gateway models are loaded dynamically and may not exist in the
 * static registry when startup migration runs.
 */
function hasExplicitStructuredMainModel(
	config: AppConfig | null | undefined,
): boolean {
	const structuredMain = config?.llmRoles?.main;
	return Boolean(
		structuredMain &&
			!structuredMain.inherit &&
			structuredMain.provider &&
			structuredMain.model,
	);
}

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
		// Older web workspaces have no selection provenance; preserve their choice.
		const allowMigration = !isWebMode() || preMigrate?.webAutoDefaultModel === true;
		const main = preMigrate?.llmRoles?.main;
		let migration: Promise<void> = Promise.resolve();
		if (
			allowMigration && main &&
			!main.inherit &&
			main.provider === "nextain" &&
			main.model === "gpt-6.1-terra"
		) {
			migration = (async () => {
				const sourceAdkPath = getAdkPath();
				const metadata = await fetchNaiaModelMetadata(LAB_GATEWAY_URL).catch(
					() => null,
				);
				const current = loadConfig();
				const role = current?.llmRoles?.main;
				if (
					getAdkPath() !== sourceAdkPath ||
					!current ||
					(isWebMode() && current.webAutoDefaultModel !== true) ||
					role?.provider !== "nextain" ||
					role.model !== "gpt-6.1-terra"
				)
					return;
				const decision = shouldMigrateNextainModel(
					"nextain",
					role.model,
					gatewayServedModelIds(metadata),
				);
				if (decision.migrate) {
					const next = {
						...current,
						model: decision.to,
						llmRoles: {
							...current.llmRoles,
							main: { ...role, model: decision.to },
						},
					};
					if (isWebMode()) await writeNaiaConfigAtPath(next as unknown as Record<string, unknown>, sourceAdkPath);
					saveConfig(next);
				}
			})();
		}
		if (preMigrate && allowMigration) {
			const decision = hasExplicitStructuredMainModel(preMigrate)
				? { migrate: false as const }
				: shouldMigrateNextainModel(preMigrate.provider, preMigrate.model);
			if (decision.migrate) {
				Logger.warn("App", "#248 model migration", {
					from: preMigrate.model,
					to: decision.to,
				});
				saveConfig({ ...preMigrate, model: decision.to });
			} else if (decision.needsCatalog) {
				migration = (async () => {
					const sourceAdkPath = getAdkPath();
					// A failed or thrown catalog fetch is "unknown": keep the choice.
					const metadata = await fetchNaiaModelMetadata(LAB_GATEWAY_URL).catch(
						() => null,
					);
					if (getAdkPath() !== sourceAdkPath) return;
					const current = loadConfig();
					if (
						!current ||
						(isWebMode() && current.webAutoDefaultModel !== true) ||
						current.provider !== preMigrate.provider ||
						current.model !== preMigrate.model ||
						hasExplicitStructuredMainModel(current)
					) {
						return;
					}
					const deferredDecision = shouldMigrateNextainModel(
						current.provider,
						current.model,
						gatewayServedModelIds(metadata),
					);
					if (deferredDecision.migrate) {
						Logger.warn("App", "#248 model migration", {
							from: current.model,
							to: deferredDecision.to,
						});
						const next = { ...current, model: deferredDecision.to };
						if (isWebMode()) await writeNaiaConfigAtPath(next as unknown as Record<string, unknown>, sourceAdkPath);
						saveConfig(next);
					}
				})();
			}
		}

		let active = true;
		async function initAuth() {
			try {
				await migration;
			} catch (error) {
				Logger.warn("App", "model migration failed", { error: String(error) });
			}
			if (!active) return;
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
