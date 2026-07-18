import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOG_PATH = resolve(homedir(), ".naia", "logs", "naia.log");
const SESSION_MARKER = "[Naia] === Session started ===";
const HANDSHAKE_MARKER = "[Naia] agent-core gRPC @";
const NODE_MARKER = "[Naia] node = ";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function inspectInstalledSession(
	logText,
	resourceDir,
	minimumPriorSessions = 0,
) {
	const lines = logText.split(/\r?\n/);
	let sessionStart = -1;
	let sessionCount = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].includes(SESSION_MARKER)) {
			sessionStart = index;
			sessionCount += 1;
		}
	}
	if (sessionStart < 0 || sessionCount <= minimumPriorSessions) {
		return { ok: false, reason: "이번 실행의 새 session marker 없음" };
	}

	const session = lines.slice(sessionStart + 1);
	const handshake = session.some((line) => line.includes(HANDSHAKE_MARKER));
	const nodePaths = session
		.filter((line) => line.includes(NODE_MARKER))
		.map((line) =>
			line.slice(line.indexOf(NODE_MARKER) + NODE_MARKER.length).trim(),
		);
	const root = resolve(resourceDir);
	const allBundled =
		nodePaths.length >= 2 &&
		nodePaths.every((nodePath) => {
			if (!isAbsolute(nodePath)) return false;
			const rel = relative(root, resolve(nodePath));
			return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		});

	if (!handshake)
		return { ok: false, reason: "agent-core gRPC handshake 없음" };
	if (nodePaths.length < 2) {
		return {
			ok: false,
			reason: `node 관측 줄 ${nodePaths.length}개(<2)`,
			nodePaths,
		};
	}
	if (!allBundled) {
		return {
			ok: false,
			reason: `번들 밖 node 사용: ${nodePaths.join(", ")}`,
			nodePaths,
		};
	}
	return { ok: true, nodePaths };
}

export async function verifyInstalledSmoke({
	binary,
	resourceDir,
	timeoutMs = 120_000,
	logPath = LOG_PATH,
}) {
	if (!existsSync(binary)) {
		throw new Error(`[installed-smoke] 바이너리 없음: ${binary}`);
	}
	const priorSessions = existsSync(logPath)
		? readFileSync(logPath, "utf8")
				.split(/\r?\n/)
				.filter((line) => line.includes(SESSION_MARKER)).length
		: 0;
	const child = spawn(binary, [], {
		cwd: dirname(binary),
		env: { ...process.env },
		stdio: "ignore",
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	const deadline = Date.now() + timeoutMs;
	let lastReason = "로그 대기 중";
	try {
		while (Date.now() < deadline) {
			if (existsSync(logPath)) {
				const result = inspectInstalledSession(
					readFileSync(logPath, "utf8"),
					resourceDir,
					priorSessions,
				);
				if (result.ok) return result;
				lastReason = result.reason;
				if (result.nodePaths?.length >= 2 && lastReason.startsWith("번들 밖")) {
					throw new Error(`[installed-smoke] ${lastReason}`);
				}
			}
			if (child.exitCode !== null) {
				throw new Error(
					`[installed-smoke] 프로세스 조기 종료 code=${child.exitCode}: ${lastReason}`,
				);
			}
			await sleep(1_000);
		}
		throw new Error(`[installed-smoke] ${timeoutMs}ms timeout: ${lastReason}`);
	} finally {
		if (child.exitCode === null) {
			if (process.platform === "win32") {
				spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
			} else {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			}
		}
	}
}

function parseArgs(argv) {
	const values = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index]?.replace(/^--/, "");
		const value = argv[index + 1];
		if (!key || value === undefined) {
			throw new Error(
				"usage: node scripts/verify-installed-smoke.mjs --binary <path> --resource-dir <path> [--timeout-ms <ms>]",
			);
		}
		values[key] = value;
	}
	return values;
}

const invoked = process.argv[1]
	? pathToFileURL(resolve(process.argv[1])).href
	: "";
if (invoked === import.meta.url) {
	const args = parseArgs(process.argv.slice(2));
	verifyInstalledSmoke({
		binary: resolve(args.binary),
		resourceDir: resolve(args["resource-dir"]),
		timeoutMs: args["timeout-ms"]
			? Number.parseInt(args["timeout-ms"], 10)
			: undefined,
	})
		.then((result) => {
			console.log(
				`[installed-smoke] PASS handshake + bundled node ${result.nodePaths.length}줄`,
			);
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
