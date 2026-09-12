import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCatalog,
  classifyId,
  extractIdTokens,
  parseMarkdownSource,
} from './qa-traceability.mjs';

const fixture = [
  '# Fixture traceability',
  '',
  '| ID | Description | UC | SPEC | TEST-S | TEST-F | Status |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  '| REQ-001 | Requirement title | UC-001 | SPEC-001 | TEST-S-001 |  | Pass |',
  '| UC-001 | User outcome | REQ-001 | SPEC-001 | TEST-S-001 |  | Pass |',
  '| SPEC-001 | Feature design | UC-001 | TEST-F-001 |  |  | Pass |',
  '| TEST-S-001 | Scenario test | UC-001 | REQ-001 |  |  | Pass |',
  '| TEST-F-001 | Feature test | SPEC-001 |  |  |  | Pass |',
  '| TEST-S-099 | Missing scenario test | UC-999 |  |  |  | Planned |',
  '',
  'A narrative note mentions UC-999 and FR-MISSING. It is a reference cluster.',
  'Agent-side feature delegation: UC-005/006/008 uses SPEC-006 and new-naia-agent.',
].join('\n');

test('extracts canonical and compact IDs without inventing ranges', () => {
  assert.deepEqual(extractIdTokens('UC-005/006/008 and FR-GROK.1~4'), [
    'UC-005',
    'FR-GROK.1',
    'UC-006',
    'UC-008',
  ]);
  assert.equal(classifyId('SPEC-001'), 'feature-design');
  assert.equal(classifyId('FE-CONV.1'), 'feature-requirement');
  assert.equal(classifyId('NFR-101'), 'nonfunctional-requirement');
});

test('preserves dotted UC boundaries and independent scenario IDs', () => {
  assert.deepEqual(extractIdTokens('UC-AV.1 and UC-AV.3; UC7a UC10a; UC-001suffix is not UC-001; UC-001 is valid'), [
    'UC-AV.1',
    'UC-AV.3',
    'UC7a',
    'UC10a',
    'UC-001',
  ]);
  assert.equal(classifyId('S01'), 'scenario-catalog');
  assert.equal(classifyId('S52b'), 'scenario-catalog');
  assert.equal(classifyId('S-INSTALL'), 'scenario-catalog');

  const parsed = parseMarkdownSource({
    relativePath: 'scenarios.md',
    text: [
      '| ID | Title | UC |',
      '| --- | --- | --- |',
      '| UC-001 | Chat |  |',
      '| S01 | Onboarding | UC-001 |',
      '| S52b | Memory backup |  |',
      '| S-INSTALL | Installer | UC-001suffix |',
    ].join('\n'),
    sourceKind: 'detail',
    titleCell: 1,
  });
  assert.deepEqual(parsed.definitions.map((item) => item.id), ['UC-001', 'S01', 'S52b', 'S-INSTALL']);
  assert.ok(parsed.relations.some((item) => item.from === 'S01' && item.to === 'UC-001'));
  assert.ok(!parsed.relations.some((item) => item.to === 'UC-001suffix'));

  const dotted = parseMarkdownSource({
    relativePath: 'dotted.md',
    text: '> - **UC-AV.1** local focus\n> - **UC-AV.3** avatar gate',
    sourceKind: 'detail',
  });
  assert.deepEqual(dotted.definitions.map((item) => item.id), ['UC-AV.1', 'UC-AV.3']);
  assert.equal(dotted.definitions[0].syntax, 'list-item');
  assert.match(dotted.definitions[0].title, /local focus/);

  const explanatory = parseMarkdownSource({
    relativePath: 'notes.md',
    text: '- UC-007(F2/F3) graft is an explanatory note',
    sourceKind: 'registry',
    registry: 'fixture',
  });
  assert.deepEqual(explanatory.definitions, []);
});

test('excludes scenario table headers and keeps row titles ahead of UC evidence', () => {
  assert.deepEqual(extractIdTokens('| S-ID | 기능 | 근거 UC | 검증 |'), []);
  const parsed = parseMarkdownSource({
    relativePath: 'scenario-table.md',
    text: [
      '| S-ID | 기능 | 근거 UC | 검증 |',
      '| --- | --- | --- | --- |',
      '| **S71 번들 default-skills 컬렉션 (~60+, OpenClaw 출처)** = command-group | UC5 | pass |',
    ].join('\n'),
    sourceKind: 'detail',
    titleCell: 1,
  });
  assert.deepEqual(parsed.definitions.map((item) => item.id), ['S71']);
  assert.match(parsed.definitions[0].title, /번들 default-skills 컬렉션/);
  assert.notEqual(parsed.definitions[0].title, 'UC5');
});

test('parses definitions, direct relations, unknown targets, and delegation evidence', () => {
  const parsed = parseMarkdownSource({
    relativePath: 'fixture.md',
    text: fixture,
    sourceKind: 'registry',
    registry: 'fixture',
    titleCell: 1,
    statusCell: 6,
  });
  assert.equal(parsed.definitions.length, 6);
  assert.equal(parsed.definitions.find((item) => item.id === 'REQ-001').line, 5);
  assert.equal(parsed.definitions.find((item) => item.id === 'SPEC-001').title, 'Feature design');
  assert.ok(parsed.relations.some((item) => item.from === 'REQ-001' && item.to === 'UC-001'));
  assert.ok(parsed.relations.some((item) => item.from === 'TEST-S-099' && item.to === 'UC-999'));
  assert.equal(parsed.referenceClusters.length, 2);
  assert.equal(parsed.delegations.length, 1);
  assert.deepEqual(parsed.delegations[0].ids, ['UC-005', 'SPEC-006', 'UC-006', 'UC-008']);
});

test('builds a catalog with MAPPED and UNMAPPED relation status', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'qa-traceability-'));
  writeFileSync(join(fixtureRoot, 'fixture.md'), fixture, 'utf8');
  const catalog = buildCatalog({
    projectRoot: fixtureRoot,
    sourceSpecs: [{
      path: 'fixture.md',
      sourceKind: 'registry',
      registry: 'fixture',
      titleCell: 1,
      statusCell: 6,
    }],
  });
  assert.equal(catalog.totals.uniqueEntities, 6);
  assert.ok(catalog.relations.some((item) => item.status === 'MAPPED'));
  assert.ok(catalog.relations.some((item) => item.status === 'UNMAPPED' && item.to === 'UC-999'));
  assert.equal(catalog.unmapped.references.length, 2);
});

test('keeps scenario catalog entries separate from UC registry totals', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'qa-traceability-scenarios-'));
  writeFileSync(join(fixtureRoot, 'scenarios.md'), [
    '| ID | Title | UC |',
    '| --- | --- | --- |',
    '| UC-001 | Chat |  |',
    '| S01 | Onboarding | UC-001 |',
    '| S52b | Backup |  |',
  ].join('\n'), 'utf8');
  const catalog = buildCatalog({
    projectRoot: fixtureRoot,
    sourceSpecs: [{ path: 'scenarios.md', sourceKind: 'detail', titleCell: 1 }],
  });
  assert.equal(catalog.scenarioCatalog.totalEntries, 2);
  assert.equal(catalog.scenarioCatalog.mappedEntries, 1);
  assert.equal(catalog.scenarioCatalog.unmappedEntries, 1);
  assert.equal(catalog.totals.uniqueEntitiesByLayer['scenario-catalog'], 2);
  assert.equal(catalog.totals.uniqueEntitiesByLayer['use-case'], 1);
});
