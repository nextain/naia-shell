#!/usr/bin/env node

/**
 * Compile the independent QA fragments into a reviewable, source-backed catalog.
 *
 * This is deliberately a structural compiler.  It does not execute the product
 * and it never upgrades a draft fragment to a verified QA round.  A catalog with
 * unresolved source, case, or coverage diagnostics remains initialization-ineligible.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const QA_CATALOG_VERSION = 2;
export const QA_CATALOG_SCHEMA = "naia-shell.qa-catalog.v2";
export const QA_ROUND_MANIFEST_VERSION = 1;
export const QA_ROUND_MANIFEST_SCHEMA = "naia-shell.qa-round.v1";
export const QA_SCOPE_REVIEW_SCHEMA = "naia-shell.qa-scope-review.v1";
export const DEVICE_ALIASES = Object.freeze({
  "linux-qa": "linux3090",
  "windows-qa": "windows4060",
});

const SCOPE_REVIEW_DISPOSITIONS = new Set([
  "direct-case",
  "grounded-indirect",
  "technical-verification-pending",
  "retired-replaced-future",
  "unresolved",
]);

const SOURCE_KIND_BY_LAYER = Object.freeze({
  "use-case": "UC",
  "scenario-catalog": "UC",
  "feature-design": "FE",
  "feature-requirement": "FE",
  "nonfunctional-requirement": "FE",
  requirement: "FE",
});

/**
 * Structured case links are deliberately field-specific.  A source ID that
 * happens to share a prefix with another layer must not become coverage just
 * because its title contains the same words.  The broad UC/FE fields retain
 * the historical fragment contract; the additional fields make the registry
 * layers explicit for requirements, scenarios, and tests.
 */
const LINK_SPECS = Object.freeze({
  // A user-facing scenario may be represented by either a real use-case or
  // a real scenario-catalog entry. The cross-field check in normalizeCase
  // enforces that at least one of those two links exists.
  ucIds: Object.freeze({ kind: "UC", allowedLayers: ["use-case"], required: false }),
  feIds: Object.freeze({ kind: "FE", allowedLayers: ["feature-design", "feature-requirement", "nonfunctional-requirement", "requirement"], required: true }),
  requirementIds: Object.freeze({ kind: "REQ", allowedLayers: ["requirement"], required: false }),
  scenarioIds: Object.freeze({ kind: "S", allowedLayers: ["scenario-catalog"], required: false }),
  testIds: Object.freeze({ kind: "TEST", allowedLayers: ["scenario-test", "feature-test"], required: false }),
});
const LINK_FIELDS = Object.freeze(Object.keys(LINK_SPECS));
const SOURCE_DECLARATION_KINDS = new Set(Object.values(LINK_SPECS).map((spec) => spec.kind));

function nowIso() {
  return new Date().toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function hashJson(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values)];
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()) : [];
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function relativeProjectFile(projectRoot, file) {
  const raw = text(file).replaceAll("\\", "/");
  const prefix = "projects/naia-shell/";
  const duplicatedPrefix = `${prefix}${prefix}`;
  if (raw.startsWith(duplicatedPrefix)) {
    return {
      raw,
      normalized: raw,
      error: "duplicated-project-prefix",
    };
  }

  let normalized = raw;
  if (normalized.startsWith(prefix)) normalized = normalized.slice(prefix.length);
  if (isAbsolute(normalized)) {
    const relativePath = relative(projectRoot, resolve(normalized)).replaceAll(sep, "/");
    if (relativePath === "" || (!relativePath.startsWith("..") && relativePath !== "..")) {
      normalized = relativePath;
    } else {
      return { raw, normalized, error: "path-outside-project" };
    }
  }
  normalized = normalized.replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized === "..") {
    return { raw, normalized, error: "path-outside-project" };
  }
  return { raw, normalized };
}

/** Parse a semicolon-separated path:line or path:line-line reference. */
export function parseSourceRefs(value, { projectRoot }) {
  const raw = text(value);
  const diagnostics = [];
  if (!raw) {
    diagnostics.push(issue("blank-source-ref", "sourceRef must not be blank"));
    return { refs: [], diagnostics, canonical: "" };
  }

  const refs = [];
  const seen = new Set();
  for (const tokenValue of raw.split(";")) {
    const token = tokenValue.trim();
    if (!token) {
      diagnostics.push(issue("blank-source-ref-token", "sourceRef contains an empty segment", { raw: value }));
      continue;
    }
    const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) {
      diagnostics.push(issue("invalid-source-ref", `Cannot parse source reference: ${token}`, { raw: token }));
      continue;
    }
    const [, rawPath, startText, endText] = match;
    const start = Number(startText);
    const end = endText ? Number(endText) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      diagnostics.push(issue("invalid-source-line", `Invalid source line range: ${token}`, { raw: token }));
      continue;
    }
    const pathInfo = relativeProjectFile(projectRoot, rawPath);
    const absolutePath = resolve(projectRoot, pathInfo.normalized || rawPath);
    const pathKey = `${pathInfo.normalized}:${start}-${end}`;
    if (seen.has(pathKey)) {
      diagnostics.push(issue("duplicate-source-ref-token", `Duplicate source reference: ${token}`, { raw: token }));
    }
    seen.add(pathKey);

    const ref = {
      raw: token,
      rawPath: pathInfo.raw,
      path: pathInfo.normalized,
      start,
      end,
      absolutePath,
      exists: false,
      lineCount: null,
      errors: [],
    };
    if (pathInfo.error) ref.errors.push(pathInfo.error);
    if (pathInfo.error === "duplicated-project-prefix") {
      diagnostics.push(issue("duplicated-project-prefix", `Project prefix is repeated in source reference: ${token}`, { raw: token, path: pathInfo.normalized }));
    }
    if (!pathInfo.error && existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      ref.exists = true;
      ref.lineCount = readFileSync(absolutePath, "utf8").split(/\r?\n/).length;
      if (end > ref.lineCount) {
        ref.errors.push("line-out-of-range");
        diagnostics.push(issue("source-line-out-of-range", `${token} ends after ${pathInfo.normalized} (${ref.lineCount} lines)`, { raw: token, lineCount: ref.lineCount }));
      }
    } else {
      ref.errors.push("missing-source-file");
      diagnostics.push(issue("missing-source-file", `Source file does not exist: ${pathInfo.normalized || pathInfo.raw}`, { raw: token, path: pathInfo.normalized }));
    }
    refs.push(ref);
  }
  const canonical = refs.length
    ? refs.map((ref) => `${ref.path}:${ref.start}${ref.end === ref.start ? "" : `-${ref.end}`}`).join("; ")
    : raw;
  return { refs, diagnostics, canonical };
}

function loadJson(filePath) {
  const source = readFileSync(filePath, "utf8");
  return { value: JSON.parse(source), sha256: createHash("sha256").update(source).digest("hex") };
}

function normalizeInventory(inventory, diagnostics) {
  const entities = Array.isArray(inventory?.entities) ? inventory.entities : [];
  const relations = Array.isArray(inventory?.relations) ? inventory.relations : [];
  if (!entities.length) {
    diagnostics.errors.push(issue("empty-inventory", "Inventory contains no entities"));
  }
  const byId = new Map();
  for (const entity of entities) {
    const id = text(entity?.id);
    if (!id) {
      diagnostics.errors.push(issue("invalid-inventory-entity", "Inventory entity has no id"));
      continue;
    }
    if (byId.has(id)) {
      diagnostics.errors.push(issue("duplicate-inventory-id", `Inventory repeats entity id ${id}`, { id }));
      byId.get(id).push(entity);
    } else {
      byId.set(id, [entity]);
    }
  }
  return { entities, byId, relations };
}

function entityKind(entity) {
  return SOURCE_KIND_BY_LAYER[entity?.layer] ?? null;
}

function entityLinkKind(entity) {
  const layer = entity?.layer;
  if (layer === "requirement") return "REQ";
  if (layer === "scenario-catalog") return "S";
  if (layer === "scenario-test" || layer === "feature-test") return "TEST";
  return entityKind(entity);
}

function hasValidUserScenarioLink(links, inventoryData) {
  return ["ucIds", "scenarioIds"].some((field) => {
    const spec = LINK_SPECS[field];
    return (links[field] ?? []).some((id) => {
      const entities = inventoryData.byId.get(id) ?? [];
      return entities.some((entity) => (
        entityLinkKind(entity) === spec.kind
        && spec.allowedLayers.includes(entity.layer)
      ));
    });
  });
}

function entityDefinitions(entityList) {
  return entityList.flatMap((entity) => Array.isArray(entity?.definitions) ? entity.definitions.map((definition) => ({ entity, definition })) : []);
}

function normalizedDefinitionFile(projectRoot, file) {
  return relativeProjectFile(projectRoot, file).normalized;
}

function definitionBody(definition) {
  return {
    title: text(definition?.title),
    evidence: text(definition?.evidence),
    layer: text(definition?.layer),
    sourceKind: text(definition?.sourceKind),
  };
}

