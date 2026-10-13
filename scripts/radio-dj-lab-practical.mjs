import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { stdout } from "node:process";
import { resolve } from "node:path";
import {
	AGENT_REPOSITORY,
	REDACTION_POLICY_VERSION,
	SHELL_REPOSITORY,
	currentShellCommit,
	pairedAgentCommit,
	sanitizeEvent,
	validateLabConfig,
} from "./radio-dj-lab-contract.mjs";
import { buildEvent, createJudgement } from "./radio-dj-lab-observations.mjs";
import { writeEmptyOutputDir } from "./radio-dj-lab-render.mjs";

function loopbackOrigin(origin) {
	if (!origin) return true;
	try {
		const url = new URL(origin);
		if (url.protocol === "tauri:" && url.hostname === "localhost") return true;
		return (
			["http:", "https:"].includes(url.protocol) &&
			["localhost", "127.0.0.1", "[::1]"].includes(url.host.split(":")[0])
		);
	} catch {
		return false;
	}
}

function responseJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(value));
}

async function readRequestBody(request, maxBytes = 16_384) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxBytes) throw new Error("request too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function attachSnippet(endpoint, token) {
	return `(() => {\n  const endpoint = ${JSON.stringify(endpoint)};\n  const token = ${JSON.stringify(token)};\n  const record = (event) => fetch(endpoint, { method: "POST", mode: "cors", headers: { "content-type": "application/json", "x-radio-dj-lab-token": token }, body: JSON.stringify(event), keepalive: true }).catch(() => {});\n  window.__NAIA_RADIO_DJ_LAB__ = { record };\n  const onActivity = (event) => record({ event_type: "radio.activity", data: { state: event.detail?.active === true ? "started" : "stopped" } });\n  window.addEventListener("naia-proactive-activity-state", onActivity);\n  window.__NAIA_RADIO_DJ_LAB__.detach = () => { window.removeEventListener("naia-proactive-activity-state", onActivity); delete window.__NAIA_RADIO_DJ_LAB__; };\n  return "Radio DJ Lab observer attached; event payloads are allowlisted.";\n})()`;
}

