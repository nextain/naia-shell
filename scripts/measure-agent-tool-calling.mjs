#!/usr/bin/env node
/**
 * #592 V1: measure the real Shell -> Agent -> gateway tool loop without Tauri.
 *
 * The live runner starts the pinned Agent entrypoint, registers Shell's full
 * always-on app catalog, sends five request families to each selected model,
 * and injects structured app-tool results. It never writes the API key or
 * Agent stderr to the evidence file.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";

export const ISSUE = "nextain/naia-shell#592";
export const MACHINE = "naia3090";
export const SHELL_BASELINE = "2941e3b4ac644cffb5be93d72991bb8e9e81f0d0";
export const SHELL_VERSION = "0.2.3";
export const AGENT_BASELINE = "1c2561db486c24c31d10ddbef5ca5f0ff766c7ad";
export const DEFAULT_MODELS = ["deepseek-v4-flash", "gpt-5.6-luna"];
export const DEFAULT_REPETITIONS = 10;
export const SUCCESS_THRESHOLD = 0.9;
export const AGENT_SHUTDOWN_NONCE = "naia-shell-592-shutdown-nonce";
export const SHELL_CATALOG_SOURCE_FILES = [
  "packages/shell/src/App.tsx",
  "packages/shell/src/lib/bgm-skill.ts",
  "packages/shell/src/lib/environment-skill.ts",
  "packages/shell/src/lib/browser-host-skill.ts",
];

const AGENT_RUNTIME_ENV_KEYS = [
  "PATH", "HOME", "TMP", "TMPDIR", "TEMP",
  "LANG", "LC_ALL", "LANGUAGE",
  "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
];

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

const ENVIRONMENT_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["observe", "watch", "unwatch", "focus", "interrupt", "run"],
      description: "observe | watch | unwatch | focus | interrupt | run",
    },
    surface: { type: "string", description: "observe 가 준 표면 손잡이. focus/run/interrupt 에 필요하다." },
    request: { type: "string", description: "run 에서 그 표면에 시킬 일." },
  },
  required: ["action"],
};

const BROWSER_REF = {
  ref: {
    type: "string",
    description: "직전 env_browser_snapshot 이 준 참조. 지어내지 않는다. 없으면 먼저 스냅샷을 찍는다.",
  },
};

function objectParameters(properties = {}, required = []) {
  return { type: "object", properties, required };
}

const BROWSER_HOST_TOOL_SPECS = [
  {
    name: "env_browser_create_workspace",
    description: "에이전트 전용 브라우저에 격리된 작업 공간을 하나 연다. 이 공간은 사용자의 브라우저가 아니고 화면도 없으며 로그인되어 있지 않다. 이후의 브라우저 도구는 이 공간에서 돈다.",
    parameters: objectParameters({ name: { type: "string", description: "이 일감을 부르는 짧은 이름." } }),
    tier: 1,
  },
  {
    name: "env_browser_list_workspaces",
    description: "지금 열려 있는 브라우저 작업 공간을 나열한다. 보기만 한다.",
    parameters: objectParameters(),
    tier: 1,
  },
  {
    name: "env_browser_close_workspace",
    description: "작업 공간 하나를 닫는다. 그 공간의 탭·쿠키·저장소가 사라진다.",
    parameters: objectParameters({ workspace_id: { type: "string", description: "닫을 공간의 손잡이." } }, ["workspace_id"]),
    tier: 1,
  },
  {
    name: "env_browser_open",
    description: "작업 공간에 새 탭을 열어 주소로 간다. 사용자의 창은 열리지 않는다.",
    parameters: BROWSER_NAVIGATE_PARAMETERS,
    tier: 1,
  },
  {
    name: "env_browser_navigate",
    description: "지금 탭에서 다른 주소로 간다.",
    parameters: BROWSER_NAVIGATE_PARAMETERS,
    tier: 1,
  },
  {
    name: "env_browser_snapshot",
    description: "지금 페이지의 접근성 구조를 참조가 달린 글로 받는다. 조작하기 전에 이것을 먼저 부른다 — 참조는 이 호출이 만든다.",
    parameters: objectParameters(),
    tier: 1,
  },
  {
    name: "env_browser_click",
    description: "스냅샷의 참조로 요소를 누른다. 참조로 못 잡을 때만 좌표를 쓰고, 그때는 why 에 이유를 적는다 — 그 사실이 결과에 남는다.",
    parameters: objectParameters({
      ...BROWSER_REF,
      x: { type: "number", description: "좌표 조작일 때의 x(CSS 픽셀)." },
      y: { type: "number", description: "좌표 조작일 때의 y(CSS 픽셀)." },
      why: { type: "string", description: "참조 대신 좌표를 쓴 이유." },
    }),
    tier: 1,
  },
  {
    name: "env_browser_fill",
    description: "스냅샷의 참조가 가리키는 입력란에 값을 넣는다.",
    parameters: objectParameters({ ...BROWSER_REF, value: { type: "string", description: "넣을 값." } }, ["value"]),
    tier: 1,
  },
  {
    name: "env_browser_evaluate",
    description: "페이지 안에서 한 덩어리 자바스크립트를 평가하고 값을 받는다. 효과가 고정된 평가다 — 여러 단계를 묶어 돌리는 것은 env_browser_script 이고 등급이 다르다.",
    parameters: objectParameters({ expression: { type: "string", description: "한 번에 값을 내는 식." } }, ["expression"]),
    tier: 1,
  },
  {
    name: "env_browser_screenshot",
    description: "지금 페이지를 캡처한다. 저장 위치는 감독자가 정하고 결과에는 그 참조만 온다 — 경로를 지정하지 않는다.",
    parameters: objectParameters(),
    tier: 1,
  },
  {
    name: "env_browser_close",
    description: "지금 탭을 닫는다. 작업 공간은 남는다.",
    parameters: objectParameters(),
    tier: 1,
  },
  {
    name: "env_browser_script",
    description: "여러 단계를 자바스크립트 한 덩어리로 묶어 브라우저에서 실행한다. 터미널에서 명령을 돌리는 것과 같은 등급이며 호출마다 사용자 승인이 필요하다. 승인이 없으면 거부되고, 거부는 실패다 — 형식 도구를 늘어놓아 같은 효과를 내려 하지 않는다.",
    parameters: objectParameters({ code: { type: "string", description: "실행할 자바스크립트." } }, ["code"]),
    tier: 2,
  },
];

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
    appId: "environment",
    name: "skill_environment",
    description: "사용자의 작업 표면(터미널·에이전트)을 관측하고 조작한다. 평소에는 표면이 몇 개 열려 있는지만 알려 주고 이름과 손잡이는 주지 않는다 — 자세히 알아야 할 때 스스로 부른다. observe=지금 무엇이 돌고 있는지 목록을 한 번 받는다(손잡이·이름·활동상태). watch=목록을 계속 곁에 두고 본다. 사용자의 작업을 따라가야 하는 동안 쓰고, 끝나면 unwatch 로 되돌린다 — 계속 켜 두면 요청마다 사용자의 터미널 이름이 실린다. unwatch=다시 개수만 보는 상태로 돌아간다. focus=그 표면을 앞으로 가져온다. run=그 표면에서 요청을 실행한다. interrupt=그 표면에서 돌고 있는 것을 멈춘다. surface 인자에는 observe 나 watch 가 준 손잡이를 그대로 쓴다 — 손잡이를 지어내지 않는다. 거절 사유가 오면 성공했다고 말하지 않는다.",
    parameters: ENVIRONMENT_PARAMETERS,
    tier: 1,
  },
  ...BROWSER_HOST_TOOL_SPECS.map((tool) => ({ appId: "browser-host", ...tool })),
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
    expectedTools: ["skill_youtube_bgm"],
    schema: BGM_PARAMETERS,
    acceptsArgs: (args) => args.action === "play" && (args.mode === undefined || args.mode === "player"),
  },
  {
    id: "radio-dj",
    prompt: "개인 라디오 DJ를 시작하고 잔잔한 음악을 틀어줘.",
    expectedTools: ["skill_youtube_bgm"],
    schema: BGM_PARAMETERS,
    acceptsArgs: (args) => args.action === "play" && args.mode === "radio_dj",
  },
  {
    id: "memo-save",
    prompt: "'우유 사기'라는 메모를 저장해줘.",
    expectedTools: ["memo_save"],
    schema: BUILTIN_TOOL_SCHEMAS.memo_save,
    acceptsArgs: (args) => typeof args.title === "string" && typeof args.content === "string",
  },
  {
    id: "weather",
    prompt: "서울의 현재 날씨를 알려줘.",
    expectedTools: ["get_weather"],
    schema: BUILTIN_TOOL_SCHEMAS.get_weather,
    acceptsArgs: (args) => Number.isFinite(args.latitude) && Number.isFinite(args.longitude),
  },
  {
    id: "browser-navigate",
    prompt: "인앱 브라우저에서 https://example.com으로 이동해줘.",
    expectedTools: ["env_browser_navigate", "env_browser_open"],
    allowedTools: BROWSER_HOST_TOOL_SPECS.map((tool) => tool.name),
    schema: BROWSER_NAVIGATE_PARAMETERS,
    acceptsArgs: (args) => typeof args.url === "string" && /^https?:\/\//u.test(args.url),
  },
];

const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|authorization|credential)/iu;
const JSON_STRING_KEYS = new Set(["argsJson", "rawJson"]);

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
      return { kind, message: payload.message ?? "", code: payload.code };
    case "finish":
      return { kind };
    default:
      return { kind };
  }
}

export function normalizeEvents(events) {
  return events.map(normalizeEvent).filter(Boolean);
}

function redactJsonString(value, secret) {
  const replaced = secret && secret.length > 0 ? value.split(secret).join("[REDACTED]") : value;
  try {
    return JSON.stringify(redactValue(JSON.parse(replaced), secret));
  } catch {
    return replaced;
  }
}

function redactValue(value, secret, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return JSON_STRING_KEYS.has(key) ? redactJsonString(value, secret) : secret && secret.length > 0 ? value.split(secret).join("[REDACTED]") : value;
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

export function redactReport(report, secret = "") {
  return redactValue(report, secret);
}

export function evidenceContainsSecret(evidence, secret) {
  return Boolean(secret) && JSON.stringify(evidence).includes(secret);
}

function failureFamily({ errorMessage, errorCode, setupFailure, matchingCall, unexpectedToolCalls, argumentsValid, toolResultObserved, toolResultSuccess, followUp, finishSeen }) {
  const message = String(errorMessage ?? "");
  const code = String(errorCode ?? "");
  if (setupFailure) return "harness-setup";
  if (/401|403|unauthor|api[ _-]?key|credential|auth/iu.test(message)) return "auth";
  if (/timeout|deadline|timed? out/iu.test(message)) return "timeout";
  if (/PROVIDER_NETWORK|gateway|provider error|openai-compat|http\s*\d{3}|status\s*[:=]?\s*\d{3}|stream|fetch|grpc|unavailable|network/iu.test(`${code} ${message}`)) return "gateway-stream";
  if (!matchingCall || unexpectedToolCalls > 0) return "model-tool-selection";
  if (!argumentsValid) return "tool-argument";
  if (!toolResultObserved || !toolResultSuccess) return "tool-execution";
  if (!followUp || !finishSeen) return "agent-follow-up";
  return "other";
}

function expectedToolNames(scenario) {
  return scenario.expectedTools ?? [scenario.expectedTool];
}

function allowedToolNames(scenario) {
  return scenario.allowedTools ?? expectedToolNames(scenario);
}

function eventArguments(event) {
  return parseJson(event.argsJson) ?? event.args ?? null;
}

function resultAfterCall(normalized, call) {
  if (!call.event.toolCallId) return undefined;
  return normalized
    .map((event, index) => ({ event, index }))
    .find(({ event, index }) => index > call.index && event.kind === "toolResult" && event.toolCallId === call.event.toolCallId);
}

export function evaluateAttempt({ scenario, model, attempt, events = [], latencyMs = null, error = "", setupFailure = false }) {
  const normalized = normalizeEvents(events);
  const expectedTools = expectedToolNames(scenario);
  const expectedToolSet = new Set(expectedTools);
  const allowedToolSet = new Set(allowedToolNames(scenario));
  const calls = normalized
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "toolUse" || event.kind === "appToolCall");
  const matching = calls.filter(({ event }) => expectedToolSet.has(event.toolName));
  const validMatching = matching.find(({ event }) => {
    const args = eventArguments(event);
    return validateToolArguments(args, scenario.schema) && scenario.acceptsArgs(args);
  });
  const lastToolIndex = calls.at(-1)?.index ?? -1;
  const matchingResult = validMatching ? resultAfterCall(normalized, validMatching) : undefined;
  const finishIndex = normalized.findLastIndex((event) => event.kind === "finish");
  const followUpText = normalized
    .slice(lastToolIndex + 1, finishIndex >= 0 ? finishIndex : normalized.length)
    .filter((event) => event.kind === "text")
    .map((event) => String(event.text ?? ""))
    .join("")
    .trim();
  const finishSeen = finishIndex >= 0;
  const errorEvents = normalized.filter((event) => event.kind === "error");
  const errorMessage = error || errorEvents.map((event) => event.message).join("; ");
  const errorCode = errorEvents.map((event) => event.code).find(Boolean);
  const argumentsValid = Boolean(validMatching);
  const toolResultObserved = Boolean(matchingResult);
  const toolResultSuccess = matchingResult?.event.success === true;
  const unexpectedToolCalls = calls.filter(({ event }) => !allowedToolSet.has(event.toolName));
  const finalResponse = Boolean(
    matchingResult
    && finishSeen
    && finishIndex > matchingResult.index
    && followUpText,
  );
  const success = Boolean(
    validMatching
    && toolResultObserved
    && toolResultSuccess
    && finalResponse
    && errorEvents.length === 0
    && unexpectedToolCalls.length === 0,
  );
  return {
    model,
    scenario: scenario.id,
    attempt,
    success,
    expectedTools,
    allowedTools: [...allowedToolSet],
    observedToolCalls: calls.map(({ event }) => ({
      kind: event.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      args: eventArguments(event),
    })),
    unexpectedToolCalls: unexpectedToolCalls.map(({ event }) => event.toolName),
    expectedToolObserved: matching.length > 0,
    argumentsValid,
    correlatedToolCallId: matchingResult?.event.toolCallId ?? null,
    toolResultObserved,
    toolResultSuccess,
    setupFailure,
    followUp: Boolean(followUpText),
    finalResponse,
    finishSeen,
    errorObserved: errorEvents.length > 0 || Boolean(error),
    errorCode: errorCode ?? null,
    finalTextLength: followUpText.length,
    latencyMs: latencyMs === null ? null : Math.round(latencyMs),
    failureFamily: success ? "none" : failureFamily({
      errorMessage,
      errorCode,
      setupFailure,
      matchingCall: matching.length > 0,
      unexpectedToolCalls: unexpectedToolCalls.length,
      argumentsValid,
      toolResultObserved,
      toolResultSuccess,
      followUp: Boolean(followUpText),
      finishSeen,
    }),
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
    scenarios: SCENARIOS.map(({ id, prompt, expectedTools }) => ({ id, prompt, expectedTools })),
  };
}

function command(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function buildAgentEnvironment({ apiKey, adkPath, parentEnv = process.env }) {
  if (!apiKey?.trim()) throw new Error("NAIA_API_KEY is required to build the Agent environment");
  if (!adkPath) throw new Error("NAIA_ADK_PATH is required to build the Agent environment");
  const env = {};
  for (const key of AGENT_RUNTIME_ENV_KEYS) {
    if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
  }
  return {
    ...env,
    NAIA_API_KEY: apiKey,
    NAIA_ADK_PATH: adkPath,
    NAIA_AGENT_MEMORY: "off",
    NAIA_AGENT_SKILLS: "on",
    NAIA_AGENT_TRANSCRIPT: "off",
    NAIA_AGENT_SHUTDOWN_NONCE: AGENT_SHUTDOWN_NONCE,
  };
}

function digestFiles(root, files) {
  const hash = createHash("sha256");
  const entries = [];
  for (const relativePath of [...files].sort()) {
    const absolutePath = join(root, relativePath);
    const stat = lstatSync(absolutePath);
    if (!stat.isFile()) throw new Error(`Digest source is not a regular file: ${relativePath}`);
    const content = readFileSync(absolutePath);
    hash.update(relativePath).update("\0").update(content).update("\0");
    entries.push({ path: relativePath, sha256: sha256(content) });
  }
  return { sha256: hash.digest("hex"), files: entries };
}

function digestTree(root) {
  const hash = createHash("sha256");
  let fileCount = 0;
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Compiled Agent tree contains unsupported entry: ${relativePath}`);
      hash.update(relativePath).update("\0").update(readFileSync(absolutePath)).update("\0");
      fileCount += 1;
    }
  };
  visit(root, "");
  return { sha256: hash.digest("hex"), fileCount };
}

function assertCleanCheckout(root, label) {
  if (command(root, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error(`${label} worktree must be clean before live measurement`);
  }
}

function buildPinnedAgent(agentRoot) {
  try {
    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    execFileSync(pnpm, ["--dir", agentRoot, "exec", "tsc", "-p", "tsconfig.json", "--incremental", "false"], { stdio: "ignore" });
    execFileSync(pnpm, ["--dir", agentRoot, "build"], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`Pinned Agent build failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const unexpectedChanges = changedFiles.filter((file) => !allowedChanges.has(file) && !/^docs\/regression-runs\/[^/]+\.json$/u.test(file));
  if (unexpectedChanges.length) throw new Error(`Shell measurement branch contains unrelated changes: ${unexpectedChanges.join(", ")}`);
  const agentCommit = command(agentRoot, ["rev-parse", "HEAD"]);
  if (agentCommit !== AGENT_BASELINE) throw new Error(`Agent baseline mismatch: expected ${AGENT_BASELINE}, got ${agentCommit}`);
  assertCleanCheckout(agentRoot, "Agent");
  const agentEntry = join(agentRoot, "scripts/builds/agent-stdio-entry.mjs");
  const proto = join(agentRoot, "src/main/adapters/grpc/naia_agent.proto");
  if (!existsSync(agentEntry) || !existsSync(proto)) throw new Error("Pinned Agent checkout is missing its entrypoint or proto");
  buildPinnedAgent(agentRoot);
  assertCleanCheckout(agentRoot, "Agent after build");
  if (command(agentRoot, ["rev-parse", "HEAD"]) !== agentCommit) throw new Error("Pinned Agent HEAD changed during build");
  const agentDist = join(agentRoot, "dist/main");
  if (!existsSync(agentDist)) throw new Error("Pinned Agent build did not produce dist/main");
  return {
    productCommit,
    shellBaseline: SHELL_BASELINE,
    shellVersion: shellPackage.version,
    agentCommit,
    agentProtoSha256: sha256(readFileSync(proto)),
    agentDist: digestTree(agentDist),
    shellCatalog: digestFiles(productRoot, SHELL_CATALOG_SOURCE_FILES),
  };
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
    env: buildAgentEnvironment({ apiKey, adkPath }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrLength = 0;
  child.stderr.on("data", (chunk) => { stderrLength += chunk.length; });
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Agent process failed to start: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Agent exited before gRPC listening (code ${code ?? "unknown"})`));
    });
  }).catch(async (error) => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      if (!await waitForExit(child, 10_000)) throw new Error("Agent did not exit after startup failure");
    }
    throw error;
  });
  return { child, address, stderrLength };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 10_000)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, 10_000)) throw new Error("Agent did not exit after SIGKILL");
}

function appToolResult(toolName, args) {
  if (toolName === "skill_youtube_bgm") {
    return { observed: true, status: "playing", action: args?.action ?? "play", mode: args?.mode ?? "player", videoId: "fixture-video" };
  }
  if (toolName === "env_browser_navigate" || toolName === "env_browser_open") {
    return { observed: true, status: "navigated", url: args?.url ?? "" };
  }
  return { observed: true, status: "accepted" };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function chatAttempt({ client, scenario, model, attempt, timeoutMs }) {
  const started = performance.now();
  const events = [];
  const pendingResponses = new Set();
  const allowedTools = new Set(allowedToolNames(scenario));
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
    let settled = false;
    const timer = setTimeout(() => {
      call.cancel();
      void settleError(Object.assign(new Error("Agent chat timeout"), { events }));
    }, timeoutMs);
    const trackResponse = (promise, message) => {
      const tracked = Promise.resolve(promise).catch(() => {
        events.push({ kind: "error", message });
      });
      pendingResponses.add(tracked);
      void tracked.then(
        () => pendingResponses.delete(tracked),
        () => pendingResponses.delete(tracked),
      );
    };
    const waitForResponses = async () => {
      await Promise.all([...pendingResponses]);
    };
    const settleEnd = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await waitForResponses();
      resolveAttempt({ events, latencyMs: performance.now() - started });
    };
    const settleError = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await waitForResponses();
      rejectAttempt(Object.assign(error, { events }));
    };
    call.on("data", (event) => {
      events.push(event);
      const normalized = normalizeEvent(event);
      if (normalized?.kind === "appToolCall") {
        const args = parseJson(normalized.argsJson) ?? {};
        const expected = allowedTools.has(normalized.toolName);
        trackResponse(withTimeout(unary(client, "appToolResult", {
          requestId,
          toolCallId: normalized.toolCallId,
          output: JSON.stringify(appToolResult(normalized.toolName, args)),
          success: expected,
        }), 10_000, "app tool result delivery timeout"), "app tool result delivery failed");
      } else if (normalized?.kind === "approvalRequest") {
        const expected = allowedTools.has(normalized.toolName);
        trackResponse(withTimeout(unary(client, "approvalResponse", {
          requestId,
          toolCallId: normalized.toolCallId,
          decision: expected ? 1 : 0,
        }), 10_000, "approval delivery timeout"), "approval delivery failed");
      }
    });
    call.once("end", () => { void settleEnd(); });
    call.once("error", (error) => {
      void settleError(error);
    });
  });
  return { evaluation: evaluateAttempt({ scenario, model, attempt, ...result }), events };
}

export function verifyRegisteredAppCatalog(response) {
  if (!Array.isArray(response?.tools)) throw new Error("Agent listSkills returned no tool catalog");
  const expected = new Map(APP_TOOL_SPECS.map((tool) => [tool.name, tool]));
  const actual = response.tools.filter((tool) => expected.has(tool?.name));
  if (actual.length !== expected.size) {
    throw new Error(`Agent app tool catalog mismatch: expected ${expected.size}, got ${actual.length}`);
  }
  for (const [name, expectedTool] of expected) {
    const actualTool = actual.find((tool) => tool.name === name);
    if (!actualTool || actualTool.description !== expectedTool.description) {
      throw new Error(`Agent app tool description mismatch: ${name}`);
    }
    let actualParameters;
    try {
      actualParameters = JSON.parse(actualTool.parametersJson ?? "{}");
    } catch {
      throw new Error(`Agent app tool schema is not JSON: ${name}`);
    }
    if (stableJson(actualParameters) !== stableJson(expectedTool.parameters)) {
      throw new Error(`Agent app tool schema mismatch: ${name}`);
    }
    const expectedTier = expectedTool.tier > 0 ? 1 : 0;
    if (Number(actualTool.tier ?? 0) !== expectedTier) {
      throw new Error(`Agent app tool tier mismatch: ${name}`);
    }
  }
  return true;
}

async function runAttempt({ productRoot, agentRoot, grpcRuntime, apiKey, model, scenario, attempt, timeoutMs, startTimeoutMs }) {
  const adkPath = await seedAdk(model);
  let runtime;
  let client;
  let result;
  let setupComplete = false;
  try {
    runtime = await startAgent({ agentRoot, adkPath, apiKey, startTimeoutMs });
    client = new grpcRuntime.Client(runtime.address, grpcRuntime.grpc.credentials.createInsecure());
    const settings = await unary(client, "setWorkspace", { adkPath });
    if (settings?.loaded !== true || settings.provider !== "nextain" || settings.model !== model) {
      throw new Error(`Agent settings mismatch for ${model}`);
    }
    const toolsByApp = new Map();
    for (const tool of APP_TOOL_SPECS) {
      const tools = toolsByApp.get(tool.appId) ?? [];
      tools.push(tool);
      toolsByApp.set(tool.appId, tools);
    }
    for (const [appId, tools] of toolsByApp) {
      const ack = await unary(client, "registerAppSkills", {
        appId,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJson: JSON.stringify(tool.parameters),
          tier: tool.tier,
        })),
      });
      if (ack?.ok !== true) throw new Error(`App tool registration failed: ${appId}`);
    }
    verifyRegisteredAppCatalog(await unary(client, "listSkills", {}));
    setupComplete = true;
    const chat = await chatAttempt({ client, scenario, model, attempt, timeoutMs });
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
      setupFailure: !setupComplete,
    });
    result._events = events;
  } finally {
    let cleanupError;
    try {
      client?.close?.();
      await stopAgent(runtime?.child);
    } catch (error) {
      cleanupError = error;
    } finally {
      await rm(adkPath, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
  }
  return redactReport({
    ...result,
    evidence: { events: redactEvents(result._events ?? [], apiKey) },
  }, apiKey);
}

export function resolveEvidenceOutputPath(productRoot, output) {
  const evidenceRoot = resolve(productRoot, "docs/regression-runs");
  const outputPath = isAbsolute(output) ? resolve(output) : resolve(productRoot, output);
  const relativeOutput = relative(evidenceRoot, outputPath);
  if (!relativeOutput || relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) {
    throw new Error("Live evidence output must be under docs/regression-runs");
  }
  if (!outputPath.endsWith(".json")) throw new Error("Live evidence output must be a .json file");
  return outputPath;
}

export function validateReport(report) {
  if (!isObject(report) || report.schemaVersion !== 1 || report.kind !== "naia-shell-592-tool-call-measurement") {
    throw new Error("Invalid #592 measurement report shape");
  }
  if (!isObject(report.provenance) || !isObject(report.plan) || !isObject(report.summary) || !Array.isArray(report.attempts)) {
    throw new Error("Incomplete #592 measurement report");
  }
  return true;
}

async function writeReportAtomic(outputPath, report) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  validateReport(JSON.parse(serialized));
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, serialized, { mode: 0o600 });
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const written = JSON.parse(readFileSync(outputPath, "utf8"));
  validateReport(written);
  return written;
}

export async function runLiveMeasurement({ productRoot = process.cwd(), agentRoot, apiKey, models = DEFAULT_MODELS, repetitions = DEFAULT_REPETITIONS, output, timeoutMs = 120_000, startTimeoutMs = 60_000, machine = MACHINE }) {
  if (!apiKey?.trim()) throw new Error("NAIA_API_KEY is required for --live and is never written to evidence");
  if (!agentRoot) throw new Error("--agent-worktree is required for --live");
  if (!output) throw new Error("--output is required for --live");
  const product = resolve(productRoot);
  const agent = realpathSync(resolve(agentRoot));
  const outputPath = resolveEvidenceOutputPath(product, output);
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
  const safeReport = redactReport(report, apiKey);
  if (evidenceContainsSecret(safeReport, apiKey)) throw new Error("Refusing to write evidence containing NAIA_API_KEY");
  await mkdir(dirname(outputPath), { recursive: true });
  return { outputPath, report: await writeReportAtomic(outputPath, safeReport) };
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
