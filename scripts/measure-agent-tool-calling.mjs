#!/usr/bin/env node
/**
 * #592 V1: measure the real Shell -> Agent -> gateway tool loop without Tauri.
 *
 * The live runner starts the pinned Agent entrypoint, registers the two app
 * tools that Shell owns, sends five request families to each selected model,
 * and injects structured app-tool results. It never writes the API key or
 * Agent stderr to the evidence file.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

export const ISSUE = "nextain/naia-shell#592";
export const MACHINE = "naia3090";
export const SHELL_BASELINE = "2941e3b4ac644cffb5be93d72991bb8e9e81f0d0";
export const SHELL_VERSION = "0.2.3";
export const AGENT_BASELINE = "1c2561db486c24c31d10ddbef5ca5f0ff766c7ad";
export const DEFAULT_MODELS = ["deepseek-v4-flash", "gpt-5.6-luna"];
export const DEFAULT_REPETITIONS = 10;
export const SUCCESS_THRESHOLD = 0.9;

const BGM_ACTIONS = [
  "play", "stop", "pause", "resume", "next", "prev", "favorite_add",
  "favorite_remove", "favorites_play", "like_add", "like_remove",
  "playlist_list", "playlist_create", "playlist_add_current", "playlist_play",
  "shuffle", "repeat", "status", "volume",
];

const BGM_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", enum: BGM_ACTIONS, description: BGM_ACTIONS.join(" | ") },
    query: { type: "string", description: "검색어 (play 에서 videoId 없을 때)" },
    videoId: { type: "string", description: "YouTube video id (play, 선택)" },
    title: { type: "string", description: "제목 (play+videoId, 선택)" },
    volume: { type: "number", description: "0.0~1.0 (volume)" },
    playlistId: { type: "string", description: "플레이리스트 ID" },
    name: { type: "string", description: "새 플레이리스트 이름" },
    index: { type: "number", description: "재생할 플레이리스트 항목 번호(0부터)" },
    enabled: { type: "boolean", description: "셔플 사용 여부" },
    repeat: { type: "string", enum: ["off", "all", "one"] },
    mode: { type: "string", enum: ["player", "radio_dj"], description: "Semantic intent chosen by the LLM in any language. Use radio_dj only when the user asks for an ongoing autonomous DJ/radio-host experience (including synonyms or similar phrasing); use player for ordinary song, playlist, or BGM playback." },
  },
  required: ["action"],
};

const BROWSER_NAVIGATE_PARAMETERS = {
  type: "object",
  properties: { url: { type: "string", description: "http/https 주소." } },
  required: ["url"],
};

/** App tools copied from Shell's live descriptors, not Agent-owned tools. */
export const APP_TOOL_SPECS = [
  {
    appId: "bgm-widget",
    name: "skill_youtube_bgm",
    description: "Naia 음악 플레이어 제어. 좋아요는 선호 표시일 뿐 재생 목록이 아니다. next/prev는 활성 플레이리스트와 실행 큐를 사용한다. playlist_list/create/add_current/play, like_add/remove, shuffle, repeat(off/all/one)를 구분해서 사용한다. 도구 결과가 requested이면 재생 성공이라고 말하지 말고 observed playing만 실제 재생으로 표현한다.",
    parameters: BGM_PARAMETERS,
    tier: 0,
  },
  {
    appId: "browser-host",
    name: "env_browser_navigate",
    description: "지금 탭에서 다른 주소로 간다.",
    parameters: BROWSER_NAVIGATE_PARAMETERS,
    tier: 1,
  },
];

const BUILTIN_TOOL_SCHEMAS = {
  memo_save: {
    type: "object",
    properties: { title: { type: "string" }, content: { type: "string" } },
    required: ["title", "content"],
  },
  get_weather: {
    type: "object",
    properties: { latitude: { type: "number" }, longitude: { type: "number" } },
    required: ["latitude", "longitude"],
  },
};

