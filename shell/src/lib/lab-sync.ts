import { agentLabProxyRequest, resolveAuthMode } from "./agent-ipc";
import type { AppConfig } from "./config";
import { normalizeSpeechStyle } from "./config";
import { Logger } from "./logger";

// Phase 6b (#337): routed through agent lab proxy. Agent injects the
// X-AnyLLM-Key header; shell forwards only X-User-Id since the BFF still
// scopes config records by user.
const LAB_API_PATH = "/api/gateway/config";

/** Fields synced to/from Lab — excludes secrets (apiKey, gatewayToken, etc.) and local paths */
export const LAB_SYNC_FIELDS = [
	"provider",
	"model",
	"locale",
	"theme",
	"backgroundImage",
	"vrmModel",
	"sttProvider",
	"sttModel",
	"naiaCloudSttBackend",
	"ttsEnabled",
	"ttsVoice",
	"ttsProvider",
	"ttsEngine",
	"naiaCloudTtsBackend",
	"persona",
	"userName",
	"agentName",
	"honorific",
	"speechStyle",
	"enableTools",
	"chatRouting",
	"disabledSkills",
	"discordDefaultUserId",
	"discordDefaultTarget",
	"discordDmChannelId",
	"slackWebhookUrl",
	"discordWebhookUrl",
	"googleChatWebhookUrl",
	"panelPosition",
	"panelVisible",
	"liveProvider",
	"liveVoice",
	"liveModel",
	"voiceConversation",
] as const;

type SyncField = (typeof LAB_SYNC_FIELDS)[number];
type SyncConfig = Pick<AppConfig, SyncField>;

function pickSyncFields(config: Partial<AppConfig>): Partial<SyncConfig> {
	const result: Record<string, unknown> = {};
	for (const key of LAB_SYNC_FIELDS) {
		if (key in config && config[key] !== undefined) {
			result[key] = config[key];
		}
	}
	return result as Partial<SyncConfig>;
}

/**
 * Fetch config from Lab via BFF API.
 *
 * #337 Phase 6b: `naiaKey` parameter is no longer used for auth — the agent
 * injects X-AnyLLM-Key server-side. It is retained in the signature for
 * call-site stability and will be dropped in Phase 6c when callers stop
 * threading the key around.
 */
export async function fetchLabConfig(
	_naiaKey: string,
	naiaUserId: string,
): Promise<Partial<SyncConfig> | null> {
	try {
		const resp = await agentLabProxyRequest({
			mode: resolveAuthMode(),
			method: "GET",
			path: LAB_API_PATH,
			headers: { "X-User-Id": naiaUserId },
		});
		if (!resp.ok) return null;
		const data = (resp.body ?? {}) as {
			config?: Record<string, unknown> | null;
		};
		const raw = data?.config;
		if (!raw || typeof raw !== "object") return null;
		const synced = pickSyncFields(raw as Partial<AppConfig>);
		if (synced.speechStyle) {
			synced.speechStyle = normalizeSpeechStyle(synced.speechStyle);
		}
		return synced;
	} catch (err) {
		Logger.warn("lab-sync", "fetchLabConfig failed", { error: String(err) });
		return null;
	}
}

/**
 * Push config to Lab via BFF API.
 *
 * #337 Phase 6b: `naiaKey` parameter retained for signature stability; auth
 * header injection happens inside the agent.
 */
export function pushConfigToLab(
	_naiaKey: string,
	naiaUserId: string,
	config: Partial<AppConfig>,
): void {
	const syncData = pickSyncFields(config);
	agentLabProxyRequest({
		mode: resolveAuthMode(),
		method: "PATCH",
		path: LAB_API_PATH,
		headers: { "X-User-Id": naiaUserId },
		body: { config: syncData },
	}).catch((err) => {
		Logger.warn("lab-sync", "pushConfigToLab failed", { error: String(err) });
	});
}

/** Delete all config from Lab (reset nan_config to empty) */
export async function clearLabConfig(
	_naiaKey: string,
	naiaUserId: string,
): Promise<void> {
	try {
		await agentLabProxyRequest({
			mode: resolveAuthMode(),
			method: "PATCH",
			path: LAB_API_PATH,
			headers: { "X-User-Id": naiaUserId },
			body: { config: {} },
		});
	} catch (err) {
		Logger.warn("lab-sync", "clearLabConfig failed", { error: String(err) });
	}
}

/** Compare local vs online config, return field names that differ */
export function diffConfigs(
	local: Partial<AppConfig>,
	online: Partial<SyncConfig>,
): string[] {
	const diffs: string[] = [];
	for (const key of LAB_SYNC_FIELDS) {
		const localVal = local[key];
		const onlineVal = online[key as keyof typeof online];
		if (onlineVal !== undefined && onlineVal !== localVal) {
			diffs.push(key);
		}
	}
	return diffs;
}
