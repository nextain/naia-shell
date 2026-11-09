import { describe, expect, it } from "vitest";
import { defaultMainModel, defaultSmallModel, smallModelChoices } from "../small-model";
import { readConfiguredLlmRoles, writeConfiguredLlmRole } from "../roles";
import { applyNaiaSlotDefaults } from "../../slots/model";
import type { AppConfig } from "../../config";

const config: AppConfig = { provider: "nextain", model: "main", apiKey: "" };
const models = ["gpt-5.6-luna", "gpt-5.4-nano", "solar-mini"].map(id => ({ id, label: id, capabilities: ["llm"] as ("llm")[] }));
const meta = (id: string) => ({ id, label: id, capabilities: ["llm"] as ("llm")[] });

describe("UT-SM-01 small model selection", () => {
 it("chooses catalog Luna or inherits main", () => {
  expect(defaultSmallModel(models)).toEqual({ provider: "nextain", model: "gpt-5.6-luna", thinkingLevel: "low" });
  expect(defaultSmallModel([])).toEqual({ inherit: "main" });
 });
 it("filters nano but retains solar and explicit selections", () => {
  expect(smallModelChoices(models).map(m => m.id)).toEqual(["gpt-5.6-luna", "solar-mini"]);
  const next = writeConfiguredLlmRole(config, "sub", { provider: "nextain", model: "explicit" });
  expect(readConfiguredLlmRoles(next).sub?.model).toBe("explicit");
  expect(next.subLlmModel).toBe("explicit");
 });
 it("UT-SM-02 inherits legacy memory", () => {
  expect(readConfiguredLlmRoles({ ...config, memoryLlmProvider: "ollama", memoryLlmModel: "qwen" }).sub).toEqual({ inherit: "memory" });
 });
});

describe("UT-SM-03 automatic slot defaults", () => {
 it("does not mask legacy memory or overwrite disabled memory", () => {
  const legacy = { ...config, memoryLlmProvider: "ollama" as const, memoryLlmModel: "qwen" };
  const result = applyNaiaSlotDefaults(legacy, models);
  expect(result.llmRoles?.sub).toBeUndefined();
  expect(readConfiguredLlmRoles(result).sub).toEqual({ inherit: "memory" });
  expect(result.memoryLlmModel).toBe("qwen");
  const disabled = applyNaiaSlotDefaults({ ...config, memoryLlmProvider: "none" }, models);
  expect(disabled.memoryLlmProvider).toBe("none");
  expect(disabled.llmRoles?.sub).toBeUndefined();
 });
 it("respects legacy sub, partial legacy memory, and explicit main inheritance", () => {
  const catalog = models;
  const flat = applyNaiaSlotDefaults({ ...config, subLlmProvider: "ollama", subLlmModel: "chosen", memoryLlmProvider: "nextain", memoryLlmModel: "old" }, catalog);
  expect(readConfiguredLlmRoles(flat).sub).toMatchObject({ provider: "ollama", model: "chosen" });
  const partial = applyNaiaSlotDefaults({ ...config, memoryLlmModel: "old" }, catalog);
  expect(partial.llmRoles?.sub).toBeUndefined();
  const inherited = applyNaiaSlotDefaults({ ...config, llmRoles: { sub: { inherit: "main" } } }, catalog);
  expect(inherited.llmRoles?.sub).toEqual({ inherit: "main" });
  expect(applyNaiaSlotDefaults(config, []).llmRoles?.sub).toEqual({ inherit: "main" });
 });
});
describe("UT-SM-04 Terra present", () => {
 it("chooses Terra xhigh and preserves an existing main", () => {
  const catalog = [meta("solar-pro4"), meta("gpt-6.1-terra")];
  expect(defaultMainModel(catalog)).toEqual({ provider: "nextain", model: "gpt-6.1-terra", thinkingLevel: "xhigh" });
  expect(applyNaiaSlotDefaults(config, catalog).model).toBe("main");
 });
});
describe("UT-SM-05 Terra absent", () => {
 it("selects the next available recommendation", () => {
  expect(defaultMainModel([meta("gpt-5.6-luna"), meta("solar-pro4")])).toEqual({ provider: "nextain", model: "solar-pro4" });
 });
});
