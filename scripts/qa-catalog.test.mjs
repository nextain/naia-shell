import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileCatalog,
  exportV1Manifest,
  renderCatalogMarkdown,
  validateManifest,
  writeCatalogOutputs,
} from "./qa-catalog.mjs";
import { initRound } from "./qa-round.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "naia-qa-catalog-test-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "source.md"), "# fixture\n".repeat(20));
  return root;
}

function entity(id, layer, line = 1) {
  return {
    id,
    layer,
    title: `${id} title`,
    definitions: [{
      id,
      layer,
      title: `${id} title`,
      file: "docs/source.md",
      line,
      sourceKind: layer,
      evidence: `${id} fixture definition`,
    }],
  };
}

function inventory(ids = [
  ["UC-1", "use-case"],
  ["UC-2", "use-case"],
  ["SPEC-001", "feature-design"],
]) {
  return {
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
    entities: ids.map(([id, layer], index) => entity(id, layer, index + 1)),
  };
}

function baseCase(overrides = {}) {
  return {
    id: "CASE-001",
    title: "Fixture case",
    method: "Open the fixture and perform the action",
    expectedResult: "The action completes and the result is visible",
    ucIds: ["UC-1"],
    feIds: ["SPEC-001"],
    sourceRef: "docs/source.md:1",
    deviceIds: ["linux3090"],
    execution: { kind: "manual", ref: "fixture" },
    ...overrides,
  };
}

function compile(root, value, customInventory = inventory()) {
  return compileCatalog({
    inventory: customInventory,
    projectRoot: root,
    fragments: [{ path: "fixture.json", value }],
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
  });
}

test("coverage requires structured links; prose mentions do not cover an entity", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({ method: "Mention UC-2 in prose only" })],
  });

  const uc1 = catalog.coverage.ledger.find((entry) => entry.id === "UC-1");
  const uc2 = catalog.coverage.ledger.find((entry) => entry.id === "UC-2");
  assert.equal(uc1.coverageStatus, "COVERED");
  assert.equal(uc2.coverageStatus, "UNCONNECTED");
  assert.equal(catalog.coverage.summary.unconnected, 1);
  assert.equal(catalog.structuralReady, true);
  assert.equal(catalog.scopeReviewReady, false);
  assert.equal(catalog.initializationAllowed, false);
});

test("requirement, scenario, and test link fields validate exact inventory layers", () => {
  const root = fixtureRoot();
  const customInventory = inventory([
    ["UC-1", "use-case"],
    ["SPEC-001", "feature-design"],
    ["REQ-1", "requirement"],
    ["S-1", "scenario-catalog"],
    ["TEST-S-1", "scenario-test"],
  ]);
  const catalog = compile(root, {
    cases: [baseCase({
      requirementIds: ["REQ-1"],
      scenarioIds: ["S-1"],
      testIds: ["TEST-S-1"],
    })],
  }, customInventory);

  for (const id of ["REQ-1", "S-1", "TEST-S-1"]) {
    assert.equal(catalog.coverage.ledger.find((entry) => entry.id === id).coverageStatus, "COVERED");
  }
  assert.equal(catalog.coverage.byKind.REQ.covered, 1);
  assert.equal(catalog.coverage.byKind.S.covered, 1);
  assert.equal(catalog.coverage.byKind.TEST.covered, 1);
  assert.equal(catalog.coverage.summary.unconnected, 0);
  assert.equal(catalog.catalogStatus, "COMPLETE_PENDING_REVIEW");
  assert.equal(catalog.structuralReady, true);
  assert.equal(catalog.initializationAllowed, false);
  assert.equal(catalog.executionStatus, "not-performed");
  assert.equal(catalog.verification.status, "unverified");
});

test("optional requirement, scenario, and test arrays may be empty", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({
      requirementIds: [],
      scenarioIds: [],
      testIds: [],
    })],
  });

  const emptyLinkFields = catalog.diagnostics.errors
    .filter((entry) => entry.code === "empty-source-links")
    .map((entry) => entry.field);
  assert.deepEqual(emptyLinkFields, []);
});

test("a real user-scenario link and FE link are required", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({
      ucIds: [],
      feIds: [],
      requirementIds: [],
      scenarioIds: [],
      testIds: [],
    })],
  });

  const emptyLinkFields = catalog.diagnostics.errors
    .filter((entry) => entry.code === "empty-source-links")
    .map((entry) => entry.field)
    .sort();
  assert.deepEqual(emptyLinkFields, ["feIds"]);
  assert.ok(catalog.diagnostics.errors.some((entry) => entry.code === "missing-user-scenario-links"));
  assert.equal(catalog.structuralReady, false);
});