export const SCENARIOS = [
  {
    id: "youtube-play",
    prompt: "유튜브에서 아이유 밤편지를 틀어줘.",
    expectedTool: "skill_youtube_bgm",
    schema: BGM_PARAMETERS,
    acceptsArgs: (args) => args.action === "play",
  },
  {
    id: "radio-dj",
    prompt: "개인 라디오 DJ를 시작하고 잔잔한 음악을 틀어줘.",
    expectedTool: "skill_youtube_bgm",
    schema: BGM_PARAMETERS,
    acceptsArgs: (args) => args.action === "play" && args.mode === "radio_dj",
  },
  {
    id: "memo-save",
    prompt: "'우유 사기'라는 메모를 저장해줘.",
    expectedTool: "memo_save",
    schema: BUILTIN_TOOL_SCHEMAS.memo_save,
    acceptsArgs: (args) => typeof args.title === "string" && typeof args.content === "string",
  },
  {
    id: "weather",
    prompt: "서울의 현재 날씨를 알려줘.",
    expectedTool: "get_weather",
    schema: BUILTIN_TOOL_SCHEMAS.get_weather,
    acceptsArgs: (args) => Number.isFinite(args.latitude) && Number.isFinite(args.longitude),
  },
  {
    id: "browser-navigate",
    prompt: "인앱 브라우저에서 https://example.com으로 이동해줘.",
    expectedTool: "env_browser_navigate",
    schema: BROWSER_NAVIGATE_PARAMETERS,
    acceptsArgs: (args) => typeof args.url === "string" && /^https?:\/\//u.test(args.url),
  },
];

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authorization|credential)/iu;

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const APP_TOOL_CATALOG_SHA256 = sha256(stableJson(APP_TOOL_SPECS));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Small JSON-Schema subset sufficient for the five measured tool contracts. */
export function validateToolArguments(value, schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.type === "object") {
    if (!isObject(value)) return false;
    for (const key of schema.required ?? []) if (!(key in value)) return false;
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (!(key in value)) continue;
      if (!validateToolArguments(value[key], property)) return false;
    }
    return true;
  }
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  return schema.enum === undefined || schema.enum.includes(value);
}

function parseJson(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (typeof event.kind === "string") return event;
  const kind = event.event;
  if (typeof kind !== "string") return null;
  const payload = event[kind] ?? {};
  switch (kind) {
    case "text":
    case "thinking":
      return { kind, text: payload.text ?? "" };
    case "toolUse":
    case "appToolCall":
      return {
        kind,
        toolCallId: payload.toolCallId ?? "",
        toolName: payload.toolName ?? "",
        argsJson: payload.argsJson ?? "",
      };
    case "toolResult":
      return {
        kind,
        toolCallId: payload.toolCallId ?? "",
        toolName: payload.toolName ?? "",
        output: payload.output ?? "",
        success: payload.success === true,
      };
    case "approvalRequest":
      return { kind, toolCallId: payload.toolCallId ?? "", toolName: payload.toolName ?? "" };
    case "error":
      return { kind, message: payload.message ?? "" };
    case "finish":
      return { kind };
    default:
      return { kind };
  }
}

export function normalizeEvents(events) {
  return events.map(normalizeEvent).filter(Boolean);
}

function redactValue(value, secret, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return secret && secret.length > 0 ? value.split(secret).join("[REDACTED]") : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redactValue(entry, secret, name)]));
  }
  return value;
}

export function redactEvents(events, secret = "") {
  return events.map((event) => redactValue(event, secret));
}

export function evidenceContainsSecret(evidence, secret) {
  return Boolean(secret) && JSON.stringify(evidence).includes(secret);
}

function failureFamily({ errorMessage, matchingCall, argumentsValid, followUp, finishSeen }) {
  const message = String(errorMessage ?? "");
  if (/401|403|unauthor|api[ _-]?key|credential|auth/iu.test(message)) return "auth";
  if (/timeout|deadline|timed? out/iu.test(message)) return "timeout";
  if (!matchingCall) return "model-tool-selection";
  if (!argumentsValid) return "tool-argument";
  if (/gateway|stream|fetch|grpc|unavailable|network/iu.test(message)) return "gateway-stream";
  if (!followUp || !finishSeen) return "agent-follow-up";
  return "other";
}

