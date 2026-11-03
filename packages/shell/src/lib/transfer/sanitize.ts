const sensitive = new Set([
  "apikey", "naiakey", "gatewaytoken", "subllmapikey", "memoryllmapikey",
  "memoryembeddingapikey", "qdrantapikey", "googleapikey", "openaittsapikey",
  "elevenlabsapikey", "openairealtimeapikey", "oauthstate", "naiaremotekey",
  "naiaremoteuserid", "naiauserid", "labuserid", "labkey", "userid", "accountid", "cookie", "sessiontoken",
  "credentialref", "subllmcredentialref", "memoryllmcredentialref",
]);

// No current config.ts or adk-store.ts key matched by this rule is non-secret.
const nonSecretNameExceptions = new Set<string>();

export function isSensitive(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (nonSecretNameExceptions.has(normalized)) return false;
  return sensitive.has(normalized) || /token|secret|password|passwd|credential|cookie|session|apikey|privatekey|auth/.test(normalized) || normalized.endsWith("key");
}

export function sanitizeSettings(input: unknown): { value: unknown; removed: number } {
  let removed = 0;
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (isSensitive(key)) removed++;
      else Object.defineProperty(result, key, { value: visit(entry), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  return { value: visit(input), removed };
}

export function hasSensitiveFields(input: unknown): boolean {
  return sanitizeSettings(input).removed > 0;
}