test("a scenario-catalog link can satisfy the user-scenario side of a case", () => {
  const root = fixtureRoot();
  const customInventory = inventory([
    ["S-ONLY-1", "scenario-catalog"],
    ["SPEC-001", "feature-design"],
  ]);
  const catalog = compile(root, {
    cases: [baseCase({ ucIds: [], scenarioIds: ["S-ONLY-1"] })],
  }, customInventory);

  assert.equal(catalog.structuralReady, true);
  assert.equal(catalog.coverage.ledger.find((entry) => entry.id === "S-ONLY-1").coverageStatus, "COVERED");
  assert.equal(catalog.coverage.ledger.find((entry) => entry.id === "SPEC-001").coverageStatus, "COVERED");
  const sourceLink = catalog.sourceLinks.find((entry) => entry.id === "S-ONLY-1");
  assert.equal(sourceLink.kind, "UC");
  assert.equal(sourceLink.layer, "scenario-catalog");
  assert.deepEqual(sourceLink.caseIds, ["CASE-001"]);

  const reviewed = compileCatalog({
    inventory: customInventory,
    projectRoot: root,
    fragments: [{ path: "fixture.json", value: { cases: [baseCase({ ucIds: [], scenarioIds: ["S-ONLY-1"] })] } }],
    scopeReview: {
      schema: "naia-shell.qa-scope-review.v1",
      reviewer: "fixture-reviewer",
      reviewedAtUtc: "2026-09-08T00:01:00.000Z",
      inventorySha256: catalog.inventorySha256,
      compiledCasesSha256: catalog.compiledCasesSha256,
      dispositions: [
        {
          sourceId: "S-ONLY-1",
          disposition: "direct-case",
          evidence: ["CASE-001 declares scenarioIds=[S-ONLY-1]"],
          targetIds: ["CASE-001"],
        },
        {
          sourceId: "SPEC-001",
          disposition: "direct-case",
          evidence: ["CASE-001 declares feIds=[SPEC-001]"],
          targetIds: ["CASE-001"],
        },
      ],
    },
    generatedAtUtc: "2026-09-08T00:02:00.000Z",
  });
  const manifest = exportV1Manifest(reviewed);
  const manifestSourceLink = manifest.sourceLinks.find((entry) => entry.id === "S-ONLY-1");
  assert.equal(manifestSourceLink.kind, "UC");
  assert.equal(manifestSourceLink.layer, "scenario-catalog");
  assert.deepEqual(manifestSourceLink.caseIds, ["CASE-001"]);
});

test("a fake scenario-catalog link is rejected even when FE is real", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({ ucIds: [], scenarioIds: ["S-NOT-REAL"] })],
  }, inventory([["SPEC-001", "feature-design"]]));

  const codes = catalog.diagnostics.errors.map((entry) => entry.code);
  assert.ok(codes.includes("unknown-source-id"));
  assert.ok(codes.includes("missing-user-scenario-links"));
  assert.equal(catalog.structuralReady, false);
});

test("declared source refs match inventory definition lines", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    sources: [{ id: "UC-1", kind: "UC", ref: "docs/source.md:1" }],
    cases: [baseCase()],
  });

  const source = catalog.sources.find((entry) => entry.id === "UC-1");
  assert.equal(source.provenance, "declared");
  assert.equal(source.definitionMatches.length, 1);
  assert.equal(source.definitionMatches[0].line, 1);
  assert.equal(catalog.diagnostics.warnings.some((entry) => entry.code === "source-definition-line-unmatched" && entry.id === "UC-1"), false);
});

test("wrong structured link layer is diagnosed instead of becoming coverage", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({ requirementIds: ["SPEC-001"] })],
  });

  const codes = catalog.diagnostics.errors.map((entry) => entry.code);
  assert.ok(codes.includes("source-layer-mismatch"));
  assert.ok(codes.includes("source-link-kind-conflict"));
  assert.equal(catalog.coverage.summary.linkedInvalidLink, 1);
  assert.equal(catalog.initializationAllowed, false);
});

