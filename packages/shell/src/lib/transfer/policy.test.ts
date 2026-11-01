import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertTransferPath, validateMemoryStore } from "./policy";
import { sanitizeSettings, hasSensitiveFields, isSensitive } from "./sanitize";

const fact = {
  id: "a", content: "b", entities: ["person"], topics: ["topic"],
  createdAt: 1, updatedAt: 2, importance: 0.5, recallCount: 0,
  lastAccessed: 3, strength: 1, sourceEpisodes: ["episode"], extra: "preserved",
};

describe("UT-TRANSFER-02 path validation", () => {
  it.each(["../docs/a.md", "/docs/a.md", "docs/../x", "docs\\x", "docs/CON.txt", "docs/a//b"])('rejects %s', (path) => {
    expect(() => assertTransferPath(path)).toThrow();
  });
});

describe("UT-TRANSFER-05 secret policy", () => {
  it.each(["data-private/x", "naia-settings/.keys/a", "naia-settings/credentials", "docs/.env", "docs/api-key.txt", "docs/mysecret.txt", "docs/secure-keys.dat", "docs/x.dpapi", "docs/node_modules/a", "docs/model.gguf"])('rejects %s', (path) => {
    expect(() => assertTransferPath(path)).toThrow();
  });
  it("sanitizes recursively and reports only a count", () => {
    const input = { apiKey: "value", child: [{ gatewayToken: "value", good: 3 }] };
    expect(hasSensitiveFields(input)).toBe(true);
    expect(sanitizeSettings(input)).toEqual({ value: { child: [{ good: 3 }] }, removed: 2 });
  });
});

describe("UT-TRANSFER-06 memory structure", () => {
  it("accepts facts with required fields and rejects invalid facts", () => {
    expect(validateMemoryStore({ facts: [fact] })).toBe(1);
    expect(() => validateMemoryStore({ facts: [{ id: "a" }] })).toThrow();
    expect(() => validateMemoryStore({})).toThrow();
  });
});

describe("UT-TRANSFER-07 general secret names", () => {
  it("removes varied names in nested objects and arrays using the same import predicate", () => {
    const settings = {
      serviceToken: "x", fooSecret: "x", x_api_key: "x", ClientPassword: "x",
      nested: { private_key: "x", safe: [{ SessionId: "x", myKey: "x", theme: "dark" }] },
    };
    const result = sanitizeSettings(settings);
    expect(result.removed).toBe(7);
    expect(result.value).toEqual({ nested: { safe: [{ theme: "dark" }] } });
    expect(hasSensitiveFields(settings)).toBe(true);
    expect(hasSensitiveFields(result.value)).toBe(false);
  });

  it.each(["a-token-value", "x_secret_suffix", "ClientPassword", "xPassWd", "CredentialId", "cookieJar", "sessionId", "x_API_KEY_id", "x-private_key-id", "authMode", "someKey", "some_key"])('classifies %s', (key) => {
    expect(isSensitive(key)).toBe(true);
  });

  it("classifies all actual config and ADK setting names, without silently removing a new non-secret field", () => {
    const config = ts.createSourceFile("config.ts", readFileSync(new URL("../config.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const adk = ts.createSourceFile("adk-store.ts", readFileSync(new URL("../adk-store.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const keys = new Set<string>();
    function visit(node: ts.Node, active = false): void {
      if (ts.isInterfaceDeclaration(node) && ["AppConfig", "LlmRoleConfig"].includes(node.name.text)) active = true;
      if (ts.isVariableDeclaration(node) && ["SECRET_CONFIG_KEYS", "UI_ONLY_CONFIG_KEYS", "UI_PERSIST_KEYS"].includes(node.name.getText())) active = true;
      if (active && ts.isPropertySignature(node) && node.name && ts.isIdentifier(node.name)) keys.add(node.name.text);
      if (active && ts.isStringLiteral(node) && ts.isArrayLiteralExpression(node.parent)) keys.add(node.text);
      ts.forEachChild(node, (child) => visit(child, active));
    }
    visit(config);
    visit(adk);
    expect(keys.size).toBeGreaterThan(100);
    const secretNames = ["credentialRef", "apiKey", "subLlmApiKey", "subLlmCredentialRef", "memoryLlmCredentialRef", "gatewayToken", "naiaKey", "googleApiKey", "openaiTtsApiKey", "elevenlabsApiKey", "openaiRealtimeApiKey", "memoryEmbeddingApiKey", "memoryLlmApiKey", "qdrantApiKey", "naiaUserId"];
    expect([...keys].filter(isSensitive).sort()).toEqual(secretNames.sort());
    for (const key of keys) {
      expect(sanitizeSettings({ [key]: "value" }).removed).toBe(secretNames.includes(key) ? 1 : 0);
    }
  });
});

describe("UT-TRANSFER-09 AgentFact required fields", () => {
  it.each(Object.keys(fact).filter((key) => key !== "extra"))("rejects missing %s", (key) => {
    const copy: Record<string, unknown> = { ...fact };
    delete copy[key];
    expect(() => validateMemoryStore({ facts: [copy] })).toThrow();
  });
  it.each(Object.keys(fact).filter((key) => key !== "extra"))("rejects wrong type for %s", (key) => {
    const wrong = Array.isArray(fact[key as keyof typeof fact]) ? [1] : typeof fact[key as keyof typeof fact] === "number" ? "1" : 1;
    expect(() => validateMemoryStore({ facts: [{ ...fact, [key]: wrong }] })).toThrow();
  });
  it("rejects duplicate ids", () => {
    expect(() => validateMemoryStore({ facts: [fact, fact] })).toThrow();
  });
});

describe("UT-TRANSFER-05 actual shell settings", () => {
  it("removes account identifiers, credentials and device credential references recursively", () => {
    const settings = {
      provider: "naia",
      model: "example",
      accessToken: "token",
      clientSecret: "value",
      password: "value",
      naiaUserId: "account",
      labUserId: "legacy-account",
      apiKey: "key",
      naiaKey: "key",
      gatewayToken: "token",
      subLlmApiKey: "key",
      memoryLlmApiKey: "key",
      memoryEmbeddingApiKey: "key",
      qdrantApiKey: "key",
      googleApiKey: "key",
      openaiTtsApiKey: "key",
      elevenlabsApiKey: "key",
      openaiRealtimeApiKey: "key",
      subLlmCredentialRef: "device-ref",
      memoryLlmCredentialRef: "device-ref",
      nested: [{ credentialRef: "device-ref", theme: "dark" }],
    };
    const result = sanitizeSettings(settings);
    expect(result.removed).toBe(19);
    expect(result.value).toEqual({ provider: "naia", model: "example", nested: [{ theme: "dark" }] });
    expect(hasSensitiveFields(result.value)).toBe(false);
  });
});