export function evaluateAttempt({ scenario, model, attempt, events = [], latencyMs = null, error = "" }) {
  const normalized = normalizeEvents(events);
  const calls = normalized
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "toolUse" || event.kind === "appToolCall");
  const matching = calls.filter(({ event }) => event.toolName === scenario.expectedTool);
  const validMatching = matching.find(({ event }) => {
    const args = parseJson(event.argsJson) ?? event.args;
    return validateToolArguments(args, scenario.schema) && scenario.acceptsArgs(args);
  });
  const lastToolIndex = calls.at(-1)?.index ?? -1;
  const followUpText = normalized
    .slice(lastToolIndex + 1)
    .filter((event) => event.kind === "text")
    .map((event) => String(event.text ?? ""))
    .join("")
    .trim();
  const finishSeen = normalized.some((event) => event.kind === "finish");
  const errorMessage = error || normalized.filter((event) => event.kind === "error").map((event) => event.message).join("; ");
  const argumentsValid = Boolean(validMatching);
  const success = Boolean(validMatching && finishSeen && followUpText);
  return {
    model,
    scenario: scenario.id,
    attempt,
    success,
    expectedTool: scenario.expectedTool,
    observedToolCalls: calls.map(({ event }) => ({
      kind: event.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: parseJson(event.argsJson) ?? event.args ?? null,
    })),
    expectedToolObserved: matching.length > 0,
    argumentsValid,
    followUp: Boolean(followUpText),
    finalResponse: Boolean(finishSeen && followUpText),
    finishSeen,
    finalTextLength: followUpText.length,
    latencyMs: latencyMs === null ? null : Math.round(latencyMs),
    failureFamily: success ? "none" : failureFamily({ errorMessage, matchingCall: matching.length > 0, argumentsValid, followUp: Boolean(followUpText), finishSeen }),
    error: errorMessage || undefined,
  };
}

export function aggregateAttempts(attempts, repetitions = DEFAULT_REPETITIONS) {
  const groups = new Map();
  for (const attempt of attempts) {
    const key = `${attempt.model}\u0000${attempt.scenario}`;
    const group = groups.get(key) ?? { model: attempt.model, scenario: attempt.scenario, total: 0, passed: 0, failureFamilies: {} };
    group.total += 1;
    if (attempt.success) group.passed += 1;
    else group.failureFamilies[attempt.failureFamily] = (group.failureFamilies[attempt.failureFamily] ?? 0) + 1;
    groups.set(key, group);
  }
  const required = Math.ceil(repetitions * SUCCESS_THRESHOLD);
  const rows = [...groups.values()].map((group) => ({
    ...group,
    required,
    successRate: group.total === 0 ? 0 : group.passed / group.total,
    meetsThreshold: group.total === repetitions && group.passed >= required,
  }));
  return {
    repetitions,
    required,
    groups: rows,
    meetsThreshold: rows.length > 0 && rows.every((row) => row.meetsThreshold),
  };
}

export function measurementPlan({ models = DEFAULT_MODELS, repetitions = DEFAULT_REPETITIONS, machine = MACHINE } = {}) {
  return {
    issue: ISSUE,
    machine,
    shellBaseline: SHELL_BASELINE,
    shellVersion: SHELL_VERSION,
    agentBaseline: AGENT_BASELINE,
    models: [...models],
    repetitions,
    requiredSuccesses: Math.ceil(repetitions * SUCCESS_THRESHOLD),
    appToolCatalogSha256: APP_TOOL_CATALOG_SHA256,
    appTools: APP_TOOL_SPECS.map(({ appId, name, parameters, tier }) => ({ appId, name, parameters, tier })),
    scenarios: SCENARIOS.map(({ id, prompt, expectedTool }) => ({ id, prompt, expectedTool })),
  };
}

