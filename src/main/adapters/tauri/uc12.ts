// adapters/tauri/uc12 — UC12 driven 어댑터 (live, 주입식). ⚠️ new-naia-os 는 @tauri-apps 비의존 —
// shell 이 invoke/openUrl/convertFileSrc 주입(live.ts 패턴). 인지 0.
// ⚠️ GatewaySync 제거됨(2026-06-12): gateway(openclaw)는 #201에서 제거 — sync_gateway_config 는 아무도 안 읽는
//    gateway.json 에 쓰던 군더더기였음(내 false-success). config 영속=ConfigPort(naia-settings), naiaKey=키체인.
import type { AssetInventoryPort, AssetRef, OAuthPort } from "../../ports/index.js";

/** shell(@tauri-apps 보유)이 주입하는 실제 함수 + naia 로그인 URL. */
export interface UC12LiveDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  openUrl: (url: string) => Promise<void>;
  convertFileSrc: (path: string) => string;
  loginUrl: string;
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
const extOf = (n: string): string => n.split("?")[0].split(".").pop()?.toLowerCase() ?? "";

/** 주입식 UC12 driven 어댑터(AssetInventory·OAuth). */
export function makeUC12LiveAdapters(d: UC12LiveDeps): { assets: AssetInventoryPort; oauth: OAuthPort } {
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
    oauth: {
      async launch(): Promise<void> {
        await d.openUrl(d.loginUrl);
      },
    },
  };
}