function definitionVariantReport(inventoryById, projectRoot) {
  const reports = [];
  for (const [id, entities] of inventoryById) {
    const definitions = entityDefinitions(entities);
    const variants = new Map();
    for (const { definition } of definitions) {
      const body = definitionBody(definition);
      const hash = hashJson(body);
      if (!variants.has(hash)) variants.set(hash, { hash, body, locations: [] });
      variants.get(hash).locations.push({
        file: normalizedDefinitionFile(projectRoot, definition.file),
        line: definition.line,
      });
    }
    if (variants.size > 1) {
      reports.push({ id, variantCount: variants.size, variants: [...variants.values()] });
    }
  }
  return reports;
}

function sourceMatchesDefinition(source, entities, projectRoot) {
  const parsed = source.sourceRefDiagnostics ?? source.refDiagnostics?.refs ?? [];
  const definitions = entityDefinitions(entities);
  const matches = [];
  for (const { definition } of definitions) {
    const file = normalizedDefinitionFile(projectRoot, definition.file);
    const line = Number(definition.line);
    if (!file || !Number.isInteger(line)) continue;
    if (parsed.some((ref) => ref.path === file && line >= ref.start && line <= ref.end)) {
      matches.push({ file, line, body: definitionBody(definition) });
    }
  }
  return matches;
}

function normalizeDeviceIds(value, caseId, diagnostics) {
  const original = arrayOfStrings(value);
  if (!Array.isArray(value)) {
    diagnostics.errors.push(issue("missing-device-ids", `Case ${caseId} must declare a deviceIds array`, { caseId }));
  }
  const normalized = [];
  const aliases = [];
  for (const raw of original) {
    if (!raw) {
      diagnostics.errors.push(issue("blank-device-id", `Case ${caseId} contains a blank device id`, { caseId }));
      continue;
    }
    const mapped = DEVICE_ALIASES[raw] ?? raw;
    normalized.push(mapped);
    if (mapped !== raw) aliases.push({ from: raw, to: mapped });
  }
  if (new Set(normalized).size !== normalized.length) {
    diagnostics.errors.push(issue("duplicate-device-id", `Case ${caseId} has duplicate device rows after alias normalization`, { caseId, deviceIds: normalized }));
  }
  if (normalized.length === 0) {
    diagnostics.errors.push(issue("empty-device-ids", `Case ${caseId} must have at least one device id`, { caseId }));
  }
  return { normalized: unique(normalized), aliases };
}

function normalizeIdArray(item, field, caseId, diagnostics, { required = true } = {}) {
  if (!Array.isArray(item[field])) {
    if (required) diagnostics.errors.push(issue("missing-source-links", `Case ${caseId} must declare ${field} as an array`, { caseId, field }));
    return [];
  }
  const ids = arrayOfStrings(item[field]);
  if (ids.some((id) => !id)) diagnostics.errors.push(issue("blank-source-id", `Case ${caseId} has a blank ${field} entry`, { caseId, field }));
  if (new Set(ids).size !== ids.length) diagnostics.errors.push(issue("duplicate-source-id", `Case ${caseId} repeats an id in ${field}`, { caseId, field }));
  if (ids.length === 0 && required) diagnostics.errors.push(issue("empty-source-links", `Case ${caseId} has no ${field} links`, { caseId, field }));
  return unique(ids.filter(Boolean));
}

function canonicalCaseBody(item) {
  const keys = ["title", "method", "expectedResult", ...LINK_FIELDS, "sourceRef", "deviceIds", "execution"];
  return Object.fromEntries(keys.map((key) => [key, item[key]]));
}

function normalizeCase(item, fragmentPath, index, inventoryData, diagnostics, sourceRefsById) {
  const caseId = text(item?.id) || `${fragmentPath}#case-${index + 1}`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    diagnostics.errors.push(issue("invalid-case", `Case ${caseId} must be an object`, { caseId, fragmentPath }));
    return {
      id: caseId,
      title: "",
      method: "",
      expectedResult: "",
      ucIds: [],
      feIds: [],
      requirementIds: [],
      scenarioIds: [],
      testIds: [],
      sourceRef: "",
      deviceIds: [],
      execution: null,
      validation: { valid: false, errors: ["invalid-case"] },
      fragmentPath,
    };
  }

  const title = text(item.title);
  const method = text(item.method);
  const expectedResult = text(item.expectedResult);
  if (!title) diagnostics.errors.push(issue("blank-case-title", `Case ${caseId} has a blank title`, { caseId, fragmentPath }));
  if (!method) diagnostics.errors.push(issue("blank-case-method", `Case ${caseId} has a blank method/procedure`, { caseId, fragmentPath }));
  if (!expectedResult) diagnostics.errors.push(issue("blank-case-expected", `Case ${caseId} has a blank expected result`, { caseId, fragmentPath }));

  const links = Object.fromEntries(LINK_FIELDS.map((field) => [
    field,
    normalizeIdArray(item, field, caseId, diagnostics, { required: LINK_SPECS[field].required }),
  ]));
  const deviceInfo = normalizeDeviceIds(item.deviceIds, caseId, diagnostics);
  const sourceRef = text(item.sourceRef);
  const sourceRefDiagnostics = parseSourceRefs(sourceRef, { projectRoot: inventoryData.projectRoot });
  for (const diagnostic of sourceRefDiagnostics.diagnostics) {
    diagnostics.errors.push({ ...diagnostic, caseId, fragmentPath });
  }
  if (!sourceRef) diagnostics.errors.push(issue("blank-case-source-ref", `Case ${caseId} has no sourceRef`, { caseId, fragmentPath }));

  let execution = null;
  if (!item.execution || typeof item.execution !== "object" || Array.isArray(item.execution)) {
    diagnostics.errors.push(issue("missing-execution", `Case ${caseId} has no execution definition`, { caseId, fragmentPath }));
  } else {
    const executionKind = text(item.execution.kind);
    const executionRef = text(item.execution.ref);
    if (!executionKind || !executionRef) {
      diagnostics.errors.push(issue("invalid-execution", `Case ${caseId} has an incomplete execution definition`, { caseId, fragmentPath }));
    }
    execution = { ...item.execution, kind: executionKind, ref: executionRef };
  }

  for (const field of LINK_FIELDS) {
    const ids = links[field];
    const { kind: expectedKind, allowedLayers } = LINK_SPECS[field];
    for (const id of ids) {
      const entities = inventoryData.byId.get(id);
      if (!entities) {
        diagnostics.errors.push(issue("unknown-source-id", `Case ${caseId} references unknown ${expectedKind} source ${id}`, { caseId, id, field, fragmentPath }));
        continue;
      }
      const actualKinds = unique(entities.map(entityLinkKind).filter(Boolean));
      const actualLayers = unique(entities.map((entity) => entity.layer).filter(Boolean));
      if (!actualKinds.includes(expectedKind) || !actualLayers.some((layer) => allowedLayers.includes(layer))) {
        diagnostics.errors.push(issue("source-layer-mismatch", `Case ${caseId} places ${id} in ${field}, but inventory layer is ${actualLayers.join(",") || "unknown"}`, { caseId, id, field, expectedKind, allowedLayers, actualKinds, actualLayers, fragmentPath }));
      }
      const sourceInfo = sourceRefsById.get(id);
      if (sourceInfo && sourceInfo.kind !== expectedKind) {
        diagnostics.errors.push(issue("source-link-kind-conflict", `Case ${caseId} links ${id} through both ${sourceInfo.kind} and ${expectedKind} fields`, { caseId, id, field, expectedKind, previousKind: sourceInfo.kind, fragmentPath }));
      }
      sourceRefsById.set(id, sourceInfo ?? { kind: expectedKind, refs: [] });
      sourceRefsById.get(id).refs.push({ sourceRef, fragmentPath, caseId, field });
    }
  }

  if (!hasValidUserScenarioLink(links, inventoryData)) {
    diagnostics.errors.push(issue(
      "missing-user-scenario-links",
      `Case ${caseId} must link at least one real use-case or scenario-catalog source`,
      { caseId, fragmentPath, fields: ["ucIds", "scenarioIds"] },
    ));
  }

  const validationErrors = diagnostics.errors
    .filter((entry) => entry.caseId === caseId && entry.fragmentPath === fragmentPath)
    .map((entry) => entry.code);
  const normalized = {
    ...item,
    id: caseId,
    title,
    method,
    expectedResult,
    ...links,
    sourceRef,
    sourceRefCanonical: sourceRefDiagnostics.canonical,
    sourceRefDiagnostics: sourceRefDiagnostics.refs.map(({ absolutePath, ...ref }) => ref),
    deviceIds: deviceInfo.normalized,
    ...(deviceInfo.aliases.length ? { deviceAliases: deviceInfo.aliases } : {}),
    execution,
    fragmentPath,
    validation: { valid: validationErrors.length === 0, errors: validationErrors },
  };
  return normalized;
}

function sourceRefForDerived(id, sourceRefsById, projectRoot) {
  const refs = sourceRefsById.get(id)?.refs ?? [];
  for (const entry of refs) {
    const parsed = parseSourceRefs(entry.sourceRef, { projectRoot });
    if (parsed.refs.length && parsed.diagnostics.every((diag) => !["missing-source-file", "duplicated-project-prefix", "source-line-out-of-range"].includes(diag.code))) {
      return parsed.canonical;
    }
  }
  return text(refs[0]?.sourceRef) || "derived-from-case";
}