test("unknown IDs, missing files, and blank procedure fields remain structural errors", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({
      method: "",
      expectedResult: "",
      feIds: ["TYPO-SPEC"],
      sourceRef: "docs/missing.md:1",
    })],
  });

  const codes = catalog.diagnostics.errors.map((entry) => entry.code);
  assert.ok(codes.includes("blank-case-method"));
  assert.ok(codes.includes("blank-case-expected"));
  assert.ok(codes.includes("unknown-source-id"));
  assert.ok(codes.includes("missing-source-file"));
  assert.equal(catalog.catalogStatus, "INCOMPLETE");
});

test("exact duplicate cases dedupe while different bodies are a conflict", () => {
  const root = fixtureRoot();
  const first = { cases: [baseCase()] };
  const same = { cases: [baseCase()] };
  const different = { cases: [baseCase({ expectedResult: "A different result" })] };
  const catalog = compileCatalog({
    inventory: inventory(),
    projectRoot: root,
    fragments: [
      { path: "one.json", value: first },
      { path: "same.json", value: same },
      { path: "different.json", value: different },
    ],
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
  });

  assert.equal(catalog.cases.length, 1);
  assert.ok(catalog.diagnostics.warnings.some((entry) => entry.code === "exact-duplicate-case-deduped"));
  assert.ok(catalog.diagnostics.errors.some((entry) => entry.code === "duplicate-case-conflict"));
});

test("explicit exclusions are separate from unconnected inventory", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase()],
    exclusions: [{ sourceId: "UC-2", reason: "outside this QA round", source: "release-scope" }],
  });

  const excluded = catalog.coverage.ledger.find((entry) => entry.id === "UC-2");
  assert.equal(excluded.coverageStatus, "EXCLUDED");
  assert.equal(excluded.exclusion.reason, "outside this QA round");
  assert.equal(catalog.coverage.summary.excluded, 1);
  assert.equal(catalog.coverage.summary.unconnected, 0);
});

test("device aliases are normalized and SPEC counts use distinct device rows", () => {
  const root = fixtureRoot();
  const catalog = compile(root, {
    cases: [baseCase({ deviceIds: ["linux-qa", "windows-qa"] })],
  });

  assert.deepEqual(catalog.cases[0].deviceIds, ["linux3090", "windows4060"]);
  assert.deepEqual(catalog.cases[0].deviceAliases, [
    { from: "linux-qa", to: "linux3090" },
    { from: "windows-qa", to: "windows4060" },
  ]);
  const spec = catalog.specCaseCounts.find((entry) => entry.specId === "SPEC-001");
  assert.equal(spec.caseCount, 1);
  assert.equal(spec.deviceRowCount, 2);
  assert.deepEqual(spec.devices, ["linux3090", "windows4060"]);
});

