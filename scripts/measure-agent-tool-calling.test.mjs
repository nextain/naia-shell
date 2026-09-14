import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_TOOL_CATALOG_SHA256,
  DEFAULT_MODELS,
  SCENARIOS,
  aggregateAttempts,
  evidenceContainsSecret,
  evaluateAttempt,
  measurementPlan,
  redactEvents,
  validateToolArguments,
} from "./measure-agent-tool-calling.mjs";

function appCall(toolName, args) {
  return {
    requestId: "r1",
    event: "appToolCall",
    appToolCall: { toolCallId: "call-1", toolName, argsJson: JSON.stringify(args) },
  };
}

function builtinCall(toolName, args) {
  return {
    requestId: "r1",
    event: "toolUse",
    toolUse: { toolCallId: "call-1", toolName, argsJson: JSON.stringify(args) },
  };
}

function finished(text = "처리했습니다.") {
  return [
    { requestId: "r1", event: "toolResult", toolResult: { toolCallId: "call-1", toolName: "fixture", output: "ok", success: true } },
    { requestId: "r1", event: "text", text: { text } },
    { requestId: "r1", event: "finish", finish: {} },
  ];
}

test("measurement plan fixes the two models, five request families, and ten repetitions", () => {
  const plan = measurementPlan();
  assert.deepEqual(plan.models, DEFAULT_MODELS);
  assert.equal(plan.repetitions, 10);
  assert.equal(plan.scenarios.length, 5);
  assert.equal(plan.requiredSuccesses, 9);
  assert.match(APP_TOOL_CATALOG_SHA256, /^[a-f0-9]{64}$/u);
});

test("Shell app schemas accept normal YouTube and browser arguments and reject malformed values", () => {
  const youtube = SCENARIOS.find((scenario) => scenario.id === "radio-dj");
  const browser = SCENARIOS.find((scenario) => scenario.id === "browser-navigate");
  assert.equal(validateToolArguments({ action: "play", mode: "radio_dj" }, youtube.schema), true);
  assert.equal(validateToolArguments({ action: "explode" }, youtube.schema), false);
  assert.equal(validateToolArguments({ url: "https://example.com" }, browser.schema), true);
  assert.equal(validateToolArguments({ url: 42 }, browser.schema), false);
});

test("successful app-tool call requires valid args, follow-up text, and finish", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "radio-dj");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    latencyMs: 1234.6,
    events: [appCall("skill_youtube_bgm", { action: "play", mode: "radio_dj" }), ...finished()],
  });
  assert.equal(result.success, true);
  assert.equal(result.argumentsValid, true);
  assert.equal(result.followUp, true);
  assert.equal(result.finalResponse, true);
  assert.equal(result.latencyMs, 1235);
});

test("a tool call without a final answer is classified as an Agent follow-up failure", () => {
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
  assert.equal(result.failureFamily, "agent-follow-up");
});

test("wrong tool arguments are not counted as a successful call", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "weather");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    events: [builtinCall("get_weather", { city: "Seoul" }), ...finished()],
  });
  assert.equal(result.success, false);
  assert.equal(result.argumentsValid, false);
  assert.equal(result.failureFamily, "tool-argument");
});

test("gateway stream errors stay distinct from an Agent follow-up failure", () => {
  const scenario = SCENARIOS.find((entry) => entry.id === "youtube-play");
  const result = evaluateAttempt({
    scenario,
    model: DEFAULT_MODELS[0],
    attempt: 1,
    error: "gateway stream closed before final response",
    events: [appCall("skill_youtube_bgm", { action: "play" })],
  });
  assert.equal(result.success, false);
  assert.equal(result.failureFamily, "gateway-stream");
});

test("redaction removes credential-shaped fields and exact key values", () => {
  const secret = "naia-secret-value";
  const evidence = redactEvents([
    { kind: "log", apiKey: secret, nested: { authorization: "Bearer secret" }, text: `value=${secret}` },
  ], secret);
  assert.equal(evidenceContainsSecret(evidence, secret), false);
  assert.equal(evidence[0].apiKey, "[REDACTED]");
  assert.equal(evidence[0].nested.authorization, "[REDACTED]");
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
