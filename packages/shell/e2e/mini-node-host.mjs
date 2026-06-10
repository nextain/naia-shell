/**
 * Minimal OpenClaw Node Host for E2E testing.
 * Connects as a node to the Gateway and handles system.run invocations.
 */

import { spawn } from "node:child_process";
import {
	createHash,
	createPrivateKey,
	generateKeyPairSync,
	randomUUID,
	sign,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.OPENCLAW_PORT || 18789;
const TOKEN =
	process.env.OPENCLAW_GATEWAY_TOKEN ||
	"57e2ad5473652d231cd530a613762be5adb147a022b92215";
const DISPLAY_NAME = process.env.OPENCLAW_NODE_NAME || "NaiaLocal";
const WS_URL = `ws://127.0.0.1:${PORT}`;

// Use Node.js native WebSocket (available in Node 22+)

function pemToRawBase64Url(pem) {
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
	const der = Buffer.from(b64, "base64");
	const raw = der.slice(der.length - 32);
	return raw.toString("base64url");
}

function signPayload(privateKeyPem, payload) {
	const key = createPrivateKey(privateKeyPem);
	return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

function loadOrCreateDevice() {
	const dir = join(homedir(), ".openclaw", "identity");
	const path = join(dir, "device.json");
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf8"));
	}
	// Generate Ed25519 key pair
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
	const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
	const rawPub = pemToRawBase64Url(publicKeyPem);
	const deviceId = createHash("sha256")
		.update(Buffer.from(rawPub, "base64url"))
		.digest("hex");
	const device = {
		version: 1,
		deviceId,
		publicKeyPem,
		privateKeyPem,
		createdAtMs: Date.now(),
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(device, null, 2), { mode: 0o600 });
	return device;
}

class MiniNodeHost {
	constructor() {
		this.ws = null;
		this.device = loadOrCreateDevice();
		// Use device ID as node instance ID
		this.nodeId = process.env.OPENCLAW_NODE_ID || this.device.deviceId;
		this.connected = false;
		this.challengeNonce = null;
		console.log(`[mini-node] Device ID: ${this.nodeId.slice(0, 16)}...`);
	}

	start() {
		console.log(`[mini-node] Connecting to ${WS_URL}...`);
		this.ws = new WebSocket(WS_URL);

		this.ws.addEventListener("open", () => {
			console.log("[mini-node] WebSocket open, waiting for challenge...");
		});

		this.ws.addEventListener("message", (event) => {
			const frame = JSON.parse(
				typeof event.data === "string" ? event.data : event.data.toString(),
			);
			this.handleFrame(frame);
		});

		this.ws.addEventListener("close", (event) => {
			console.log(`[mini-node] Closed: ${event.code} ${event.reason}`);
			this.connected = false;
			setTimeout(() => this.start(), 2000);
		});

		this.ws.addEventListener("error", (event) => {
			console.error("[mini-node] Error:", event.message || "unknown");
		});
	}

	handleFrame(frame) {
		if (frame.type === "event" && frame.event === "connect.challenge") {
			this.challengeNonce = frame.payload?.nonce;
			console.log("[mini-node] Got challenge, sending connect...");
			this.sendConnect();
			return;
		}

		if (frame.type === "res" && frame.id === "connect-req") {
			if (frame.ok) {
				this.connected = true;
				console.log(`[mini-node] Connected as ${DISPLAY_NAME}`);
			} else {
				console.error(`[mini-node] Connect failed: ${frame.error?.message}`);
			}
			return;
		}

		if (frame.type === "event" && frame.event === "node.invoke.request") {
			this.handleInvoke(frame.payload);
			return;
		}

		// Log unhandled frames
		if (frame.type === "event") {
			console.log(`[mini-node] Event: ${frame.event}`);
		} else if (frame.type === "res") {
			console.log(
				`[mini-node] Response: id=${frame.id} ok=${frame.ok} ${frame.error?.message || ""}`,
			);
		}
	}

	sendConnect() {
		const signedAt = Date.now();
		const role = "node";
		const scopes = [];

		// Build device auth (v2 payload format — matches agent GatewayClient)
		const payloadStr = [
			"v2",
			this.device.deviceId,
			"node-host", // clientId
			"node", // clientMode
			role,
			scopes.join(","),
			String(signedAt),
			TOKEN,
			this.challengeNonce,
		].join("|");
		const signature = signPayload(this.device.privateKeyPem, payloadStr);

		const params = {
			minProtocol: 3,
			maxProtocol: 3,
			client: {
				id: "node-host",
				displayName: DISPLAY_NAME,
				version: "0.1.0",
				platform: "linux",
				mode: "node",
				instanceId: this.nodeId,
			},
			caps: ["system"],
			commands: [
				"system.run.prepare",
				"system.run",
				"system.which",
				"system.execApprovals.get",
				"system.execApprovals.set",
			],
			pathEnv: process.env.PATH || "",
			auth: { token: TOKEN },
			role,
			scopes,
			device: {
				id: this.device.deviceId,
				publicKey: pemToRawBase64Url(this.device.publicKeyPem),
				signature,
				signedAt,
				nonce: this.challengeNonce,
			},
		};

		this.ws.send(
			JSON.stringify({
				type: "req",
				id: "connect-req",
				method: "connect",
				params,
			}),
		);
	}

	async handleInvoke(payload) {
		const { id, command, paramsJSON } = payload;
		const params = JSON.parse(paramsJSON || "{}");
		console.log(
			`[mini-node] Invoke: ${command} ${JSON.stringify(params).slice(0, 100)}`,
		);

		if (command === "system.run") {
			await this.handleSystemRun(id, params);
		} else if (command === "system.which") {
			await this.handleSystemWhich(id, params);
		} else {
			this.sendInvokeResult(id, { error: `Unknown command: ${command}` });
		}
	}

	async handleSystemRun(invokeId, params) {
		const args = params.command || [];
		if (args.length === 0) {
			this.sendInvokeResult(invokeId, { exitCode: 1, stderr: "No command" });
			return;
		}

		try {
			const proc = spawn(args[0], args.slice(1), {
				cwd: params.cwd || "/",
				timeout: 30000,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			proc.stdout.on("data", (d) => {
				stdout += d.toString();
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});

			const exitCode = await new Promise((resolve) => {
				proc.on("close", (code) => resolve(code ?? 1));
				proc.on("error", (err) => {
					stderr += err.message;
					resolve(1);
				});
			});

			this.sendInvokeResult(invokeId, { exitCode, stdout, stderr });
		} catch (err) {
			this.sendInvokeResult(invokeId, { exitCode: 1, stderr: err.message });
		}
	}

	async handleSystemWhich(invokeId, params) {
		const name = params.name || "";
		try {
			const proc = spawn("which", [name], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			proc.stdout.on("data", (d) => {
				stdout += d.toString();
			});
			const exitCode = await new Promise((r) =>
				proc.on("close", (c) => r(c ?? 1)),
			);
			this.sendInvokeResult(invokeId, {
				path: stdout.trim(),
				found: exitCode === 0,
			});
		} catch {
			this.sendInvokeResult(invokeId, { path: "", found: false });
		}
	}

	sendInvokeResult(invokeId, result) {
		this.ws.send(
			JSON.stringify({
				type: "req",
				id: randomUUID(),
				method: "node.invoke.result",
				params: {
					id: invokeId,
					nodeId: this.nodeId,
					ok: true,
					payloadJSON: JSON.stringify(result),
				},
			}),
		);
	}
}

const host = new MiniNodeHost();
host.start();
// Keep alive — prevent Node.js from exiting
process.stdin.resume();
