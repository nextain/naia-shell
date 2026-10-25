import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import {
	E2E_ROOT,
	E2E_TARGET_DIR,
	E2E_WEBDRIVER_PORT,
	E2E_WORKSPACE,
	assertCodexE2eIsolation,
	resetCodexE2eRoot,
	startOwnedEmbeddedApp,
	startOwnedViteServer,
} from "./codex-e2e-environment.js";
import { transformRequest } from "./node26-request.js";
import { config as codexConfig } from "./wdio.conf.codex.js";

const EXE = process.platform === "win32" ? ".exe" : "";
const TAURI_BINARY = resolve(E2E_TARGET_DIR, "debug", `naia-shell${EXE}`);
const ADAPTER_ROOT = resolve(E2E_WORKSPACE, "projects", "group", "naia-pj-adk");

function seedProject(projectId: string): void {
	const projectPath = resolve(ADAPTER_ROOT, "projects", projectId);
	const checkoutPath = resolve(ADAPTER_ROOT, "checkouts", projectId);
	mkdirSync(projectPath, { recursive: true });
	mkdirSync(checkoutPath, { recursive: true });
	writeFileSync(
		resolve(projectPath, "project.yaml"),
		[
			"version: 1",
			"project:",
			`  id: ${projectId}`,
			`  repository: owner/${projectId}`,
		].join("\n"),
		"utf8",
	);
}

function seedFakeClaude(): void {
	const bin = resolve(E2E_ROOT, "fake-bin");
	mkdirSync(bin, { recursive: true });
	const executable = resolve(bin, "claude");
	writeFileSync(
		executable,
		'#!/bin/sh\nwhile IFS= read -r line; do\n  printf \'%s\\n\' "$line" >> "$NAIA_E2E_PTY_TRACE"\n  printf \'ECHO:%s\\r\\n\' "$line"\ndone\n',
		"utf8",
	);
	chmodSync(executable, 0o755);
	process.env.PATH = [bin, process.env.PATH].filter(Boolean).join(delimiter);
}

export const config = {
	...codexConfig,
	// After the spread so the shared Node 26 fix (node26-request.ts) is the
	// one in effect, not a copy inherited from the base config.
	transformRequest,
	specs: ["./specs/project-agent-pty-input.spec.ts"],
	async onPrepare() {
		if (!existsSync(TAURI_BINARY)) {
			throw new Error(
				"Missing embedded E2E binary. Run pnpm run build:e2e:tauri first.",
			);
		}
		resetCodexE2eRoot();
		// This PTY flow does not create native child windows. Keep the runtime
		// isolation enabled and explicitly replace inherited workspace/home values
		// before launching either Vite or Tauri.
		process.env.CAFE_DEBUG_E2E = "1";
		process.env.NAIA_E2E_MODE = "1";
		process.env.HOME = resolve(E2E_ROOT, "home");
		process.env.NAIA_HOME = resolve(E2E_ROOT, "naia-home");
		process.env.NAIA_E2E_HOME = process.env.NAIA_HOME;
		process.env.NAIA_ADK_PATH = E2E_WORKSPACE;
		process.env.NAIA_E2E_ADK_PATH = E2E_WORKSPACE;
		process.env.NAIA_E2E_PTY_TRACE = resolve(
			E2E_ROOT,
			"project-agent-pty-input.log",
		);
		process.env.NAIA_SETTINGS_DIR = resolve(E2E_WORKSPACE, "naia-settings");
		process.env.VITE_NAIA_WEB_BASE_URL = "http://127.0.0.1:1422";
		process.env.VITE_NAIA_DEV_GATEWAY_URL = "http://127.0.0.1:1422";
		const oauthPort = 19_000 + (E2E_WEBDRIVER_PORT % 1_000);
		process.env.NAIA_OAUTH_CALLBACK_PORT = String(oauthPort);
		process.env.NAIA_E2E_OAUTH_CALLBACK_PORT = String(oauthPort);
		process.env.VITE_NAIA_OAUTH_CALLBACK_URL = `http://127.0.0.1:${oauthPort}/auth/callback`;
		seedProject("pty-input-756-a");
		seedProject("pty-input-756-b");
		writeFileSync(process.env.NAIA_E2E_PTY_TRACE, "", "utf8");
		seedFakeClaude();
		assertCodexE2eIsolation();
		await startOwnedViteServer();
		await startOwnedEmbeddedApp(TAURI_BINARY);
	},
};