function command(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function validatePinnedCheckouts(productRoot, agentRoot) {
  const productCommit = command(productRoot, ["rev-parse", "HEAD"]);
  try {
    execFileSync("git", ["-C", productRoot, "merge-base", "--is-ancestor", SHELL_BASELINE, "HEAD"]);
  } catch {
    throw new Error(`Shell baseline is not an ancestor of ${productCommit}; expected ${SHELL_BASELINE}`);
  }
  const shellPackage = JSON.parse(readFileSync(join(productRoot, "packages/shell/package.json"), "utf8"));
  if (shellPackage.version !== SHELL_VERSION) throw new Error(`Shell package version mismatch: expected ${SHELL_VERSION}, got ${shellPackage.version}`);
  if (command(productRoot, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Shell worktree must be clean before live measurement");
  const allowedChanges = new Set([
    ".agents/context/process-status.json",
    ".agents/progress/issue-592-v1-tool-measurement-2026-09-14.md",
    ".users/context/process-status.md",
    "docs/requirements.md",
    "docs/user-scenarios.md",
    "scripts/README.md",
    "scripts/measure-agent-tool-calling.mjs",
    "scripts/measure-agent-tool-calling.test.mjs",
  ]);
  const changedFiles = command(productRoot, ["diff", "--name-only", `${SHELL_BASELINE}...HEAD`]).split("\n").filter(Boolean);
  const unexpectedChanges = changedFiles.filter((file) => !allowedChanges.has(file));
  if (unexpectedChanges.length) throw new Error(`Shell measurement branch contains unrelated changes: ${unexpectedChanges.join(", ")}`);
  const agentCommit = command(agentRoot, ["rev-parse", "HEAD"]);
  if (agentCommit !== AGENT_BASELINE) throw new Error(`Agent baseline mismatch: expected ${AGENT_BASELINE}, got ${agentCommit}`);
  if (command(agentRoot, ["status", "--porcelain", "--untracked-files=all"])) throw new Error("Agent worktree must be clean before live measurement");
  const agentEntry = join(agentRoot, "scripts/builds/agent-stdio-entry.mjs");
  const proto = join(agentRoot, "src/main/adapters/grpc/naia_agent.proto");
  if (!existsSync(agentEntry) || !existsSync(proto) || !existsSync(join(agentRoot, "dist/main"))) {
    throw new Error("Pinned Agent checkout is missing its built entrypoint, proto, or dist");
  }
  return { productCommit, shellBaseline: SHELL_BASELINE, shellVersion: shellPackage.version, agentCommit };
}

async function seedAdk(model) {
  const root = await mkdtemp(join(tmpdir(), "naia-shell-592-adk-"));
  const settings = join(root, "naia-settings");
  await mkdir(settings, { recursive: true, mode: 0o700 });
  await writeFile(join(settings, "config.json"), `${JSON.stringify({
    llmRoles: { main: { provider: "nextain", model, credentialRef: "NAIA_API_KEY" } },
  }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(settings, "processing.json"), `${JSON.stringify({ version: 1, profiles: [], consents: [] }, null, 2)}\n`, { mode: 0o600 });
  return root;
}

function loadGrpc(productRoot, agentRoot) {
  const requireFromShell = createRequire(join(productRoot, "packages/shell/package.json"));
  const grpc = requireFromShell("@grpc/grpc-js");
  const protoLoader = requireFromShell("@grpc/proto-loader");
  const definition = protoLoader.loadSync(join(agentRoot, "src/main/adapters/grpc/naia_agent.proto"), {
    keepCase: false,
    longs: Number,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(definition);
  const Client = loaded.naia.agent.v1.NaiaAgent;
  return { grpc, Client };
}

function unary(client, method, request) {
  return new Promise((resolvePromise, reject) => {
    client[method](request, (error, response) => error ? reject(error) : resolvePromise(response));
  });
}

async function startAgent({ agentRoot, adkPath, apiKey, startTimeoutMs }) {
  const child = spawn(process.execPath, [join(agentRoot, "scripts/builds/agent-stdio-entry.mjs")], {
    cwd: agentRoot,
    env: {
      ...process.env,
      NAIA_API_KEY: apiKey,
      NAIA_ADK_PATH: adkPath,
      NAIA_AGENT_MEMORY: "off",
      NAIA_AGENT_SHUTDOWN_NONCE: "naia-shell-592-shutdown-nonce",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const address = await new Promise((resolveAddress, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error("Agent gRPC listening timeout")), startTimeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/GRPC_LISTENING\s+(\S+)/u);
      if (!match) return;
      clearTimeout(timer);
      resolveAddress(match[1]);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Agent exited before gRPC listening (code ${code ?? "unknown"})`));
    });
  }).catch(async (error) => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    throw error;
  });
  return { child, address, stderrLength: stderr.length };
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function appToolResult(toolName, args) {
  if (toolName === "skill_youtube_bgm") {
    return { observed: true, status: "playing", action: args?.action ?? "play", mode: args?.mode ?? "player", videoId: "fixture-video" };
  }
  if (toolName === "env_browser_navigate") return { observed: true, status: "navigated", url: args?.url ?? "" };
  return { observed: true, status: "accepted" };
}

