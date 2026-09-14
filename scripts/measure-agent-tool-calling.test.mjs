import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SHUTDOWN_NONCE,
  APP_TOOL_CATALOG_SHA256,
  APP_TOOL_SPECS,
  DEFAULT_MODELS,
  SCENARIOS,
  aggregateAttempts,
  buildAgentEnvironment,
  evidenceContainsSecret,
  evaluateAttempt,
  measurementPlan,
  redactEvents,
  redactReport,
  resolveEvidenceOutputPath,
  validateReport,
  validateToolArguments,
  verifyRegisteredAppCatalog,
} from "./measure-agent-tool-calling.mjs";

function appCall(toolName, args, toolCallId = "call-1") {
  return {
    requestId: "r1",
    event: "appToolCall",
    appToolCall: { toolCallId, toolName, argsJson: JSON.stringify(args) },
  };
}

function builtinCall(toolName, args, toolCallId = "call-1") {
  return {
    requestId: "r1",
    event: "toolUse",
    toolUse: { toolCallId, toolName, argsJson: JSON.stringify(args) },
  };
}

function toolResult(toolName, toolCallId = "call-1", success = true) {
  return {
    requestId: "r1",
    event: "toolResult",
    toolResult: { toolCallId, toolName, output: "ok", success },
  };
}

function finished(toolName, toolCallId = "call-1", success = true, text = "처리했습니다.") {
  return [
    toolResult(toolName, toolCallId, success),
    { requestId: "r1", event: "text", text: { text } },
    { requestId: "r1", event: "finish", finish: {} },
  ];
}

function registeredCatalog() {
  return {
    tools: APP_TOOL_SPECS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJson: JSON.stringify(tool.parameters),
      tier: tool.tier > 0 ? 1 : 0,
    })),
  };
}

test("measurement plan fixes the two models, five request families, full app catalog, and ten repetitions", () => {
  const plan = measurementPlan();
  assert.deepEqual(plan.models, DEFAULT_MODELS);
  assert.equal(plan.repetitions, 10);
  assert.equal(plan.scenarios.length, 5);
  assert.equal(plan.requiredSuccesses, 9);
  assert.equal(plan.appTools.length, 14);
  assert.deepEqual(
    plan.scenarios.find((scenario) => scenario.id === "browser-navigate").expectedTools,
    ["env_browser_navigate", "env_browser_open"],
  );
  assert.match(APP_TOOL_CATALOG_SHA256, /^[a-f0-9]{64}$/u);
});

test("Agent environment keeps launch basics and rejects measurement-affecting inherited variables", () => {
  const env = buildAgentEnvironment({
    apiKey: "test-key",
    adkPath: "/tmp/issue-592-adk",
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/home/test",
      LANG: "ko_KR.UTF-8",
      AGENT_PROVIDER: "fake",
      NAIA_AGENT_GRPC_ADDR: "127.0.0.1:50051",
      NAIA_SHELL_TOOL: "1",
      NAIA_MEMO_PATH: "/outside/memos.json",
      NAIA_CONVERSATIONS_DIR: "/outside/conversations",
      NODE_OPTIONS: "--require=untrusted.js",
      OTHER_SECRET: "must-not-cross",
    },
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/test");
  assert.equal(env.NAIA_API_KEY, "test-key");
  assert.equal(env.NAIA_ADK_PATH, "/tmp/issue-592-adk");
  assert.equal(env.NAIA_AGENT_MEMORY, "off");
  assert.equal(env.NAIA_AGENT_SKILLS, "on");
  assert.equal(env.NAIA_AGENT_TRANSCRIPT, "off");
  assert.equal(env.NAIA_AGENT_SHUTDOWN_NONCE, AGENT_SHUTDOWN_NONCE);
  for (const key of [
    "AGENT_PROVIDER", "NAIA_AGENT_GRPC_ADDR", "NAIA_SHELL_TOOL", "NAIA_MEMO_PATH",
    "NAIA_CONVERSATIONS_DIR", "NODE_OPTIONS", "OTHER_SECRET",
  ]) assert.equal(env[key], undefined, `${key} must not be inherited`);
});

test("Shell app schemas accept normal arguments and keep ordinary playback separate from radio DJ", () => {
  const youtube = SCENARIOS.find((scenario) => scenario.id === "youtube-play");
  const radio = SCENARIOS.find((scenario) => scenario.id === "radio-dj");
  const browser = SCENARIOS.find((scenario) => scenario.id === "browser-navigate");
  assert.equal(validateToolArguments({ action: "play", mode: "player" }, youtube.schema), true);
  assert.equal(youtube.acceptsArgs({ action: "play", mode: "radio_dj" }), false);
  assert.equal(radio.acceptsArgs({ action: "play", mode: "radio_dj" }), true);
  assert.equal(validateToolArguments({ action: "explode" }, radio.schema), false);
  assert.equal(validateToolArguments({ url: "https://example.com" }, browser.schema), true);
  assert.equal(validateToolArguments({ url: 42 }, browser.schema), false);
});

test("registration verification requires the complete exact app catalog", () => {
  assert.equal(verifyRegisteredAppCatalog(registeredCatalog()), true);
  const missing = registeredCatalog();
  missing.tools = missing.tools.filter((tool) => tool.name !== "env_browser_open");
  assert.throws(() => verifyRegisteredAppCatalog(missing), /catalog mismatch/u);
  const malformed = registeredCatalog();
  malformed.tools.find((tool) => tool.name === "env_browser_navigate").parametersJson = "{}";
  assert.throws(() => verifyRegisteredAppCatalog(malformed), /schema mismatch/u);
});

test("successful app-tool call requires a correlated successful result, follow-up text, and finish", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "radio-dj");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    latencyMs: 1234.6,
    events: [appCall("skill_youtube_bgm", { action: "play", mode: "radio_dj" }), ...finished("skill_youtube_bgm")],
  });
  assert.equal(result.success, true);
  assert.equal(result.argumentsValid, true);
  assert.equal(result.correlatedToolCallId, "call-1");
  assert.equal(result.toolResultObserved, true);
  assert.equal(result.toolResultSuccess, true);
  assert.equal(result.followUp, true);
  assert.equal(result.finalResponse, true);
  assert.equal(result.errorObserved, false);
  assert.equal(result.latencyMs, 1235);
});

