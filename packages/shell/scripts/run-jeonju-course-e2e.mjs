import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const shellRoot = resolve(import.meta.dirname, "..");
const configuredPort = process.env.NAIA_E2E_WEBDRIVER_PORT;

function canListen(port) {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.once("error", () => resolvePort(false));
		server.once("listening", () => server.close(() => resolvePort(true)));
		server.listen(port, "127.0.0.1");
	});
}

async function selectPort() {
	if (configuredPort) {
		const port = Number(configuredPort);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			throw new Error(`NAIA_E2E_WEBDRIVER_PORT must be a usable TCP port: ${configuredPort}`);
		}
		if (!(await canListen(port))) {
			throw new Error(`NAIA_E2E_WEBDRIVER_PORT ${port} is already in use`);
		}
		return port;
	}
	for (let port = 4450; port <= 4499; port += 1) {
		if (await canListen(port)) return port;
	}
	throw new Error("No free WebDriver port found in 4450-4499");
}

const port = await selectPort();
console.log(`[jeonju-course-e2e] WebDriver port ${port}`);
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) {
	throw new Error("pnpm execution path is unavailable");
}
const child = spawn(
	process.execPath,
	[
		pnpmEntrypoint,
		"exec",
		"wdio",
		"run",
		"e2e-tauri/wdio.conf.jeonju-course.ts",
	],
	{
		cwd: shellRoot,
		stdio: "inherit",
		env: { ...process.env, NAIA_E2E_WEBDRIVER_PORT: String(port) },
	},
);
child.once("error", (error) => {
	console.error(`[jeonju-course-e2e] Failed to start WebDriver: ${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	if (signal) {
		console.error(`[jeonju-course-e2e] WebDriver terminated by ${signal}`);
		process.exitCode = 1;
	} else {
		process.exitCode = code ?? 1;
	}
});