async function chatAttempt({ client, grpc, scenario, model, attempt, timeoutMs }) {
  const started = performance.now();
  const events = [];
  const requestId = `issue-592-${model}-${scenario.id}-${attempt}`;
  const call = client.chat({
    requestId,
    sessionId: `issue-592-${model}`,
    channel: { shell: {} },
    messages: [{ role: "user", content: scenario.prompt }],
    enableTools: true,
    enableThinking: false,
  });
  const result = await new Promise((resolveAttempt, rejectAttempt) => {
    const timer = setTimeout(() => {
      call.cancel();
      rejectAttempt(Object.assign(new Error("Agent chat timeout"), { events }));
    }, timeoutMs);
    call.on("data", (event) => {
      events.push(event);
      const normalized = normalizeEvent(event);
      if (normalized?.kind === "appToolCall") {
        const args = parseJson(normalized.argsJson) ?? {};
        void unary(client, "appToolResult", {
          requestId,
          toolCallId: normalized.toolCallId,
          output: JSON.stringify(appToolResult(normalized.toolName, args)),
          success: true,
        }).catch(() => events.push({ kind: "error", message: "app tool result delivery failed" }));
      } else if (normalized?.kind === "approvalRequest") {
        void unary(client, "approvalResponse", { requestId, toolCallId: normalized.toolCallId, decision: 1 })
          .catch(() => events.push({ kind: "error", message: "approval delivery failed" }));
      }
    });
    call.once("end", () => {
      clearTimeout(timer);
      resolveAttempt({ events, latencyMs: performance.now() - started });
    });
    call.once("error", (error) => {
      clearTimeout(timer);
      rejectAttempt(Object.assign(error, { events }));
    });
  });
  return { evaluation: evaluateAttempt({ scenario, model, attempt, ...result }), events };
}

async function runAttempt({ productRoot, agentRoot, grpcRuntime, apiKey, model, scenario, attempt, timeoutMs, startTimeoutMs }) {
  const adkPath = await seedAdk(model);
  let runtime;
  let client;
  let result;
  try {
    runtime = await startAgent({ agentRoot, adkPath, apiKey, startTimeoutMs });
    client = new grpcRuntime.Client(runtime.address, grpcRuntime.grpc.credentials.createInsecure());
    const settings = await unary(client, "setWorkspace", { adkPath });
    if (settings?.loaded !== true || settings.provider !== "nextain" || settings.model !== model) {
      throw new Error(`Agent settings mismatch for ${model}`);
    }
    for (const tool of APP_TOOL_SPECS) {
      const ack = await unary(client, "registerAppSkills", {
        appId: tool.appId,
        tools: [{ name: tool.name, description: tool.description, parametersJson: JSON.stringify(tool.parameters), tier: tool.tier }],
      });
      if (ack?.ok !== true) throw new Error(`App tool registration failed: ${tool.name}`);
    }
    const chat = await chatAttempt({ client, grpc: grpcRuntime.grpc, scenario, model, attempt, timeoutMs });
    result = { ...chat.evaluation, _events: chat.events };
  } catch (error) {
    const events = error?.events ?? [];
    result = evaluateAttempt({
      scenario,
      model,
      attempt,
      events,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    });
    result._events = events;
  } finally {
    client?.close?.();
    await stopAgent(runtime?.child);
    await rm(adkPath, { recursive: true, force: true });
  }
  return {
    ...result,
    evidence: { events: redactEvents(result._events ?? [], apiKey) },
  };
}

