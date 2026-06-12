// adapters/tauri/uc12 — UC12 driven 어댑터 (live, 주입식). ⚠️ new-naia-os 는 @tauri-apps 비의존 —
// shell 이 invoke/openUrl/convertFileSrc 주입(live.ts 패턴). 인지 0.
// ⚠️ 경계(Luke 2026-06-12): sync_gateway_config 의 memory_* = naia-memory 연결 = **다른 세션 소유** → 미배선(null).
import type { AssetInventoryPort, AssetRef, GatewaySyncPort, NaiaConfig, OAuthPort } from "../../ports/index.js";

/** shell(@tauri-apps 보유)이 주입하는 실제 함수 + naia 로그인 URL. */
export interface UC12LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  openUrl: (url: string) => Promise<void>;
  convertFileSrc: (path: string) => string;
  loginUrl: string;
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
const extOf = (n: string): string => n.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** memory_* 의도적 null(다른 세션 경계). core 필드만. */
function gatewayParams(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: null, model: null, api_key: null, persona: null, agent_name: null, user_name: null,
    locale: null, discord_dm_channel_id: null, discord_default_user_id: null,
    tts_provider: null, tts_voice: null, tts_auto: null, tts_mode: null,
    naia_key: null, ollama_host: null, lab_gateway_url: null,
    // ── memory_* = naia-memory 연결 = 다른 세션 소유 (미배선) ──
    memory_adapter: null, memory_embedding_provider: null, memory_offline_model: null,
    memory_embedding_base_url: null, memory_embedding_api_key: null, memory_embedding_model: null,
    qdrant_url: null, qdrant_api_key: null,
    memory_llm_provider: null, memory_llm_base_url: null, memory_llm_api_key: null, memory_llm_model: null,
    ...over,
  };
}

/** 주입식 UC12 driven 어댑터(AssetInventory·GatewaySync·OAuth). */
export function makeUC12LiveAdapters(d: UC12LiveDeps): { assets: AssetInventoryPort; gateway: GatewaySyncPort; oauth: OAuthPort } {
  return {
    assets: {
      async list(adkPath, kind): Promise<readonly AssetRef[]> {
        const names = (await d.invoke("list_naia_assets", { adkPath, subdir: kind }).catch(() => [] as string[])) as string[];
        const sep = adkPath.includes("\\") ? "\\" : "/";
        return names.map((name: string): AssetRef => {
          const path = `${adkPath}${sep}naia-settings${sep}${kind}${sep}${name}`;
          return { url: d.convertFileSrc(path), label: name.replace(/\.[^.]+$/, ""), path, type: VIDEO_EXT.has(extOf(name)) ? "video" : "image" };
        });
      },
    },
    gateway: {
      async authUpdate(naiaKey): Promise<void> {
        await d.invoke("sync_gateway_config", { params: gatewayParams({ naia_key: naiaKey }) }).catch(() => {});
      },
      async sync(config: NaiaConfig): Promise<void> {
        const a = config.agent as Record<string, unknown>;
        await d.invoke("sync_gateway_config", {
          params: gatewayParams({
            provider: str(a.provider), model: str(a.model), api_key: str((config.secret as Record<string, unknown>).apiKey),
            agent_name: str(a.agentName), user_name: str(a.userName), locale: str(a.locale),
            naia_key: config.naiaKey ?? null, ollama_host: str(a.ollamaHost),
          }),
        }).catch(() => {});
      },
    },
    oauth: {
      async launch(): Promise<void> {
        await d.openUrl(d.loginUrl);
      },
    },
  };
}
