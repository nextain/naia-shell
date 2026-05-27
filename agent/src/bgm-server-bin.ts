/**
 * BGM server standalone entry — runs the YouTube BGM HTTP server (port 18791)
 * as its own Node process so it is not coupled to the agent-core lifecycle.
 *
 * Rust (shell/src-tauri/src/lib.rs::spawn_youtube_bgm_server) spawns this
 * alongside spawn_agent_core during Tauri startup. Required because when the
 * standalone naia-agent submodule is preferred over the embedded
 * agent/src/index.ts (see lib.rs:912-928), index.ts:startYoutubeServer() never
 * runs and port 18791 stays empty (issue #335).
 *
 * Respects the naia-agent/CLAUDE.md boundary that bans HTTP servers inside the
 * agent — this is a shell-spawned sidecar, not part of agent IPC.
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