export async function runPracticalCollector(config, outputPath) {
	validateLabConfig(config);
	const outputDir = resolve(outputPath);
	await writeEmptyOutputDir(outputDir);
	const token = randomBytes(24).toString("base64url");
	const runId = `practical-${new Date().toISOString().replaceAll(/[^0-9TZ]/g, "-")}`;
	const shellCommit = currentShellCommit();
	const eventsPath = resolve(outputDir, "events.jsonl");
	const runtimeStart = process.hrtime.bigint();
	const startedAt = Date.now();
	let sequence = 0;
	let invalidEvents = 0;
	const originHeader = "Access-Control-Allow-Origin";
	const server = createServer(async (request, response) => {
		const origin = request.headers.origin;
		if (!loopbackOrigin(origin)) {
			responseJson(response, 403, { error: "loopback origin required" });
			return;
		}
		if (origin) response.setHeader(originHeader, origin);
		response.setHeader("Vary", "Origin");
		response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
		response.setHeader(
			"Access-Control-Allow-Headers",
			"content-type, x-radio-dj-lab-token",
		);
		if (request.method === "OPTIONS") {
			response.writeHead(204).end();
			return;
		}
		if (request.method !== "POST" || request.url !== "/events") {
			responseJson(response, 404, { error: "not found" });
			return;
		}
		if (request.headers["x-radio-dj-lab-token"] !== token) {
			responseJson(response, 401, { error: "invalid session token" });
			return;
		}
		try {
			const input = await readRequestBody(request);
			const safe = sanitizeEvent(input?.event_type, input?.data);
			if (!safe) {
				invalidEvents += 1;
				responseJson(response, 400, { error: "event rejected by allowlist" });
				return;
			}
			const elapsedMs = Number(
				(process.hrtime.bigint() - runtimeStart) / 1_000_000n,
			);
			const event = buildEvent({
				runId,
				sequence: ++sequence,
				eventType: safe.event_type,
				data: safe.data,
				mode: "practical",
				elapsedMs,
				observationSource: "observed",
				occurredAt: Date.now(),
				shellCommit,
			});
			await appendFile(eventsPath, `${JSON.stringify(event)}\n`, {
				encoding: "utf8",
			});
			response.writeHead(204, { "cache-control": "no-store" }).end();
		} catch {
			invalidEvents += 1;
			responseJson(response, 400, { error: "invalid event request" });
		}
	});
	const requestedPort = Number.isInteger(config.practical.port)
		? config.practical.port
		: 0;
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(requestedPort, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("could not bind practical recorder");
	const manifest = {
		schema_version: "1.0",
		run_id: runId,
		scenario_id: config.scenario_id,
		mode: "practical",
		clock_domain: "monotonic",
		seed: null,
		created_at_utc: new Date(startedAt).toISOString(),
		repositories: [
			{ name: SHELL_REPOSITORY, commit: shellCommit },
			{ name: AGENT_REPOSITORY, commit: pairedAgentCommit() },
		],
		protocol_version: "1.0",
		redaction_policy_version: REDACTION_POLICY_VERSION,
		capture_refs: [],
		planned_duration_minutes: config.practical.duration_minutes,
		actual_duration_ms: null,
		external_network_calls: null,
		actual_llm_calls: null,
		invalid_events: null,
		thresholds: config.thresholds,
		threshold_profile: { schema_version: "1.0", values: config.thresholds },
		configured_model: {
			provider: config.shell_config.provider,
			model_id: config.shell_config.model,
			quantization: null,
			device: null,
		},
		music_source: {
			kind: "configured-for-practical-run",
			configured_source: config.shell_config.bgmSource,
			track_id: null,
		},
		downstream_adapter_contract: {
			memory_input_fields: [
				"content",
				"role",
				"timestamp",
				"context",
				"idempotencyKey",
			],
			memory_input_context_type: "string",
			memory_write_performed: false,
			persona_atom_fields: [
				"id",
				"layer",
				"domain",
				"claim",
				"evidence.source_path",
				"evidence.quote",
				"volatility",
				"rationale",
			],
			persona_promotion_performed: false,
			training_performed: false,
		},
		collector_host: "127.0.0.1",
		collector_port: address.port,
		limits: [
			"This recorder observes only allowlisted Shell UI events.",
			"It does not capture audio, screen content, chat text, URLs, titles, credentials, or network traffic.",
			"No capture references are added by this collector; capture_refs is empty.",
		],
	};
	await writeFile(
		resolve(outputDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ flag: "wx" },
	);
	await writeFile(
		resolve(outputDir, "attach-observer.js"),
		attachSnippet(`http://127.0.0.1:${address.port}/events`, token),
		{ flag: "wx", mode: 0o600 },
	);
	await writeFile(eventsPath, "", { flag: "wx" });
	stdout.write(
		`Radio DJ Lab practical collector is listening on 127.0.0.1:${address.port}.\n`,
	);
	stdout.write(
		`Duration setting: ${config.practical.duration_minutes} minutes. The app trial has not started.\n`,
	);
	stdout.write(
		`Paste the contents of ${resolve(outputDir, "attach-observer.js")} into the running app DevTools console.\n`,
	);
	stdout.write(
		"Stop with Ctrl+C; the collector stores only allowlisted event fields.\n",
	);
	let timer;
	let finalizing = false;
	let resolveDone;
	const done = new Promise((resolveDonePromise) => {
		resolveDone = resolveDonePromise;
	});
	const finalize = async (reason) => {
		if (finalizing) return;
		finalizing = true;
		if (timer) clearTimeout(timer);
		await new Promise((resolveClose) => server.close(resolveClose));
		const contents = await readFile(eventsPath, "utf8");
		const events = contents.trim()
			? contents
					.trimEnd()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
		const judgement = createJudgement(config, events, "practical");
		judgement.run_id = runId;
		judgement.finish_reason = reason;
		judgement.invalid_event_count = invalidEvents;
		manifest.actual_duration_ms = Number(
			(process.hrtime.bigint() - runtimeStart) / 1_000_000n,
		);
		manifest.invalid_events = invalidEvents;
		manifest.finished_at_utc = new Date().toISOString();
		await writeFile(
			resolve(outputDir, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		await writeFile(
			resolve(outputDir, "judgement.json"),
			`${JSON.stringify(judgement, null, 2)}\n`,
			{ flag: "wx" },
		);
		await writeFile(
			resolve(outputDir, "checks.json"),
			`${JSON.stringify(judgement.checks, null, 2)}\n`,
			{ flag: "wx" },
		);
		await writeFile(
			resolve(outputDir, "timeline.svg"),
			renderTimelineSvg(events, "Radio DJ Lab · practical run"),
			{ flag: "wx" },
		);
		await writeFile(
			resolve(outputDir, "timeline.html"),
			`<!doctype html><meta charset="utf-8"><title>Radio DJ Lab timeline</title><style>body{margin:24px;background:#f4f6f8}img{max-width:100%;height:auto}</style><img src="timeline.svg" alt="Radio DJ Lab practical time-axis timeline">`,
			{ flag: "wx" },
		);
		resolveDone();
	};
	timer = setTimeout(() => {
		void finalize("duration_elapsed");
	}, config.practical.duration_minutes * 60_000);
	const onSignal = () => {
		void finalize("interrupted_by_operator");
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	await done;
	process.removeListener("SIGINT", onSignal);
	process.removeListener("SIGTERM", onSignal);
	return { outputDir, manifest };
}