test("outputs preserve unverified execution status and the source-backed ledger", () => {
  const root = fixtureRoot();
  const catalog = compile(root, { cases: [baseCase()] });
  const outputDir = join(root, "out");
  const outputs = writeCatalogOutputs(catalog, outputDir);
  const manifest = JSON.parse(readFileSync(outputs.manifestPath, "utf8"));
  const coverage = JSON.parse(readFileSync(outputs.coveragePath, "utf8"));
  const markdown = readFileSync(outputs.markdownPath, "utf8");

  assert.equal(manifest.executionStatus, "not-performed");
  assert.equal(manifest.structuralReady, true);
  assert.equal(manifest.scopeReviewReady, false);
  assert.equal(manifest.initializationAllowed, false);
  assert.equal(outputs.v1ManifestPath, null);
  assert.equal(manifest.verification.status, "unverified");
  assert.equal(coverage.summary.total, catalog.coverage.summary.total);
  assert.equal(coverage.gapReport.summary.total, catalog.gapReport.summary.total);
  assert.ok(outputs.gapPath);
  assert.ok(outputs.gapMarkdownPath);
  const gap = JSON.parse(readFileSync(outputs.gapPath, "utf8"));
  const gapMarkdown = readFileSync(outputs.gapMarkdownPath, "utf8");
  assert.equal(gap.summary.total, catalog.gapReport.summary.total);
  assert.match(gapMarkdown, /Naia QA source gap report/);
  assert.ok(coverage.byLayer["use-case"]);
  assert.match(markdown, /Execution status: \*\*not-performed\*\*/);
  assert.match(markdown, /Structural ready: \*\*yes\*\*/);
  assert.match(markdown, /Scope review ready: \*\*no\*\*/);
  assert.match(markdown, /## QC case index/);
  assert.match(markdown, /QC-001.*CASE-001/);
  assert.match(markdown, /Coverage by inventory layer/);
  assert.match(renderCatalogMarkdown(catalog), /SPEC counts/);
});

test("scope review hashes and per-source dispositions unlock v1 export", () => {
  const root = fixtureRoot();
  const inventoryValue = inventory([[
    "S-1", "scenario-catalog",
  ], [
    "SPEC-001", "feature-design",
  ]]);
  const fragments = [{ path: "fixture.json", value: { cases: [baseCase({ ucIds: [], scenarioIds: ["S-1"] })] } }];
  const draft = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
  });
  const scopeReview = {
    schema: "naia-shell.qa-scope-review.v1",
    reviewer: "fixture-reviewer",
    reviewedAtUtc: "2026-09-08T00:01:00.000Z",
    inventorySha256: draft.inventorySha256,
    compiledCasesSha256: draft.compiledCasesSha256,
    dispositions: [
      {
        sourceId: "S-1",
        disposition: "direct-case",
        evidence: ["CASE-001 declares scenarioIds=[S-1]"],
        targetIds: ["CASE-001"],
      },
      {
        sourceId: "SPEC-001",
        disposition: "direct-case",
        evidence: ["CASE-001 declares feIds=[SPEC-001]"],
        targetIds: ["CASE-001"],
      },
    ],
  };
  const reviewed = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    scopeReview,
    generatedAtUtc: "2026-09-08T00:02:00.000Z",
  });

  assert.equal(reviewed.structuralReady, true);
  assert.equal(reviewed.scopeReviewReady, true);
  assert.equal(reviewed.initializationAllowed, true);
  assert.equal(reviewed.catalogStatus, "COMPLETE_REVIEWED");
  const manifest = exportV1Manifest(reviewed);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.schema, "naia-shell.qa-round.v1");
  assert.equal(manifest.executionStatus, "not-performed");
  assert.equal(manifest.sources.length, 2);
  assert.equal(manifest.cases.length, 1);
  assert.deepEqual(manifest.exclusions, []);
  assert.equal(manifest.verification.status, "verified");
  assert.match(manifest.verification.evidenceRef, /scope-review-and-coverage/);
  const scenarioLink = manifest.sourceLinks.find((entry) => entry.id === "S-1");
  assert.equal(scenarioLink.kind, "UC");
  assert.equal(scenarioLink.layer, "scenario-catalog");
  assert.deepEqual(scenarioLink.caseIds, ["CASE-001"]);
  assert.equal(validateManifest(manifest, {
    inventorySha256: reviewed.inventorySha256,
    compiledCasesSha256: reviewed.compiledCasesSha256,
  }).valid, true);

  const changedReview = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    scopeReview: { ...scopeReview, inventorySha256: "changed-inventory-hash" },
    generatedAtUtc: "2026-09-08T00:03:00.000Z",
  });
  assert.equal(changedReview.structuralReady, true);
  assert.equal(changedReview.scopeReviewReady, false);
  assert.ok(changedReview.scopeReview.errors.some((entry) => entry.code === "scope-review-inventory-hash-mismatch"));
});

test("v1 export initializes a NOT_RUN round through the actual round validator", () => {
  const root = fixtureRoot();
  const inventoryValue = inventory([
    ["S-1", "scenario-catalog"],
    ["SPEC-001", "feature-design"],
  ]);
  const fragments = [{ path: "fixture.json", value: { cases: [baseCase({ ucIds: [], scenarioIds: ["S-1"] })] } }];
  const draft = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
  });
  const reviewed = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    scopeReview: {
      schema: "naia-shell.qa-scope-review.v1",
      reviewer: "fixture-reviewer",
      reviewedAtUtc: "2026-09-08T00:01:00.000Z",
      inventorySha256: draft.inventorySha256,
      compiledCasesSha256: draft.compiledCasesSha256,
      dispositions: [
        {
          sourceId: "S-1",
          disposition: "direct-case",
          evidence: ["CASE-001 declares scenarioIds=[S-1]"],
          targetIds: ["CASE-001"],
        },
        {
          sourceId: "SPEC-001",
          disposition: "direct-case",
          evidence: ["CASE-001 declares feIds=[SPEC-001]"],
          targetIds: ["CASE-001"],
        },
      ],
    },
    generatedAtUtc: "2026-09-08T00:02:00.000Z",
  });
  const manifest = exportV1Manifest(reviewed);
  const manifestPath = join(root, "round-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const state = initRound({
    adkPath: join(root, "adk"),
    manifestPath,
    roundId: "catalog-export",
    candidate: "fixture-candidate",
  });

  assert.equal(state.launchReady, false);
  assert.deepEqual(state.results.map((entry) => entry.result), ["NOT_RUN"]);
  assert.equal(state.verification.status, "verified");
  assert.equal(state.cases[0].ucIds.includes("S-1"), true);
  assert.equal(state.cases[0].feIds.includes("SPEC-001"), true);
});

