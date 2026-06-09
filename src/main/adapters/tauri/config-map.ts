// adapters/tauri/config-map — old flat AppConfig → domain NaiaConfig 버킷 분류.
// ⚠️ 필드 분류는 어댑터 책임(old 스키마 의존). domain 은 버킷만 알고 forAgent 가 secret+ui 제거.
// 키 집합 = old adk-store.ts 에서 verbatim 이관 (보안: 누락 시 secret 누출).
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
