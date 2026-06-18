/**
 * BGM 사이드카 진입점 — YouTube BGM HTTP 서버(포트 18791)를 자체 Node 프로세스로 띄운다.
 *
 * 레이어: **환경(environment)** 사이드카. 셸(`new-naia-os`)이 소유·spawn 하며 agent(뇌)와 무관히
 * 동작·생존한다(뇌 죽어도 BGM 유지). SoT = `docs/brain-body-environment.md`.
 *
 * Rust(`packages/shell/src-tauri/src/lib.rs::spawn_youtube_bgm_server`)가 Tauri 시작 시 spawn 한다.
 * 과거엔 이 코드가 구 monorepo 의 `naia-os/agent/src/` 에 있었으나(=#335 근본원인: split 후 누락),
 * 환경 표준에 따라 **셸 워크스페이스 패키지(`@naia/bgm-sidecar`)** 로 이전했다. agent 트리에 두지 않는다.
 */
import { startYoutubeServer, YT_SERVER_PORT } from "./youtube-server.js";

// Graceful shutdown — Tauri SIGTERM/SIGINT (or stdin EOF on Windows) → exit.
const shutdown = (signal: string) => {
	process.stderr.write(`[bgm-server-bin] ${signal} received, exiting\n`);
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// On Windows, Tauri's Child::kill() terminates the process directly; on Unix
// it sends SIGKILL. Either way, no cleanup is required (no DB / no IPC state).
process.stderr.write(`[bgm-server-bin] starting on port ${YT_SERVER_PORT}\n`);
startYoutubeServer();