test("v1 manifest validation rejects missing, changed, and unresolved review evidence", () => {
  const root = fixtureRoot();
  const inventoryValue = inventory([[
    "UC-1", "use-case",
  ], [
    "SPEC-001", "feature-design",
  ]]);
  const fragments = [{ path: "fixture.json", value: { cases: [baseCase()] } }];
  const draft = compileCatalog({
    inventory: inventoryValue,
    projectRoot: root,
    fragments,
    generatedAtUtc: "2026-09-08T00:00:00.000Z",
  });
  const scopeReview = {
    schema: "naia-shell.qa-scope-review.v1",
    reviewer: "fixture-reviewer",
    reviewedAtUtc: "2026-09-08T00:01:00.000Z",
    inventorySha256: draft.inventorySha256,
    compiledCasesSha256: draft.compiledCasesSha256,
    dispositions: [
      { sourceId: "UC-1", disposition: "direct-case", evidence: ["case link"], targetIds: ["CASE-001"] },
      { sourceId: "SPEC-001", disposition: "direct-case", evidence: ["case link"], targetIds: ["CASE-001"] },
    ],
  };
  const reviewed = compileCatalog({ inventory: inventoryValue, projectRoot: root, fragments, scopeReview });
  const manifest = exportV1Manifest(reviewed);

  const missingReview = validateManifest({ ...manifest, scopeReview: null }, {
    inventorySha256: reviewed.inventorySha256,
    compiledCasesSha256: reviewed.compiledCasesSha256,
  });
  assert.equal(missingReview.valid, false);
  assert.ok(missingReview.errors.some((entry) => entry.code === "manifest-review-missing"));

  const changedInventory = validateManifest(manifest, {
    inventorySha256: "changed-inventory-hash",
    compiledCasesSha256: reviewed.compiledCasesSha256,
  });
  assert.equal(changedInventory.valid, false);
  assert.ok(changedInventory.errors.some((entry) => entry.code === "manifest-inventory-hash-mismatch"));

  const changedCases = validateManifest(manifest, {
    inventorySha256: reviewed.inventorySha256,
    compiledCasesSha256: "changed-cases-hash",
  });
  assert.equal(changedCases.valid, false);
  assert.ok(changedCases.errors.some((entry) => entry.code === "manifest-cases-hash-mismatch"));

  const changedNestedReview = validateManifest({
    ...manifest,
    scopeReview: { ...manifest.scopeReview, inventorySha256: "nested-changed-inventory-hash" },
  }, {
    inventorySha256: reviewed.inventorySha256,
    compiledCasesSha256: reviewed.compiledCasesSha256,
  });
  assert.equal(changedNestedReview.valid, false);
  assert.ok(changedNestedReview.errors.some((entry) => entry.code === "manifest-review-inventory-hash-mismatch"));

  const unresolved = {
    ...manifest,
    scopeReviewReady: false,
    initializationAllowed: false,
    scopeReview: { ...manifest.scopeReview, valid: true, unresolvedCount: 1 },
  };
  const unresolvedGate = validateManifest({ ...unresolved, scopeReviewReady: true, initializationAllowed: true }, {
    inventorySha256: reviewed.inventorySha256,
    compiledCasesSha256: reviewed.compiledCasesSha256,
  });
  assert.equal(unresolvedGate.valid, false);
  assert.ok(unresolvedGate.errors.some((entry) => entry.code === "manifest-review-unresolved"));
  assert.throws(() => exportV1Manifest({
    ...reviewed,
    scopeReviewReady: false,
    initializationAllowed: false,
    scopeReview: { ...reviewed.scopeReview, scopeReviewReady: false, unresolvedCount: 1 },
  }), /unresolved dispositions/);
});