export async function runLiveMeasurement({ productRoot = process.cwd(), agentRoot, apiKey, models = DEFAULT_MODELS, repetitions = DEFAULT_REPETITIONS, output, timeoutMs = 120_000, startTimeoutMs = 60_000, machine = MACHINE }) {
  if (!apiKey?.trim()) throw new Error("NAIA_API_KEY is required for --live and is never written to evidence");
  if (!agentRoot) throw new Error("--agent-worktree is required for --live");
  if (!output) throw new Error("--output is required for --live");
  const product = resolve(productRoot);
  const agent = realpathSync(resolve(agentRoot));
  const provenance = validatePinnedCheckouts(product, agent);
  const grpcRuntime = loadGrpc(product, agent);
  const startedAt = new Date().toISOString();
  const attempts = [];
  for (const model of models) {
    for (const scenario of SCENARIOS) {
      for (let attempt = 1; attempt <= repetitions; attempt += 1) {
        process.stderr.write(`[issue-592] ${model} ${scenario.id} ${attempt}/${repetitions}\n`);
        const value = await runAttempt({ productRoot: product, agentRoot: agent, grpcRuntime, apiKey, model, scenario, attempt, timeoutMs, startTimeoutMs });
        attempts.push(value);
      }
    }
  }
  const report = {
    schemaVersion: 1,
    kind: "naia-shell-592-tool-call-measurement",
    issue: ISSUE,
    machine,
    startedAt,
    finishedAt: new Date().toISOString(),
    provenance,
    plan: measurementPlan({ models, repetitions, machine }),
    summary: aggregateAttempts(attempts, repetitions),
    attempts: attempts.map(({ _events, ...attempt }) => attempt),
  };
  if (evidenceContainsSecret(report, apiKey)) throw new Error("Refusing to write evidence containing NAIA_API_KEY");
  const outputPath = isAbsolute(output) ? output : resolve(product, output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { outputPath, report };
}

function parseArgs(argv) {
  const args = { models: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run" || token === "--live") {
      const key = token.slice(2).replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      args[key] = true;
      continue;
    }
    if (!token.startsWith("--") || argv[index + 1] === undefined) throw new Error(`Invalid argument: ${token}`);
    const key = token.slice(2).replaceAll(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (key === "model" || key === "models") args.models.push(...value.split(",").map((entry) => entry.trim()).filter(Boolean));
    else args[key] = value;
  }
  return args;
}

function numberArg(value, fallback, label, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${label} must be an integer from 1 to ${max}`);
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const models = args.models.length ? args.models : DEFAULT_MODELS;
  const repetitions = numberArg(args.repetitions, DEFAULT_REPETITIONS, "repetitions", 100);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(measurementPlan({ models, repetitions, machine: args.machine ?? MACHINE }), null, 2)}\n`);
    return;
  }
  if (!args.live) throw new Error("Pass --dry-run or explicit --live");
  const result = await runLiveMeasurement({
    productRoot: args.productRoot ?? process.cwd(),
    agentRoot: args.agentWorktree ?? process.env.NAIA_AGENT_WORKTREE,
    apiKey: process.env.NAIA_API_KEY,
    models,
    repetitions,
    output: args.output,
    timeoutMs: numberArg(args.timeoutMs, 120_000, "timeout-ms", 900_000),
    startTimeoutMs: numberArg(args.startTimeoutMs, 60_000, "start-timeout-ms", 300_000),
    machine: args.machine ?? MACHINE,
  });
  process.stdout.write(`${JSON.stringify({ output: result.outputPath, summary: result.report.summary }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`measure-agent-tool-calling: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
