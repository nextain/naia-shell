// adapters/tauri/config-map — old flat AppConfig → domain NaiaConfig 버킷 분류.
// ⚠️ 필드 분류는 어댑터 책임(old 스키마 의존). domain 은 버킷만 알고 forAgent 가 secret+ui 제거.
// 키 집합 = old adk-store.ts stripForAgent 와 동일(검증 2026-06-13; SECRET 10/10·UI 포함 6키 보강). 누락 시 secret/PII 가 agent 버킷 유출.
import type { NaiaConfig } from "../../ports/index.js";

const SECRET_CONFIG_KEYS = new Set<string>([
  "apiKey", "naiaKey", "googleApiKey",
  "openaiTtsApiKey", "elevenlabsApiKey", "gatewayToken", "openaiRealtimeApiKey",
  "memoryEmbeddingApiKey", "memoryLlmApiKey", "qdrantApiKey",
]);

const UI_ONLY_CONFIG_KEYS = new Set<string>([
  "theme", "backgroundImage", "backgroundVideo", "vrmModel", "customVrms", "customBgs",
  "sttProvider", "sttModel", "naiaCloudSttBackend",
  "ttsEnabled", "ttsVoice", "ttsProvider", "naiaCloudTtsBackend", "ttsEngine",
  "ttsOutputDeviceId", "sttInputDeviceId", "vllmSttHost", "vllmSttModel", "vllmTtsHost",
  "liveProvider", "liveVoice", "liveModel", "openaiRealtimeVoice", "voice", "voiceConversation",
  "panelPosition", "panelVisible", "panelSize", "deletedPanels",
  "bgmTrack", "bgmSource", "bgmYoutubeVideoId", "bgmYoutubeTitle",
  "bgmYoutubeChannel", "bgmYoutubeThumbnail", "bgmVolume", "bgmPlaying",
  // F0-2 (2026-06-13 리뷰): old stripForAgent 누락 6키 — agent 버킷 유출(naiaUserId=식별정보) 방지.
  "gatewayTtsAuto", "gatewayTtsMode",
  "discordSessionMigrated", "lastProcessedDiscordMessageId",
  "locale", "naiaUserId",
]);

/** flat config → {agent, secret, ui} 버킷. forAgent() 가 secret+ui 를 제거하므로 분류가 권위. */
export function toNaiaConfig(flat: Record<string, unknown>): NaiaConfig {
  const agent: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  const ui: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat)) {
    if (SECRET_CONFIG_KEYS.has(k)) secret[k] = v;
    else if (UI_ONLY_CONFIG_KEYS.has(k)) ui[k] = v;
    else agent[k] = v;
  }
  return {
    agent, secret, ui,
    workspaceRoot: typeof flat["workspaceRoot"] === "string" ? (flat["workspaceRoot"] as string) : undefined,
    onboardingComplete: flat["onboardingComplete"] === true,
    naiaKey: typeof flat["naiaKey"] === "string" ? (flat["naiaKey"] as string) : undefined,
  };
}