function normalizeSourceDeclarations(fragments, inventoryData, sourceRefsById, diagnostics) {
  const byId = new Map();
  for (const fragment of fragments) {
    const sources = Array.isArray(fragment.value.sources) ? fragment.value.sources : [];
    for (const source of sources) {
      const id = text(source?.id);
      const kind = text(source?.kind);
      const rawRef = text(source?.ref);
      const fragmentPath = fragment.path;
      if (!id || !kind || !rawRef) {
        diagnostics.errors.push(issue("invalid-source-declaration", `Source declaration in ${fragmentPath} requires id, kind, and ref`, { fragmentPath }));
        continue;
      }
      if (!SOURCE_DECLARATION_KINDS.has(kind)) {
        diagnostics.errors.push(issue("invalid-source-kind", `Source ${id} has unsupported kind ${kind}`, { id, fragmentPath }));
      }
      const entities = inventoryData.byId.get(id);
      if (!entities) {
        diagnostics.errors.push(issue("unknown-source-id", `Source declaration references unknown id ${id}`, { id, fragmentPath }));
      } else {
        const kinds = unique(entities.map(entityLinkKind).filter(Boolean));
        if (!kinds.includes(kind)) diagnostics.errors.push(issue("source-kind-mismatch", `Source ${id} declares ${kind}; inventory declares ${kinds.join(",") || "unknown"}`, { id, fragmentPath }));
      }
      const parsed = parseSourceRefs(rawRef, { projectRoot: inventoryData.projectRoot });
      for (const diagnostic of parsed.diagnostics) diagnostics.errors.push({ ...diagnostic, sourceId: id, fragmentPath });
      const normalized = {
        id,
        kind,
        ref: parsed.canonical,
        rawRef,
        provenance: "declared",
        sourceRefDiagnostics: parsed.refs.map(({ absolutePath, ...ref }) => ref),
        fragmentPath,
      };
      const existing = byId.get(id);
      if (existing) {
        const same = existing.kind === normalized.kind && existing.ref === normalized.ref;
        if (!same) diagnostics.errors.push(issue("source-conflict", `Source ${id} has conflicting declarations`, { id, declarations: [existing, normalized] }));
        else diagnostics.warnings.push(issue("duplicate-source-declaration", `Source ${id} is declared more than once with the same reference`, { id }));
        continue;
      }
      byId.set(id, normalized);
    }
  }

  for (const [id, refInfo] of sourceRefsById) {
    if (byId.has(id)) continue;
    const entities = inventoryData.byId.get(id);
    const kind = refInfo.kind;
    byId.set(id, {
      id,
      kind,
      ref: sourceRefForDerived(id, sourceRefsById, inventoryData.projectRoot),
      rawRef: sourceRefForDerived(id, sourceRefsById, inventoryData.projectRoot),
      provenance: "derived-from-structured-case-link",
      fragmentPath: refInfo.refs[0]?.fragmentPath ?? null,
    });
    if (!entities) continue;
    diagnostics.warnings.push(issue("derived-source-declaration", `Source ${id} was derived from structured case links because a fragment omitted sources[]`, { id }));
  }

  for (const source of byId.values()) {
    const entities = inventoryData.byId.get(source.id);
    if (!entities) continue;
    const variants = sourceMatchesDefinition(source, entities, inventoryData.projectRoot);
    source.definitionMatches = variants;
    if (source.provenance === "declared" && variants.length === 0) {
      diagnostics.warnings.push(issue("source-definition-line-unmatched", `Source ${source.id} reference exists but does not point at its inventory definition line; relation may be intentional`, { id: source.id, ref: source.ref }));
    }
    if (variants.length > 1 && new Set(variants.map((variant) => hashJson(variant.body))).size > 1) {
      diagnostics.errors.push(issue("ambiguous-source-definition", `Source ${source.id} reference spans differing inventory definitions`, { id: source.id, matches: variants }));
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeCases(fragments, inventoryData, diagnostics, sourceRefsById) {
  const byId = new Map();
  for (const fragment of fragments) {
    const cases = Array.isArray(fragment.value.cases) ? fragment.value.cases : [];
    if (!Array.isArray(fragment.value.cases)) {
      diagnostics.errors.push(issue("missing-cases", `Fragment ${fragment.path} has no cases array`, { fragmentPath: fragment.path }));
      continue;
    }
    cases.forEach((item, index) => {
      const normalized = normalizeCase(item, fragment.path, index, inventoryData, diagnostics, sourceRefsById);
      const existing = byId.get(normalized.id);
      if (!existing) {
        byId.set(normalized.id, normalized);
        return;
      }
      const existingBody = hashJson(canonicalCaseBody(existing));
      const newBody = hashJson(canonicalCaseBody(normalized));
      if (existingBody === newBody) {
        diagnostics.warnings.push(issue("exact-duplicate-case-deduped", `Case ${normalized.id} is repeated with the same body and was deduplicated`, { caseId: normalized.id, fragments: [existing.fragmentPath, fragment.path] }));
      } else {
        diagnostics.errors.push(issue("duplicate-case-conflict", `Case ${normalized.id} is repeated with different content`, { caseId: normalized.id, fragments: [existing.fragmentPath, fragment.path] }));
      }
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function buildCoverage(inventoryData, cases, exclusions, diagnostics) {
  const links = new Map();
  const addLink = (id, item, field) => {
    if (!inventoryData.byId.has(id)) return;
    const spec = LINK_SPECS[field];
    if (!spec) return;
    const entities = inventoryData.byId.get(id);
    const entityKinds = unique(entities.map(entityLinkKind).filter(Boolean));
    const entityLayers = unique(entities.map((entity) => entity.layer).filter(Boolean));
    const linkValid = entityKinds.includes(spec.kind) && entityLayers.some((layer) => spec.allowedLayers.includes(layer));
    if (!links.has(id)) links.set(id, []);
    links.get(id).push({
      caseId: item.id,
      field,
      expectedKind: spec.kind,
      allowedLayers: spec.allowedLayers,
      entityKinds,
      entityLayers,
      linkValid,
      fragmentPath: item.fragmentPath,
      deviceIds: item.deviceIds,
      caseValid: item.validation?.valid === true,
    });
  };
  for (const item of cases) {
    for (const field of LINK_FIELDS) {
      for (const id of item[field] ?? []) addLink(id, item, field);
    }
  }

  const exclusionById = new Map();
  for (const entry of exclusions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.errors.push(issue("invalid-exclusion", "Exclusions must be objects"));
      continue;
    }
    const sourceId = text(entry.sourceId ?? entry.id);
    const reason = text(entry.reason);
    if (!sourceId || !reason) {
      diagnostics.errors.push(issue("invalid-exclusion", "Every exclusion requires sourceId and a non-empty reason", { exclusion: entry }));
      continue;
    }
    if (!inventoryData.byId.has(sourceId)) {
      diagnostics.errors.push(issue("unknown-exclusion-id", `Exclusion references unknown inventory id ${sourceId}`, { sourceId }));
      continue;
    }
    if (exclusionById.has(sourceId)) diagnostics.errors.push(issue("duplicate-exclusion", `Inventory id ${sourceId} has more than one exclusion`, { sourceId }));
    exclusionById.set(sourceId, { sourceId, reason, source: entry.source ?? null });
  }

  const ledger = [];
  for (const entity of inventoryData.entities) {
    const id = text(entity.id);
    if (!id) continue;
    const entityLinks = links.get(id) ?? [];
    const exclusion = exclusionById.get(id) ?? null;
    if (entityLinks.length && exclusion) {
      diagnostics.errors.push(issue("coverage-exclusion-conflict", `${id} is both case-linked and explicitly excluded`, { id }));
    }
    const coverageStatus = entityLinks.length ? "COVERED" : exclusion ? "EXCLUDED" : "UNCONNECTED";
    ledger.push({
      id,
      layer: entity.layer ?? null,
      kind: entityLinkKind(entity),
      title: entity.title ?? null,
      coverageStatus,
      validationState: entityLinks.some((link) => !link.caseValid) ? "LINKED_INVALID_CASE" : "STRUCTURED_LINK",
      linkValidationState: entityLinks.some((link) => !link.linkValid) ? "LINKED_INVALID_LINK" : "STRUCTURED_LINK",
      caseIds: unique(entityLinks.map((link) => link.caseId)),
      deviceIds: unique(entityLinks.flatMap((link) => link.deviceIds ?? [])),
      links: entityLinks,
      exclusion,
      definitionCount: Array.isArray(entity.definitions) ? entity.definitions.length : 0,
    });
  }
  const summary = {
    total: ledger.length,
    covered: ledger.filter((entry) => entry.coverageStatus === "COVERED").length,
    excluded: ledger.filter((entry) => entry.coverageStatus === "EXCLUDED").length,
    unconnected: ledger.filter((entry) => entry.coverageStatus === "UNCONNECTED").length,
    linkedInvalidCase: ledger.filter((entry) => entry.validationState === "LINKED_INVALID_CASE").length,
    linkedInvalidLink: ledger.filter((entry) => entry.linkValidationState === "LINKED_INVALID_LINK").length,
  };
  const summarize = (entries) => ({
    total: entries.length,
    covered: entries.filter((entry) => entry.coverageStatus === "COVERED").length,
    excluded: entries.filter((entry) => entry.coverageStatus === "EXCLUDED").length,
    unconnected: entries.filter((entry) => entry.coverageStatus === "UNCONNECTED").length,
    linkedInvalidCase: entries.filter((entry) => entry.validationState === "LINKED_INVALID_CASE").length,
    linkedInvalidLink: entries.filter((entry) => entry.linkValidationState === "LINKED_INVALID_LINK").length,
  });
  const grouped = (key) => Object.fromEntries(
    [...new Set(ledger.map((entry) => entry[key] ?? "unknown"))]
      .sort()
      .map((value) => [value, summarize(ledger.filter((entry) => (entry[key] ?? "unknown") === value))]),
  );
  return { ledger, summary, byLayer: grouped("layer"), byKind: grouped("kind") };
}

function buildManifestSourceLinks(inventoryData, sources, coverage) {
  const caseIdsBySourceId = new Map(
    coverage.ledger.map((entry) => [entry.id, entry.caseIds]),
  );
  return sources.map((source) => {
    const entities = inventoryData.byId.get(source.id) ?? [];
    const layers = unique(entities.map((entity) => text(entity.layer)).filter(Boolean));
    const manifestKind = layers
      .map((layer) => SOURCE_KIND_BY_LAYER[layer])
      .find(Boolean) ?? source.kind;
    return {
      id: source.id,
      kind: manifestKind,
      layer: layers[0] ?? null,
      ref: source.ref,
      caseIds: caseIdsBySourceId.get(source.id) ?? [],
    };
  });
}

const REQUIREMENT_ORIENTED_LAYERS = new Set([
  "requirement",
  "feature-requirement",
  "nonfunctional-requirement",
]);

function inferredRegistry(definition, entity) {
  const explicit = text(definition?.registry);
  if (explicit) return explicit;
  const file = text(definition?.file).replaceAll("\\", "/");
  if (file.includes("docs/progress/01.requirements/")) return "requirements";
  if (file.includes("docs/progress/02.user-scenarios/")) return "use-cases";
  if (file.includes("docs/progress/03.uc-tests/")) return "scenario-tests";
  if (file.includes("docs/progress/04.features/")) return "feature-design";
  if (file.includes("docs/progress/05.features-tests/")) return "feature-tests";
  return text(entity?.layer) || "unregistered";
}

function sourceHeadingInfo(projectRoot, file, line, cache) {
  const normalized = normalizedDefinitionFile(projectRoot, file);
  const absolute = resolve(projectRoot, normalized);
  if (!cache.has(absolute)) {
    let lines = [];
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      lines = readFileSync(absolute, "utf8").split(/\r?\n/);
    }
    cache.set(absolute, lines);
  }
  const lines = cache.get(absolute);
  const targetLine = Number.isInteger(Number(line)) ? Number(line) : 1;
  const headings = [];
  for (let index = 0; index < Math.min(Math.max(targetLine, 1), lines.length); index += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (!match) continue;
    const level = match[1].length;
    const title = match[2].replace(/\s+#+\s*$/, "").trim();
    while (headings.length && headings.at(-1).level >= level) headings.pop();
    headings.push({ level, title });
  }
  return {
    heading: headings.at(-1)?.title ?? null,
    headingPath: headings.map((entry) => entry.title),
  };
}

function sourceLocationsForEntity(inventoryData, entity, headingCache) {
  const definitions = Array.isArray(entity?.definitions) ? entity.definitions : [];
  const locations = definitions.map((definition) => {
    const file = normalizedDefinitionFile(inventoryData.projectRoot, definition.file);
    const line = Number(definition.line);
    const headingInfo = sourceHeadingInfo(inventoryData.projectRoot, file, line, headingCache);
    return {
      file,
      line: Number.isInteger(line) ? line : null,
      title: text(definition.title) || text(entity.title) || null,
      sourceKind: text(definition.sourceKind) || null,
      registry: inferredRegistry(definition, entity),
      heading: headingInfo.heading,
      headingPath: headingInfo.headingPath,
    };
  });
  const seen = new Set();
  return locations.filter((location) => {
    const key = JSON.stringify(location);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRelationsForEntity(inventoryData, id) {
  return inventoryData.relations
    .filter((relation) => relation && (text(relation.from) === id || text(relation.to) === id))
    .map((relation) => ({
      direction: text(relation.from) === id && text(relation.to) === id
        ? "self"
        : text(relation.from) === id ? "outgoing" : "incoming",
      from: text(relation.from) || null,
      to: text(relation.to) || null,
      file: text(relation.file) || null,
      line: Number.isInteger(Number(relation.line)) ? Number(relation.line) : null,
      sourceKind: text(relation.sourceKind) || null,
      registry: text(relation.registry) || null,
      status: text(relation.status) || null,
      trace: relation.trace ?? null,
      evidence: text(relation.evidence) || null,
    }));
}

function buildGapReport(inventoryData, coverage, cases) {
  const headingCache = new Map();
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const groups = new Map();
  const entries = coverage.ledger
    .filter((entry) => entry.coverageStatus === "UNCONNECTED")
    .map((entry) => {
      const entities = inventoryData.byId.get(entry.id) ?? [];
      const sourceLocations = entities.flatMap((entity) => sourceLocationsForEntity(inventoryData, entity, headingCache));
      const locations = sourceLocations.length ? sourceLocations : [{
        file: null,
        line: null,
        title: entry.title,
        sourceKind: null,
        registry: entry.layer ?? "unregistered",
        heading: null,
        headingPath: [],
      }];
      const groupKeys = unique(locations.map((location) => {
        const heading = location.headingPath.join(" > ") || "(no heading)";
        const registry = location.registry || "unregistered";
        const file = location.file || "(no source file)";
        return `${file} :: ${heading} :: ${registry}`;
      }));
      const currentCases = (entry.caseIds ?? []).map((caseId) => {
        const item = caseById.get(caseId);
        return item ? {
          id: item.id,
          title: item.title,
          fragmentPath: item.fragmentPath,
          validation: item.validation,
        } : { id: caseId, title: null, fragmentPath: null, validation: null };
      });
      const gapEntry = {
        id: entry.id,
        kind: entry.kind,
        layer: entry.layer,
        title: entry.title,
        status: entry.coverageStatus,
        sourceLocations: locations,
        relatedSourceRelations: sourceRelationsForEntity(inventoryData, entry.id),
        currentCaseIds: entry.caseIds ?? [],
        currentCases,
        groupKeys,
      };
      const requirementOriented = REQUIREMENT_ORIENTED_LAYERS.has(entry.layer);
      for (const location of locations) {
        const heading = location.headingPath.join(" > ") || "(no heading)";
        const registry = location.registry || "unregistered";
        const file = location.file || "(no source file)";
        const key = `${file} :: ${heading} :: ${registry}`;
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            file,
            heading,
            headingPath: location.headingPath,
            registry,
            entityIds: new Set(),
            requirementEntityIds: new Set(),
            featureDesignEntityIds: new Set(),
            useCaseEntityIds: new Set(),
            scenarioEntityIds: new Set(),
            testEntityIds: new Set(),
          });
        }
        const group = groups.get(key);
        group.entityIds.add(entry.id);
        if (requirementOriented) group.requirementEntityIds.add(entry.id);
        if (entry.layer === "feature-design") group.featureDesignEntityIds.add(entry.id);
        if (entry.layer === "use-case") group.useCaseEntityIds.add(entry.id);
        if (entry.layer === "scenario-catalog") group.scenarioEntityIds.add(entry.id);
        if (entry.layer === "scenario-test" || entry.layer === "feature-test") group.testEntityIds.add(entry.id);
      }
      return gapEntry;
    });
  const normalizedGroups = [...groups.values()]
    .map((group) => ({
      key: group.key,
      file: group.file,
      heading: group.heading,
      headingPath: group.headingPath,
      registry: group.registry,
      entityCount: group.entityIds.size,
      requirementCount: group.requirementEntityIds.size,
      featureDesignCount: group.featureDesignEntityIds.size,
      useCaseCount: group.useCaseEntityIds.size,
      scenarioCount: group.scenarioEntityIds.size,
      testCount: group.testEntityIds.size,
      entityIds: [...group.entityIds].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => right.entityCount - left.entityCount || left.key.localeCompare(right.key));
  const entriesWithRelations = entries.filter((entry) => entry.relatedSourceRelations.length > 0).length;
  return {
    schema: "naia-shell.qa-catalog-gaps.v2",
    coverageMeaning: "UNCONNECTED means no structured case link was found for that inventory entity. The inventory contains layered requirement, use-case, scenario, design, and test records, so this is a direct-link review index, not a count of missing product QA cases. Related source relations are retained for indirect or technical review but are not promoted to direct coverage; generic tests, title mentions, expected-result text, and product execution are not promoted either.",
    summary: {
      total: entries.length,
      unconnected: entries.length,
      groups: normalizedGroups.length,
      entriesWithDefinitions: entries.filter((entry) => entry.sourceLocations.some((location) => location.file)).length,
      entriesWithRelations,
    },
    groups: normalizedGroups,
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function buildSpecCounts(cases, inventoryData) {
  const specs = inventoryData.entities
    .filter((entity) => entity.layer === "feature-design" && /^SPEC-/.test(entity.id))
    .map((entity) => entity.id)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const result = specs.map((specId) => {
    const linkedCases = cases.filter((item) => (item.feIds ?? []).includes(specId));
    const rows = new Set();
    for (const item of linkedCases) for (const deviceId of item.deviceIds ?? []) rows.add(`${item.id}\u0000${deviceId}`);
    const deviceRows = [...rows].map((value) => {
      const [caseId, deviceId] = value.split("\u0000");
      return { caseId, deviceId };
    }).sort((left, right) => `${left.caseId}:${left.deviceId}`.localeCompare(`${right.caseId}:${right.deviceId}`));
    return {
      specId,
      title: inventoryData.byId.get(specId)?.[0]?.title ?? null,
      caseCount: new Set(linkedCases.map((item) => item.id)).size,
      deviceRowCount: deviceRows.length,
      caseIds: unique(linkedCases.map((item) => item.id)),
      devices: unique(deviceRows.map((row) => row.deviceId)),
      deviceRows,
    };
  });
  return result;
}

function fragmentExclusions(fragments) {
  return fragments.flatMap((fragment) => {
    const exclusions = Array.isArray(fragment.value.exclusions) ? fragment.value.exclusions : [];
    return exclusions.map((entry) => ({ ...entry, fragmentPath: fragment.path }));
  });
}

function loadFragments(fragmentPaths) {
  return fragmentPaths.map((pathValue) => {
    const path = resolve(pathValue);
    const loaded = loadJson(path);
    return { path, value: loaded.value, sha256: loaded.sha256 };
  });
}

function loadScopeReviewInput(input) {
  if (!input) return null;
  if (typeof input === "string") {
    const path = resolve(input);
    const loaded = loadJson(path);
    return { path, value: loaded.value, sha256: loaded.sha256 };
  }
  if (input && typeof input === "object" && input.value && typeof input.value === "object") {
    return {
      path: text(input.path) || "<inline-scope-review>",
      value: input.value,
      sha256: text(input.sha256) || hashJson(input.value),
    };
  }
  return { path: "<inline-scope-review>", value: input, sha256: hashJson(input) };
}

function reviewEvidence(value) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return arrayOfStrings(value).filter(Boolean);
}

function reviewTargets(value) {
  return unique(arrayOfStrings(value).filter(Boolean));
}

/**
 * Validate the human scope disposition separately from structural catalog
 * compilation.  Every active inventory entity gets one explicit disposition;
 * batched dispositions are rejected so a generic exclusion cannot hide a
 * large unresolved range.
 */
function validateScopeReview(reviewLoaded, { inventoryData, inventorySha256, cases, compiledCasesSha256 }) {
  if (!reviewLoaded) {
    return {
      present: false,
      path: null,
      sha256: null,
      schema: QA_SCOPE_REVIEW_SCHEMA,
      reviewer: null,
      reviewedAtUtc: null,
      inventorySha256: null,
      compiledCasesSha256: null,
      dispositions: [],
      sourceCount: unique(inventoryData.entities.map((entity) => text(entity.id)).filter(Boolean)).length,
      unresolvedSourceIds: [],
      unresolvedCount: 0,
      valid: false,
      scopeReviewReady: false,
      errors: [issue("scope-review-missing", "An explicit scope review file is required before v1 export or initialization")],
      warnings: [],
      diagnostics: { errors: 1, warnings: 0 },
      document: null,
    };
  }

  const document = reviewLoaded.value;
  const errors = [];
  const warnings = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    errors.push(issue("scope-review-invalid-document", "Scope review must be a JSON object"));
  }
  const schema = text(document?.schema);
  if (schema !== QA_SCOPE_REVIEW_SCHEMA) {
    errors.push(issue("scope-review-schema", `Scope review schema must be ${QA_SCOPE_REVIEW_SCHEMA}`, { schema }));
  }
  const reviewer = text(document?.reviewer);
  if (!reviewer) errors.push(issue("scope-review-reviewer", "Scope review requires a reviewer"));
  const reviewedAtUtc = text(document?.reviewedAtUtc);
  if (!reviewedAtUtc || !/Z$/.test(reviewedAtUtc) || Number.isNaN(Date.parse(reviewedAtUtc))) {
    errors.push(issue("scope-review-utc", "Scope review requires a valid UTC reviewedAtUtc timestamp"));
  }

  const declaredInventorySha256 = text(document?.inventorySha256 ?? document?.sourceInventorySha256);
  const declaredCasesSha256 = text(document?.compiledCasesSha256 ?? document?.casesSha256);
  if (!declaredInventorySha256) errors.push(issue("scope-review-inventory-hash", "Scope review requires inventorySha256"));
  if (!declaredCasesSha256) errors.push(issue("scope-review-cases-hash", "Scope review requires compiledCasesSha256"));
  if (declaredInventorySha256 && declaredInventorySha256 !== inventorySha256) {
    errors.push(issue("scope-review-inventory-hash-mismatch", "Scope review inventorySha256 does not match the compiled inventory", {
      expected: inventorySha256,
      actual: declaredInventorySha256,
    }));
  }
  if (declaredCasesSha256 && declaredCasesSha256 !== compiledCasesSha256) {
    errors.push(issue("scope-review-cases-hash-mismatch", "Scope review compiledCasesSha256 does not match the compiled cases", {
      expected: compiledCasesSha256,
      actual: declaredCasesSha256,
    }));
  }

  const activeIds = unique(inventoryData.entities.map((entity) => text(entity.id)).filter(Boolean));
  const activeIdSet = new Set(activeIds);
  const caseIds = new Set(cases.map((item) => item.id));
  const rawDispositions = Array.isArray(document?.dispositions) ? document.dispositions : [];
  if (!Array.isArray(document?.dispositions)) {
    errors.push(issue("scope-review-dispositions", "Scope review requires a dispositions array"));
  }
  const seen = new Set();
  const dispositions = [];
  for (const [index, raw] of rawDispositions.entries()) {
    const sourceIds = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw.sourceId ? [text(raw.sourceId)] : arrayOfStrings(raw.sourceIds)
      : [];
    if (sourceIds.length !== 1 || !sourceIds[0]) {
      errors.push(issue("scope-review-batched-disposition", `Disposition ${index + 1} must name exactly one sourceId`, { index }));
      continue;
    }
    const sourceId = sourceIds[0];
    if (!activeIdSet.has(sourceId)) {
      errors.push(issue("scope-review-unknown-source", `Scope review references unknown active source ${sourceId}`, { sourceId, index }));
    }
    if (seen.has(sourceId)) {
      errors.push(issue("scope-review-duplicate-source", `Scope review repeats source ${sourceId}`, { sourceId, index }));
    }
    seen.add(sourceId);
    const disposition = text(raw.disposition);
    if (!SCOPE_REVIEW_DISPOSITIONS.has(disposition)) {
      errors.push(issue("scope-review-disposition", `Unsupported disposition ${disposition || "(blank)"}`, { sourceId, index, allowed: [...SCOPE_REVIEW_DISPOSITIONS] }));
    }
    const evidence = reviewEvidence(raw.evidence);
    if (!evidence.length) errors.push(issue("scope-review-evidence", `Disposition for ${sourceId} requires evidence`, { sourceId, index }));
    const targetIds = reviewTargets(raw.targetIds ?? raw.caseIds ?? raw.replacementIds);
    if (!targetIds.length) errors.push(issue("scope-review-targets", `Disposition for ${sourceId} requires targetIds`, { sourceId, index }));
    if (disposition === "direct-case" && targetIds.some((targetId) => !caseIds.has(targetId))) {
      errors.push(issue("scope-review-unknown-case-target", `Direct disposition for ${sourceId} references an unknown case`, { sourceId, targetIds, index }));
    }
    dispositions.push({
      sourceId,
      disposition,
      targetIds,
      evidence,
      note: text(raw.note) || null,
    });
  }
  const missingSourceIds = activeIds.filter((id) => !seen.has(id));
  for (const sourceId of missingSourceIds) {
    errors.push(issue("scope-review-missing-source", `Scope review has no disposition for active source ${sourceId}`, { sourceId }));
  }
  const unresolvedSourceIds = dispositions
    .filter((entry) => entry.disposition === "unresolved")
    .map((entry) => entry.sourceId);
  if (unresolvedSourceIds.length) {
    warnings.push(issue("scope-review-unresolved", `${unresolvedSourceIds.length} source disposition(s) remain unresolved`, { sourceIds: unresolvedSourceIds }));
  }

  const valid = errors.length === 0;
  return {
    present: true,
    path: reviewLoaded.path,
    sha256: reviewLoaded.sha256,
    schema: schema || QA_SCOPE_REVIEW_SCHEMA,
    reviewer: reviewer || null,
    reviewedAtUtc: reviewedAtUtc || null,
    inventorySha256: declaredInventorySha256 || null,
    compiledCasesSha256: declaredCasesSha256 || null,
    dispositions,
    sourceCount: activeIds.length,
    missingSourceIds,
    unresolvedSourceIds,
    unresolvedCount: unresolvedSourceIds.length,
    valid,
    scopeReviewReady: valid && unresolvedSourceIds.length === 0,
    errors,
    warnings,
    diagnostics: { errors: errors.length, warnings: warnings.length },
    document,
  };
}

function scopeReviewSummary(scopeReview) {
  const dispositions = Array.isArray(scopeReview.dispositions) ? scopeReview.dispositions : [];
  return {
    present: scopeReview.present,
    valid: scopeReview.valid,
    path: scopeReview.path,
    sha256: scopeReview.sha256,
    schema: scopeReview.schema,
    reviewer: scopeReview.reviewer,
    reviewedAtUtc: scopeReview.reviewedAtUtc,
    inventorySha256: scopeReview.inventorySha256,
    compiledCasesSha256: scopeReview.compiledCasesSha256,
    sourceCount: scopeReview.sourceCount,
    dispositionCount: scopeReview.dispositionCount ?? dispositions.length,
    dispositionCounts: scopeReview.dispositionCounts ?? Object.fromEntries(
      [...new Set(dispositions.map((entry) => entry.disposition))]
        .sort()
        .map((disposition) => [disposition, dispositions.filter((entry) => entry.disposition === disposition).length]),
    ),
    missingSourceIds: scopeReview.missingSourceIds ?? [],
    unresolvedSourceIds: scopeReview.unresolvedSourceIds,
    unresolvedCount: scopeReview.unresolvedCount,
    scopeReviewReady: scopeReview.scopeReviewReady,
    errors: scopeReview.errors,
    warnings: scopeReview.warnings,
  };
}

/**
 * Validate the exportable v1 round manifest.  This is intentionally a pure
 * gate: it checks the structural and scope-review receipts and never executes
 * the product or treats an execution result as implied by the manifest.
 */
export function validateManifest(manifest, {
  inventorySha256 = null,
  compiledCasesSha256 = null,
} = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: [issue("manifest-invalid-document", "Manifest must be a JSON object")], warnings: [] };
  }
  if (manifest.schema !== QA_ROUND_MANIFEST_SCHEMA || manifest.schemaVersion !== QA_ROUND_MANIFEST_VERSION) {
    errors.push(issue("manifest-schema", `Manifest schema must be ${QA_ROUND_MANIFEST_SCHEMA} version ${QA_ROUND_MANIFEST_VERSION}`));
  }
  if (manifest.executionStatus !== "not-performed") {
    errors.push(issue("manifest-execution-status", "A structural QA round manifest cannot claim product execution"));
  }
  if (inventorySha256 && manifest.inventorySha256 !== inventorySha256) {
    errors.push(issue("manifest-inventory-hash-mismatch", "Manifest inventorySha256 does not match the compiled inventory", { expected: inventorySha256, actual: manifest.inventorySha256 }));
  }
  if (compiledCasesSha256 && manifest.compiledCasesSha256 !== compiledCasesSha256) {
    errors.push(issue("manifest-cases-hash-mismatch", "Manifest compiledCasesSha256 does not match the compiled cases", { expected: compiledCasesSha256, actual: manifest.compiledCasesSha256 }));
  }
  const review = manifest.scopeReview;
  if (manifest.initializationAllowed || manifest.scopeReviewReady) {
    if (!review || review.present !== true) errors.push(issue("manifest-review-missing", "An explicit valid scope review is required before v1 export or initialization"));
    if (review && review.valid !== true) errors.push(issue("manifest-review-invalid", "The scope review receipt is invalid"));
    if (review && review.unresolvedCount > 0) errors.push(issue("manifest-review-unresolved", "Unresolved scope dispositions block v1 export or initialization", { unresolvedCount: review.unresolvedCount }));
    if (review && manifest.inventorySha256 && review.inventorySha256 !== manifest.inventorySha256) {
      errors.push(issue("manifest-review-inventory-hash-mismatch", "Manifest scope review inventorySha256 does not match the manifest inventorySha256", {
        expected: manifest.inventorySha256,
        actual: review.inventorySha256,
      }));
    }
    if (review && manifest.compiledCasesSha256 && review.compiledCasesSha256 !== manifest.compiledCasesSha256) {
      errors.push(issue("manifest-review-cases-hash-mismatch", "Manifest scope review compiledCasesSha256 does not match the manifest compiledCasesSha256", {
        expected: manifest.compiledCasesSha256,
        actual: review.compiledCasesSha256,
      }));
    }
  }
  if (manifest.initializationAllowed && manifest.structuralReady !== true) {
    errors.push(issue("manifest-structural-not-ready", "Initialization requires structuralReady=true"));
  }
  if (manifest.initializationAllowed && manifest.scopeReviewReady !== true) {
    errors.push(issue("manifest-scope-not-ready", "Initialization requires scopeReviewReady=true"));
  }
  if (manifest.scopeReviewReady && manifest.initializationAllowed !== true) {
    errors.push(issue("manifest-init-gate", "scopeReviewReady requires initializationAllowed=true in an exportable v1 manifest"));
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function exportV1Manifest(catalog) {
  if (!catalog?.structuralReady) throw new Error("Cannot export v1 manifest: structural catalog is not ready");
  if (!catalog.scopeReview?.present) throw new Error("Cannot export v1 manifest: explicit scope review is missing");
  if (!catalog.scopeReview.valid) throw new Error("Cannot export v1 manifest: scope review is invalid");
  if (!catalog.scopeReview.scopeReviewReady || catalog.scopeReview.unresolvedCount > 0) {
    throw new Error("Cannot export v1 manifest: scope review has unresolved dispositions");
  }
  const manifest = {
    schemaVersion: QA_ROUND_MANIFEST_VERSION,
    schema: QA_ROUND_MANIFEST_SCHEMA,
    generatedAtUtc: catalog.generatedAtUtc,
    catalogSchema: catalog.schema,
    catalogStatus: catalog.catalogStatus,
    structuralReady: catalog.structuralReady,
    scopeReviewReady: catalog.scopeReviewReady,
    initializationAllowed: catalog.initializationAllowed,
    executionStatus: "not-performed",
    inventorySha256: catalog.inventorySha256,
    compiledCasesSha256: catalog.compiledCasesSha256,
    caseCount: catalog.cases.length,
    sourceCount: catalog.inventory.entityCount,
    sourceLinks: catalog.sourceLinks,
    scopeReview: scopeReviewSummary(catalog.scopeReview),
    verification: {
      status: "reviewed",
      method: "qa-catalog-structural-and-scope-review",
      reviewed: true,
      note: "Scope review was completed; product execution remains not-performed.",
    },
  };
  const validation = validateManifest(manifest, {
    inventorySha256: catalog.inventorySha256,
    compiledCasesSha256: catalog.compiledCasesSha256,
  });
  if (!validation.valid) {
    throw new Error(`Cannot export v1 manifest: ${validation.errors.map((entry) => entry.code).join(", ")}`);
  }
  return manifest;
}

export function compileCatalog({ inventory, projectRoot, fragments, scopeReview, review, generatedAtUtc = nowIso() }) {
  const resolvedProjectRoot = resolve(projectRoot);
  const inventoryLoaded = typeof inventory === "string" ? loadJson(resolve(inventory)) : { value: inventory, sha256: hashJson(inventory) };
  const fragmentInputs = (fragments ?? []).map((fragment) => typeof fragment === "string" ? fragment : fragment);
  const loadedFragments = fragmentInputs.map((fragment) => {
    if (typeof fragment === "string") {
      const path = resolve(fragment);
      const loaded = loadJson(path);
      return { path, value: loaded.value, sha256: loaded.sha256 };
    }
    return { path: text(fragment.path) || "<inline-fragment>", value: fragment.value ?? fragment, sha256: hashJson(fragment.value ?? fragment) };
  });
  const diagnostics = { errors: [], warnings: [] };
  const inventoryData = normalizeInventory(inventoryLoaded.value, diagnostics);
  inventoryData.projectRoot = resolvedProjectRoot;

  const definitionVariants = definitionVariantReport(inventoryData.byId, resolvedProjectRoot);
  for (const variant of definitionVariants) {
    diagnostics.warnings.push(issue("same-id-different-definitions", `${variant.id} has ${variant.variantCount} inventory definition bodies; source line disambiguation is retained`, { id: variant.id, variantCount: variant.variantCount }));
  }

  const sourceRefsById = new Map();
  const cases = mergeCases(loadedFragments, inventoryData, diagnostics, sourceRefsById);
  const sources = normalizeSourceDeclarations(loadedFragments, inventoryData, sourceRefsById, diagnostics);
  const exclusions = fragmentExclusions(loadedFragments);
  const coverage = buildCoverage(inventoryData, cases, exclusions, diagnostics);
  const sourceLinks = buildManifestSourceLinks(inventoryData, sources, coverage);
  const gapReport = buildGapReport(inventoryData, coverage, cases);
  const specCaseCounts = buildSpecCounts(cases, inventoryData);
  const compiledCasesSha256 = hashJson(cases);
  const scopeReviewLoaded = loadScopeReviewInput(scopeReview ?? review);
  const scopeReviewResult = validateScopeReview(scopeReviewLoaded, {
    inventoryData,
    inventorySha256: inventoryLoaded.sha256,
    cases,
    compiledCasesSha256,
  });

  const explicitSourceIds = new Set(sources.filter((source) => source.provenance === "declared").map((source) => source.id));
  for (const source of sources) {
    const sourceLinks = coverage.ledger.find((entry) => entry.id === source.id)?.caseIds ?? [];
    if (!sourceLinks.length && explicitSourceIds.has(source.id)) {
      diagnostics.warnings.push(issue("declared-source-unlinked", `Declared source ${source.id} is not linked by any normalized case`, { id: source.id }));
    }
  }

  const errors = diagnostics.errors;
  const warnings = diagnostics.warnings;
  const structuralComplete = errors.length === 0
    && coverage.summary.linkedInvalidCase === 0
    && coverage.summary.linkedInvalidLink === 0;
  const structuralReady = structuralComplete;
  const scopeReviewReady = structuralReady && scopeReviewResult.scopeReviewReady;
  const catalogStatus = !structuralReady
    ? "INCOMPLETE"
    : !scopeReviewReady ? "COMPLETE_PENDING_REVIEW" : "COMPLETE_REVIEWED";
  // Initialization is available only after an explicit hash-bound scope
  // review. Product execution is intentionally never implied by this
  // structural compiler or by the v1 manifest.
  const initializationAllowed = scopeReviewReady;
  const executionStatus = "not-performed";
  const inputSummary = [
    { path: typeof inventory === "string" ? resolve(inventory) : "<inline-inventory>", sha256: inventoryLoaded.sha256, kind: "inventory", entityCount: inventoryData.entities.length },
    ...loadedFragments.map((fragment) => ({ path: fragment.path, sha256: fragment.sha256, kind: "fragment", caseCount: Array.isArray(fragment.value.cases) ? fragment.value.cases.length : 0 })),
  ];

  return {
    schemaVersion: QA_CATALOG_VERSION,
    schema: QA_CATALOG_SCHEMA,
    generatedAtUtc,
    verification: {
      status: "unverified",
      method: "qa-catalog-structural-compiler",
      evidenceRef: "qa-catalog-coverage.json",
      reviewed: false,
      note: "Source and case validation is structural; product execution is intentionally absent.",
    },
    catalogStatus,
    structuralReady,
    scopeReviewReady,
    inventorySha256: inventoryLoaded.sha256,
    compiledCasesSha256,
    scopeReview: scopeReviewSummary(scopeReviewResult),
    initializationAllowed,
    executionStatus,
    completeness: {
      status: catalogStatus,
      structuralReady,
      scopeReviewReady,
      initializationAllowed,
      structuralComplete,
      executionStatus,
      reasons: [
        ...(errors.length ? ["structural-validation-errors"] : []),
        ...(coverage.summary.linkedInvalidCase > 0 ? ["case-links-have-invalid-cases"] : []),
        ...(coverage.summary.linkedInvalidLink > 0 ? ["case-links-have-invalid-source-layers"] : []),
        ...(scopeReviewResult.errors.length ? ["scope-review-invalid"] : []),
        ...(scopeReviewResult.unresolvedCount > 0 ? ["scope-review-has-unresolved"] : []),
        ...(!scopeReviewResult.present ? ["scope-review-missing"] : []),
        ...(!scopeReviewReady ? ["scope-review-pending"] : []),
      ],
    },
    inputs: inputSummary,
    inventory: {
      generatedAtUtc: inventoryLoaded.value?.generatedAtUtc ?? null,
      sourceInventoryTotals: inventoryLoaded.value?.totals ?? null,
      entityCount: inventoryData.entities.length,
      definitionCount: Array.isArray(inventoryLoaded.value?.definitions) ? inventoryLoaded.value.definitions.length : null,
      relationCount: Array.isArray(inventoryLoaded.value?.relations) ? inventoryLoaded.value.relations.length : null,
    },
    sources,
    sourceLinks,
    cases,
    coverage,
    gapReport,
    specCaseCounts,
    diagnostics: {
      errors,
      warnings,
      counts: { errors: errors.length, warnings: warnings.length },
      definitionVariants,
      scopeReview: scopeReviewResult.diagnostics,
    },
    notes: [
      "Coverage is counted only from structured case link arrays (ucIds, feIds, requirementIds, scenarioIds, and testIds); title, method, expectedResult, and sourceRef text mentions do not create coverage.",
      "A COVERED entity has a structured definition-to-case link only; covered does not mean every expected detail is represented, the procedure is complete, or product execution passed.",
    "UNCONNECTED entries are a direct-link review index over a layered inventory; they are not a count of missing product QA cases. Related source relations remain available for an explicit indirect, technical, exclusion, or unresolved disposition, and generic tests or prose mentions are not promoted automatically.",
      "linux-qa and windows-qa are normalized to linux3090 and windows4060 only through the explicit DEVICE_ALIASES map.",
      "Structural readiness checks required fields, real UC/FE references, valid devices, and case/link integrity; layered UNCONNECTED coverage remains a separate scope-review index.",
      "Scope review, v1 manifest export, initialization, and product execution are separate gates: an explicit hash-bound review with no unresolved dispositions is required before export or initialization, while executionStatus remains not-performed.",
    ],
  };
}

function markdownTableRows(entries, columns) {
  return entries.map((entry) => `| ${columns.map((column) => String(entry[column] ?? "").replaceAll("|", "\\|")).join(" | ")} |`).join("\n");
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", "")
    .replaceAll("\n", "<br>");
}

function gapSourceText(entry) {
  return entry.sourceLocations.map((location) => {
    const position = location.file ? `${location.file}:${location.line ?? "?"}` : "(no source)";
    const heading = location.headingPath.length ? ` [${location.headingPath.join(" > ")}]` : "";
    const registry = location.registry ? ` {${location.registry}}` : "";
    return `${position}${heading}${registry}`;
  }).join("<br>");
}

function gapRelationText(entry) {
  return entry.relatedSourceRelations.map((relation) => {
    const position = relation.file ? `${relation.file}:${relation.line ?? "?"}` : "(no source)";
    return `${relation.from ?? "?"} → ${relation.to ?? "?"} @ ${position}${relation.status ? ` (${relation.status})` : ""}`;
  }).join("<br>") || "none";
}

export function renderGapReportMarkdown(gapReport) {
  const report = gapReport ?? { summary: { total: 0, groups: 0, entriesWithDefinitions: 0, entriesWithRelations: 0 }, groups: [], entries: [] };
  const summary = report.summary ?? {};
  const lines = [
    "# Naia QA source gap report",
    "",
    `- Unconnected entities: ${summary.total ?? 0}`,
    `- Source groups: ${summary.groups ?? 0}`,
    `- Entries with source definitions: ${summary.entriesWithDefinitions ?? 0}`,
    `- Entries with source relations: ${summary.entriesWithRelations ?? 0}`,
    "- Status: human review required; this is a direct-link review index across layered source records, not a count of missing product QA cases. It does not promote generic tests or prose mentions to coverage.",
    "",
    "Coverage here means only that a structured source-to-case link exists. Related source relations are retained for explicit indirect or technical review but are not promoted automatically. This does not claim that every expected detail is represented, that a procedure is complete, or that product execution passed.",
    "",
    "## Gap groups",
    "",
    "| Source file | Heading | Registry | Entities | Requirement-oriented entities | Feature designs | Use cases | Scenarios | Tests |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    (report.groups ?? []).map((group) => `| ${markdownCell(group.file)} | ${markdownCell(group.heading)} | ${markdownCell(group.registry)} | ${group.entityCount} | ${group.requirementCount} | ${group.featureDesignCount} | ${group.useCaseCount} | ${group.scenarioCount} | ${group.testCount} |`).join("\n") || "| (none) | | | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "## Gap entries",
    "",
    "| Group(s) | ID | Kind | Layer | Title | Original source | Related source relations | Current cases |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    (report.entries ?? []).map((entry) => `| ${markdownCell((entry.groupKeys ?? []).join("<br>"))} | ${markdownCell(entry.id)} | ${markdownCell(entry.kind)} | ${markdownCell(entry.layer)} | ${markdownCell(entry.title)} | ${markdownCell(gapSourceText(entry))} | ${markdownCell(gapRelationText(entry))} | ${markdownCell((entry.currentCaseIds ?? []).length ? entry.currentCaseIds.join(", ") : "none")} |`).join("\n") || "| | (none) | | | | | | none |",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function renderCatalogMarkdown(catalog) {
  const { coverage, diagnostics } = catalog;
  const specRows = catalog.specCaseCounts;
  const gapReport = catalog.gapReport ?? { summary: { total: 0, groups: 0 }, groups: [], entries: [] };
  const statusRows = [
    { status: "COVERED", count: coverage.summary.covered },
    { status: "EXCLUDED", count: coverage.summary.excluded },
    { status: "UNCONNECTED", count: coverage.summary.unconnected },
  ];
  const unconnected = coverage.ledger.filter((entry) => entry.coverageStatus === "UNCONNECTED");
  const excluded = coverage.ledger.filter((entry) => entry.coverageStatus === "EXCLUDED");
  const lines = [
    "# Naia QA catalog",
    "",
    `- Generated: ${catalog.generatedAtUtc}`,
    `- Schema: \`${catalog.schema}\``,
    `- Verification: **${catalog.verification.status}**`,
    `- Execution status: **${catalog.executionStatus}**`,
    `- Catalog status: **${catalog.catalogStatus}**`,
    `- Structural ready: **${catalog.structuralReady ? "yes" : "no"}**`,
    `- Scope review ready: **${catalog.scopeReviewReady ? "yes" : "no"}**`,
    `- Initialization allowed: **${catalog.initializationAllowed ? "yes" : "no"}**`,
    "",
    "## Inputs and counts",
    "",
    `- Inventory entities: ${catalog.inventory.entityCount}`,
    `- Merged cases: ${catalog.cases.length}`,
    `- Merged sources: ${catalog.sources.length}`,
    `- Diagnostics: ${diagnostics.errors.length} errors, ${diagnostics.warnings.length} warnings`,
    "",
    "## Coverage status",
    "",
    "| Status | Entities |",
    "| --- | ---: |",
    markdownTableRows(statusRows, ["status", "count"]),
    "",
    "Coverage is derived only from structured link arrays (`ucIds`, `feIds`, `requirementIds`, `scenarioIds`, and `testIds`); prose mentions are not coverage.",
    "",
    "### Coverage by inventory layer",
    "",
    "| Layer | Total | Covered | Excluded | Unconnected | Invalid case | Invalid link |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    Object.entries(coverage.byLayer).map(([layer, row]) => `| ${layer} | ${row.total} | ${row.covered} | ${row.excluded} | ${row.unconnected} | ${row.linkedInvalidCase} | ${row.linkedInvalidLink} |`).join("\n"),
    "",
    "### Coverage by source kind",
    "",
    "| Kind | Total | Covered | Excluded | Unconnected | Invalid case | Invalid link |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    Object.entries(coverage.byKind).map(([kind, row]) => `| ${kind} | ${row.total} | ${row.covered} | ${row.excluded} | ${row.unconnected} | ${row.linkedInvalidCase} | ${row.linkedInvalidLink} |`).join("\n"),
    "",
    "## Source gap report",
    "",
    `The report contains ${gapReport.summary.total} unconnected inventory entities in ${gapReport.summary.groups} source groups. This is a direct-link review index across layered requirement, use-case, scenario, design, and test records, not a count of missing product QA cases. An entity is listed here when no structured case link was found; related source relations remain for explicit indirect or technical review. Generic tests, title mentions, expected-result text, and execution results are not promoted to coverage automatically; **covered** means only that a structured source-to-case definition link exists. See the dedicated gap report for the full review table.`,
    "",
    "### Largest gap groups",
    "",
    "| Source file | Heading | Registry | Entities | Requirement-oriented entities | Feature designs | Use cases | Scenarios | Tests |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    gapReport.groups.slice(0, 25).map((group) => `| ${markdownCell(group.file)} | ${markdownCell(group.heading)} | ${markdownCell(group.registry)} | ${group.entityCount} | ${group.requirementCount} | ${group.featureDesignCount} | ${group.useCaseCount} | ${group.scenarioCount} | ${group.testCount} |`).join("\n") || "| (none) | | | 0 | 0 | 0 | 0 | 0 | 0 |",
    "",
    "## SPEC counts (distinct device rows)",
    "",
    "| SPEC | Case count | Device-row count | Devices |",
    "| --- | ---: | ---: | --- |",
    specRows.map((row) => `| ${row.specId} | ${row.caseCount} | ${row.deviceRowCount} | ${row.devices.join(", ")} |`).join("\n"),
    "",
    "## Unconnected inventory entities (index)",
    "",
    unconnected.length ? unconnected.map((entry) => `- \`${entry.id}\` (${entry.layer}) — ${entry.title ?? ""}`).join("\n") : "None.",
    "",
    "## Explicitly excluded inventory entities",
    "",
    excluded.length ? excluded.map((entry) => `- \`${entry.id}\` — ${entry.exclusion?.reason ?? ""}`).join("\n") : "None.",
    "",
    "## Errors",
    "",
    diagnostics.errors.length ? diagnostics.errors.map((entry) => `- **${entry.code}**: ${entry.message}`).join("\n") : "None.",
    "",
    "## Warnings",
    "",
    diagnostics.warnings.length ? diagnostics.warnings.map((entry) => `- **${entry.code}**: ${entry.message}`).join("\n") : "None.",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function writeCatalogOutputs(catalog, outputDir) {
  const target = resolve(outputDir);
  mkdirSync(target, { recursive: true });
  const manifestPath = `${target}/qa-catalog.json`;
  const coveragePath = `${target}/qa-catalog-coverage.json`;
  const markdownPath = `${target}/qa-catalog.md`;
  const gapPath = `${target}/qa-catalog-gaps.json`;
  const gapMarkdownPath = `${target}/qa-catalog-gaps.md`;
  let v1ManifestPath = null;
  const coverageReport = {
    schemaVersion: QA_CATALOG_VERSION,
    schema: "naia-shell.qa-catalog-coverage.v2",
    generatedAtUtc: catalog.generatedAtUtc,
    verification: catalog.verification,
    catalogStatus: catalog.catalogStatus,
    structuralReady: catalog.structuralReady,
    scopeReviewReady: catalog.scopeReviewReady,
    inventorySha256: catalog.inventorySha256,
    compiledCasesSha256: catalog.compiledCasesSha256,
    scopeReview: catalog.scopeReview,
    initializationAllowed: catalog.initializationAllowed,
    executionStatus: catalog.executionStatus,
    completeness: catalog.completeness,
    inventory: catalog.inventory,
    summary: catalog.coverage.summary,
    byLayer: catalog.coverage.byLayer,
    byKind: catalog.coverage.byKind,
    ledger: catalog.coverage.ledger,
    gapReport: catalog.gapReport,
    specCaseCounts: catalog.specCaseCounts,
    diagnostics: catalog.diagnostics,
  };
  writeFileSync(manifestPath, `${JSON.stringify(catalog, null, 2)}\n`);
  writeFileSync(coveragePath, `${JSON.stringify(coverageReport, null, 2)}\n`);
  writeFileSync(markdownPath, renderCatalogMarkdown(catalog));
  writeFileSync(gapPath, `${JSON.stringify(catalog.gapReport, null, 2)}\n`);
  writeFileSync(gapMarkdownPath, renderGapReportMarkdown(catalog.gapReport));
  if (catalog.initializationAllowed) {
    v1ManifestPath = `${target}/qa-round-manifest.json`;
    writeFileSync(v1ManifestPath, `${JSON.stringify(exportV1Manifest(catalog), null, 2)}\n`);
  }
  return { outputDir: target, manifestPath, coveragePath, markdownPath, gapPath, gapMarkdownPath, v1ManifestPath };
}

function parseCli(argv) {
  const options = { fragments: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--fragment") options.fragments.push(argv[++index]);
    else if (arg === "--inventory") options.inventory = argv[++index];
    else if (arg === "--project-root") options.projectRoot = argv[++index];
    else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg === "--adk") options.adk = argv[++index];
    else if (arg === "--scope-review") options.scopeReview = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: qa-catalog.mjs --inventory FILE --project-root DIR --fragment FILE [--fragment FILE ...] [--scope-review FILE] [--output-dir DIR | --adk DIR]\n\nCompiles source-backed QA fragments without executing the product. Structural readiness and scope review are separate gates; a v1 manifest is written only after a valid hash-bound scope review with no unresolved dispositions.`);
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === invokedPath) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    if (!options.inventory || !options.projectRoot || options.fragments.length === 0) {
      printHelp();
      process.exit(2);
    }
    const outputDir = options.outputDir ?? (options.adk ? resolve(options.adk, "qa", "catalog") : resolve(process.cwd(), "qa-catalog-output"));
    const catalog = compileCatalog(options);
    const outputs = writeCatalogOutputs(catalog, outputDir);
    console.log(JSON.stringify({
      schema: catalog.schema,
      catalogStatus: catalog.catalogStatus,
      structuralReady: catalog.structuralReady,
      scopeReviewReady: catalog.scopeReviewReady,
      initializationAllowed: catalog.initializationAllowed,
      executionStatus: catalog.executionStatus,
      cases: catalog.cases.length,
      sources: catalog.sources.length,
      inventoryEntities: catalog.inventory.entityCount,
      coverage: catalog.coverage.summary,
      diagnostics: catalog.diagnostics.counts,
      outputs,
    }, null, 2));
  } catch (error) {
    console.error(error?.stack ?? error);
    process.exit(1);
  }
}