test("browser preparation calls are allowed before the expected navigation call", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "browser-navigate");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    events: [
      appCall("env_browser_create_workspace", { name: "issue-592" }, "create-1"),
      toolResult("env_browser_create_workspace", "create-1"),
      appCall("env_browser_open", { url: "https://example.com" }, "open-1"),
      toolResult("env_browser_open", "open-1"),
      appCall("env_browser_navigate", { url: "https://example.com/docs" }, "navigate-1"),
      toolResult("env_browser_navigate", "navigate-1"),
      { requestId: "r1", event: "text", text: { text: "이동했습니다." } },
      { requestId: "r1", event: "finish", finish: {} },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.unexpectedToolCalls, []);
  assert.equal(result.correlatedToolCallId, "open-1");
});

test("a tool call without a correlated result is a tool-execution failure", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "memo-save");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    events: [builtinCall("memo_save", { title: "우유 사기", content: "우유를 산다" }), { requestId: "r1", event: "finish", finish: {} }],
  });
  assert.equal(result.success, false);
  assert.equal(result.expectedToolObserved, true);
  assert.equal(result.argumentsValid, true);
  assert.equal(result.toolResultObserved, false);
  assert.equal(result.failureFamily, "tool-execution");
});

test("a failed tool result or error event cannot count as a successful final response", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "memo-save");
  const failedTool = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    events: [builtinCall("memo_save", { title: "우유 사기", content: "우유를 산다" }), ...finished("memo_save", "call-1", false)],
  });
  assert.equal(failedTool.success, false);
  assert.equal(failedTool.toolResultObserved, true);
  assert.equal(failedTool.toolResultSuccess, false);
  assert.equal(failedTool.failureFamily, "tool-execution");

  const withError = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 2,
    events: [
      builtinCall("memo_save", { title: "우유 사기", content: "우유를 산다" }),
      ...finished("memo_save"),
      { requestId: "r1", event: "error", error: { message: "late provider error" } },
    ],
  });
  assert.equal(withError.success, false);
  assert.equal(withError.errorObserved, true);
});

test("gateway and setup failures are classified before selection or follow-up", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "youtube-play");
  const gateway = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    error: "provider error: OpenAI-compat https://api.nextain.io/v1 failed: 500",
    events: [],
  });
  assert.equal(gateway.failureFamily, "gateway-stream");
  const setup = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    setupFailure: true,
    error: "Agent app tool catalog mismatch",
    events: [],
  });
  assert.equal(setup.failureFamily, "harness-setup");
});

test("redaction removes credential-shaped objects, JSON strings, and full attempt fields", () => {
  const secret = "naia-secret-value";
  const rawEvents = [
    {
      kind: "appToolCall",
      appToolCall: {
        toolCallId: "c1",
        toolName: "env_browser_navigate",
        argsJson: JSON.stringify({ apiKey: secret, nested: { authorization: "other-secret" } }),
      },
    },
  ];
  const evidence = redactEvents(rawEvents, secret);
  const parsedArgs = JSON.parse(evidence[0].appToolCall.argsJson);
  assert.equal(parsedArgs.apiKey, "[REDACTED]");
  assert.equal(parsedArgs.nested.authorization, "[REDACTED]");

  const report = redactReport({
    attempts: [{
      observedToolCalls: [{ args: { apiKey: secret } }],
      error: `provider returned ${secret}`,
      evidence: { events: rawEvents },
    }],
  }, secret);
  assert.equal(evidenceContainsSecret(report, secret), false);
  assert.equal(report.attempts[0].observedToolCalls[0].args.apiKey, "[REDACTED]");
  assert.equal(report.attempts[0].error, "provider returned [REDACTED]");
});

test("evidence output is constrained to JSON files under docs/regression-runs", () => {
  const root = "/tmp/naia-shell-592";
  assert.equal(resolveEvidenceOutputPath(root, "docs/regression-runs/receipt.json"), `${root}/docs/regression-runs/receipt.json`);
  assert.throws(() => resolveEvidenceOutputPath(root, "tmp/receipt.json"), /under docs\/regression-runs/u);
  assert.throws(() => resolveEvidenceOutputPath(root, "docs/regression-runs/receipt.txt"), /\.json/u);
  assert.equal(validateReport({
    schemaVersion: 1,
    kind: "naia-shell-592-tool-call-measurement",
    provenance: {},
    plan: {},
    summary: {},
    attempts: [],
  }), true);
});

test("9 of 10 passes meets the gate and 8 of 10 does not", () => {
  const make = (success, index) => ({ model: "m", scenario: "s", success, failureFamily: success ? "none" : "agent-follow-up", attempt: index });
  const pass = aggregateAttempts([...Array.from({ length: 9 }, (_, index) => make(true, index + 1)), make(false, 10)], 10);
  const fail = aggregateAttempts([...Array.from({ length: 8 }, (_, index) => make(true, index + 1)), ...Array.from({ length: 2 }, (_, index) => make(false, index + 9))], 10);
  assert.equal(pass.meetsThreshold, true);
  assert.equal(pass.groups[0].passed, 9);
  assert.equal(fail.meetsThreshold, false);
  assert.equal(fail.groups[0].passed, 8);
});
