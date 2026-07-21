import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { config as chat } from "./wdio.conf.chat.js";

const BACKUP_PATH = resolve(
	homedir(),
	".naia/run/codex-live-e2e-config-backup.json",
);
const E2E_XDG_ROOT = resolve(homedir(), ".naia/run/codex-live-e2e-xdg");

type ConfigBackup = {
	configPath: string;
	existed: boolean;
	content: string;
};

function restoreDurableConfigBackup(): void {
	if (!existsSync(BACKUP_PATH)) return;
	const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8")) as ConfigBackup;
	if (backup.existed) {
		mkdirSync(dirname(backup.configPath), { recursive: true });
		const restorePath = `${backup.configPath}.codex-e2e-restore`;
		writeFileSync(restorePath, backup.content, { mode: 0o600 });
		renameSync(restorePath, backup.configPath);
	} else if (existsSync(backup.configPath)) {
		unlinkSync(backup.configPath);
	}
	unlinkSync(BACKUP_PATH);
}

function captureDurableConfigBackup(): void {
	// Recover an interrupted earlier run before taking a new baseline. The backup
	// lives outside the test worker, so driver/app crashes cannot strand Codex as
	// the user's active provider.
	restoreDurableConfigBackup();
	const adkPathFile = resolve(homedir(), ".naia/adk-path");
	const adkPath = readFileSync(adkPathFile, "utf8").trim();
	if (!adkPath)
		throw new Error("Cannot back up config: ~/.naia/adk-path is empty");
	const configPath = resolve(adkPath, "naia-settings/config.json");
	const backup: ConfigBackup = {
		configPath,
		existed: existsSync(configPath),
		content: existsSync(configPath) ? readFileSync(configPath, "utf8") : "",
	};
	mkdirSync(dirname(BACKUP_PATH), { recursive: true });
	writeFileSync(BACKUP_PATH, JSON.stringify(backup), { mode: 0o600 });
}

export const config = {
	...chat,
	specs: ["./specs/90-codex-live-chat.spec.ts"],
	async onPrepare() {
		captureDurableConfigBackup();
		// Never mutate the real Shell WebView cache. Codex login remains available
		// through $HOME/.codex, while Tauri/WebKit state is isolated under XDG.
		rmSync(E2E_XDG_ROOT, { recursive: true, force: true });
		for (const name of ["config", "data", "cache"]) {
			mkdirSync(resolve(E2E_XDG_ROOT, name), { recursive: true });
		}
		process.env.XDG_CONFIG_HOME = resolve(E2E_XDG_ROOT, "config");
		process.env.XDG_DATA_HOME = resolve(E2E_XDG_ROOT, "data");
		process.env.XDG_CACHE_HOME = resolve(E2E_XDG_ROOT, "cache");
		const prepare = chat.onPrepare as (() => Promise<void> | void) | undefined;
		await prepare?.();
	},
	async onComplete() {
		try {
			restoreDurableConfigBackup();
		} finally {
			rmSync(E2E_XDG_ROOT, { recursive: true, force: true });
			const complete = chat.onComplete as
				| (() => Promise<void> | void)
				| undefined;
			await complete?.();
		}
	},
};
