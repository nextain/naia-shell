#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
export const SCHEMA_VERSION = 'qa-traceability.v1';

const ID_ALTERNATIVES = [
  'TEST-[SF]-\\d{3}',
  'SPEC-\\d{3}',
  'REQ-\\d{3}',
  'NFR-[A-Z0-9][A-Z0-9.-]*',
  'FR-[A-Z0-9][A-Z0-9.-]*',
  'FE-[A-Z0-9][A-Z0-9.-]*',
  // Keep dotted UC IDs (for example UC-AV.1 and UC-AV.3) as distinct tokens.
  // The final alphanumeric boundary also prevents UC-001suffix from being
  // accepted as the shorter UC-001 ID.
  'UC-(?:\\d{3}|[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?)',
  // Preserve the suffixed compact IDs used by user-scenarios (UC7a, UC10a,
  // UC13a), while the trailing boundary keeps UC001suffix from becoming
  // a false match for a shorter compact ID.
  'UC\\d+[A-Za-z]?(?:-[A-Za-z0-9]+)*',
  // User-scenario catalog IDs are an independent source layer.  Do not fold
  // them into UC: their UC references are evidence that still needs mapping.
  'S(?:\\d+[A-Za-z]?|-[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?)',
];

export const ID_PATTERN = `(?<![A-Za-z0-9])(?:${ID_ALTERNATIVES.join('|')})(?![A-Za-z0-9])`;
const ID_RE = new RegExp(ID_PATTERN, 'g');
const COMPACT_UC_RE = /(?<![A-Za-z0-9])UC-(\d{3}(?:\/\d{3})+)(?![A-Za-z0-9])/g;
const NATIVE_SPEC_RE = /(?:[A-Za-z0-9_.-]+\/)*packages\/shell\/e2e-tauri\/specs\/[A-Za-z0-9_.-]+\.(?:spec|test)\.[A-Za-z0-9]+/g;
// This is a table column header, not an independent S-prefixed scenario.
const NON_ENTITY_IDS = new Set(['S-ID']);

const LAYER_ORDER = [
  'requirement',
  'feature-requirement',
  'nonfunctional-requirement',
  'use-case',
  'scenario-catalog',
  'feature-design',
  'scenario-test',
  'feature-test',
  'other',
];

const DEFAULT_SOURCES = [
  {
    path: 'docs/progress/01.requirements/INDEX.md',
    sourceKind: 'registry',
    registry: 'requirements',
    titleCell: 2,
    statusCell: 3,
  },
  {
    path: 'docs/progress/02.user-scenarios/INDEX.md',
    sourceKind: 'registry',
    registry: 'use-cases',
    titleCell: 2,
    statusCell: 4,
  },
  {
    path: 'docs/progress/03.uc-tests/INDEX.md',
    sourceKind: 'registry',
    registry: 'scenario-tests',
    titleCell: 2,
    statusCell: 5,
  },
  {
    path: 'docs/progress/04.features/INDEX.md',
    sourceKind: 'registry',
    registry: 'feature-design',
    titleCell: 2,
    statusCell: 4,
  },
  {
    path: 'docs/progress/05.features-tests/INDEX.md',
    sourceKind: 'registry',
    registry: 'feature-tests',
    titleCell: 2,
    statusCell: 4,
  },
  {
    path: 'docs/requirements.md',
    sourceKind: 'detail',
    registry: null,
    titleCell: 1,
    statusCell: null,
  },
  {
    path: 'docs/user-scenarios.md',
    sourceKind: 'detail',
    registry: null,
    titleCell: 1,
    statusCell: null,
  },
  {
    path: 'docs/progress/issue-windows-nva-voice-media-hardening-2026-08-06.md',
    sourceKind: 'native-trace',
    registry: null,
    titleCell: 1,
    statusCell: null,
  },
  {
    path: 'docs/progress/README.md',
    sourceKind: 'trace-guidance',
    registry: null,
    titleCell: 1,
    statusCell: null,
  },
  {
    path: 'docs/radio-dj-practical-test-scenarios.md',
    sourceKind: 'qa-detail',
    registry: null,
    titleCell: 1,
    statusCell: null,
    coverageNote: '35 RD practical QA cases across 7 groups are source coverage; they are not registry entity totals.',
  },
];

const CANONICAL_PAIRS = [
  { from: 'requirement', to: 'use-case', name: 'requirement→UC' },
  { from: 'feature-requirement', to: 'use-case', name: 'FE→UC' },
  { from: 'nonfunctional-requirement', to: 'use-case', name: 'NFR→UC' },
  { from: 'use-case', to: 'feature-design', name: 'UC→SPEC' },
  { from: 'feature-design', to: 'feature-test', name: 'SPEC→TEST-F' },
  { from: 'use-case', to: 'scenario-test', name: 'UC→TEST-S' },
  { from: 'requirement', to: 'scenario-test', name: 'requirement→TEST-S' },
  { from: 'feature-requirement', to: 'scenario-test', name: 'FE→TEST-S' },
  { from: 'nonfunctional-requirement', to: 'scenario-test', name: 'NFR→TEST-S' },
  { from: 'scenario-catalog', to: 'use-case', name: 'scenario→UC' },
];

function normalizeIdToken(raw) {
  let token = String(raw).trim().replace(/^[`*_\[({]+/, '').replace(/[`*_\])}]+$/, '');
  token = token.replace(/[,:;!?]+$/, '');
  if (token.endsWith('.') && !/\.\d$/.test(token)) token = token.slice(0, -1);
  if (token.endsWith('-')) token = token.slice(0, -1);
  return token;
}

export function extractIdTokens(text) {
  const value = String(text ?? '');
  const found = [];
  ID_RE.lastIndex = 0;
  for (const match of value.matchAll(ID_RE)) {
    const id = normalizeIdToken(match[0]);
    if (id && !NON_ENTITY_IDS.has(id) && !found.includes(id)) found.push(id);
  }
  COMPACT_UC_RE.lastIndex = 0;
  for (const match of value.matchAll(COMPACT_UC_RE)) {
    for (const number of match[1].split('/')) {
      const id = `UC-${number}`;
      if (!found.includes(id)) found.push(id);
    }
  }
  return found;
}

export function classifyId(id) {
  if (/^REQ-\d{3}$/.test(id)) return 'requirement';
  if (/^FR-/.test(id)) return 'feature-requirement';
  if (/^FE-/.test(id)) return 'feature-requirement';
  if (/^NFR-/.test(id)) return 'nonfunctional-requirement';
  if (/^UC(?:-|\d)/.test(id)) return 'use-case';
  if (/^S(?:\d+[A-Za-z]?|-[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?)$/.test(id)) return 'scenario-catalog';
  if (/^SPEC-\d{3}$/.test(id)) return 'feature-design';
  if (/^TEST-S-\d{3}$/.test(id)) return 'scenario-test';
  if (/^TEST-F-\d{3}$/.test(id)) return 'feature-test';
  return 'other';
}

function cleanMarkdown(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTableCells(line) {
  if (!line.includes('|')) return null;
  const cells = [];
  let current = '';
  let escaped = false;
  for (const character of line.trim()) {
    if (character === '|' && !escaped) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    if (character === '\\' && !escaped) {
      escaped = true;
      current += character;
      continue;
    }
    escaped = false;
    current += character;
  }
  cells.push(current.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  if (!cells.length || cells.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return cells.map((cell) => cleanMarkdown(cell.replace(/\\\|/g, '|')));
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function stripDefinitionPrefix(line) {
  return String(line ?? '').replace(/^\s*(?:(?:>\s*)+)?(?:[-+*]\s+|\d+[.)]\s+)?/, '');
}

function isBoldListDefinition(line) {
  const raw = String(line ?? '');
  const hasListMarker = /^\s*(?:(?:>\s*)+)?(?:[-+*]\s+|\d+[.)]\s+)/.test(raw);
  const stripped = stripDefinitionPrefix(raw);
  return hasListMarker && /^\*\*/.test(stripped);
}

function headingTitle(line, id) {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (!match) return '';
  let body = cleanMarkdown(match[1]);
  if (body.startsWith(id)) body = body.slice(id.length);
  return body.replace(/^\s*[-:—–]\s*/, '').trim();
}

function firstDefinitionId(cells, line) {
  if (cells?.length) {
    const first = extractIdTokens(cells[0]);
    const cleaned = cleanMarkdown(cells[0]);
    if (first.length && cleaned.startsWith(first[0])) return first[0];
  }
  if (isHeading(line)) {
    const ids = extractIdTokens(line);
    if (ids.length) {
      const heading = cleanMarkdown(line.replace(/^\s{0,3}#{1,6}\s+/, ''));
      if (heading.startsWith(ids[0])) return ids[0];
    }
  }
  // Detail documents use explicitly bold, ID-led list items for records such
  // as UC-AV.1 and S52b. Plain ID-led bullets are often explanatory notes
  // (for example, "UC-007(F2/F3) graft"), so do not promote those notes to
  // definitions and inflate registry totals.
  if (isBoldListDefinition(line)) {
    const lead = cleanMarkdown(stripDefinitionPrefix(line));
    const leadIds = extractIdTokens(lead);
    if (leadIds.length && lead.startsWith(leadIds[0])) return leadIds[0];
  }
  return null;
}

function titleForDefinition({ cells, line, id, source }) {
  if (isHeading(line)) return headingTitle(line, id) || id;
  if (!cells?.length) {
    const lead = cleanMarkdown(stripDefinitionPrefix(line));
    if (lead.startsWith(id)) {
      const title = lead.slice(id.length).replace(/^\s*[-:—–]\s*/, '').trim();
      return title || id;
    }
  }
  // Scenario rows often put the human title in the first cell immediately
  // after the bold S-ID, while the following cell contains the UC evidence.
  // Prefer that title so a row such as S71 ... | UC5 | ... is not titled UC5.
  if (classifyId(id) === 'scenario-catalog') {
    const firstCell = cleanMarkdown(cells?.[0] || '');
    if (firstCell.startsWith(id)) {
      const remainder = firstCell.slice(id.length).replace(/^\s*[-:—–=]\s*/, '').trim();
      if (remainder) return remainder;
    }
  }
  const preferred = Number.isInteger(source.titleCell) ? source.titleCell : 1;
  const candidate = cells?.[preferred] || cells?.slice(1).find(Boolean) || id;
  return cleanMarkdown(candidate) || id;
}

function statusForDefinition(cells, source) {
  if (!cells || !Number.isInteger(source.statusCell)) return null;
  return cleanMarkdown(cells[source.statusCell] || '') || null;
}

function testRefsForLine(cells, line) {
  const values = [...(cells || []), line];
  const refs = new Set();
  for (const value of values) {
    const cleaned = cleanMarkdown(value);
    if (/(?:e2e|spec|test|__tests__|scripts\/)/i.test(cleaned)) refs.add(cleaned);
  }
  return [...refs];
}

function relationKey(relation) {
  return `${relation.from}|${relation.to}|${relation.file}|${relation.line}`;
}

function canonicalizeRelation(fromId, toId) {
  const fromLayer = classifyId(fromId);
  const toLayer = classifyId(toId);
  for (const pair of CANONICAL_PAIRS) {
    if (pair.from === fromLayer && pair.to === toLayer) {
      return {
        name: pair.name,
        orientation: 'forward',
        canonicalFrom: fromId,
        canonicalTo: toId,
      };
    }
    if (pair.from === toLayer && pair.to === fromLayer) {
      return {
        name: pair.name,
        orientation: 'reverse',
        canonicalFrom: toId,
        canonicalTo: fromId,
      };
    }
  }
  if (fromLayer !== toLayer) {
    return {
      name: `${fromLayer}→${toLayer}`,
      orientation: 'other',
      canonicalFrom: null,
      canonicalTo: null,
    };
  }
  return {
    name: `${fromLayer}↔${toLayer}`,
    orientation: 'same-layer',
    canonicalFrom: null,
    canonicalTo: null,
  };
}

function sourceRelativePath(projectRoot, sourcePath) {
  return relative(projectRoot, sourcePath).replaceAll('\\', '/');
}

export function parseMarkdownSource({ relativePath, text, sourceKind = 'detail', registry = null, titleCell = 1, statusCell = null }) {
  const source = { path: relativePath, sourceKind, registry, titleCell, statusCell };
  const lines = String(text ?? '').split(/\r?\n/);
  const definitions = [];
  const lineRelations = [];
  const referenceClusters = [];
  const nativeSpecReferences = [];
  const delegations = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const cells = parseTableCells(line);
    const definitionId = firstDefinitionId(cells, line);
    const ids = extractIdTokens(line);
    if (definitionId) {
      const definition = {
        id: definitionId,
        layer: classifyId(definitionId),
        title: titleForDefinition({ cells, line, id: definitionId, source }),
        file: relativePath,
        line: lineNumber,
        sourceKind,
        registry,
        syntax: isHeading(line) ? 'heading' : cells ? 'table-row' : 'list-item',
        status: statusForDefinition(cells, source),
        testRefs: testRefsForLine(cells, line),
        evidence: line.trim(),
      };
      definitions.push(definition);
      const relationIds = ids.filter((id) => id !== definitionId);
      for (const target of relationIds) {
        lineRelations.push({
          from: definitionId,
          to: target,
          file: relativePath,
          line: lineNumber,
          sourceKind,
          registry,
          evidence: line.trim(),
        });
      }
    } else if (ids.length > 1) {
      const cluster = {
        ids,
        file: relativePath,
        line: lineNumber,
        sourceKind,
        registry,
        evidence: line.trim(),
      };
      referenceClusters.push(cluster);
      if (/new-naia-agent|agent-side|os-side|별 repo|delegat|위임/i.test(line)) {
        delegations.push({
          kind: 'delegation',
          ids,
          file: relativePath,
          line: lineNumber,
          summary: cleanMarkdown(line),
          evidence: line.trim(),
        });
      }
    }

    NATIVE_SPEC_RE.lastIndex = 0;
    for (const match of line.matchAll(NATIVE_SPEC_RE)) {
      nativeSpecReferences.push({
        path: match[0],
        file: relativePath,
        line: lineNumber,
        ownerId: definitionId,
        evidence: line.trim(),
      });
    }
  });

  return { source, lines, definitions, relations: lineRelations, referenceClusters, nativeSpecReferences, delegations };
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function groupByLayer(definitions) {
  const output = Object.fromEntries(LAYER_ORDER.map((layer) => [layer, 0]));
  for (const definition of definitions) output[definition.layer] = (output[definition.layer] || 0) + 1;
  return output;
}

function uniqueIdsByLayer(ids) {
  const output = Object.fromEntries(LAYER_ORDER.map((layer) => [layer, 0]));
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    output[classifyId(id)] = (output[classifyId(id)] || 0) + 1;
  }
  return output;
}

function relationTargets(relations, fromId, layer = null) {
  return relations
    .filter((relation) => relation.from === fromId && (!layer || classifyId(relation.to) === layer))
    .map((relation) => relation.to);
}

function unique(values) {
  return [...new Set(values)];
}

function statusGroups({ definitions, relations, entities }) {
  const featureTests = definitions
    .filter((definition) => definition.sourceKind === 'registry' && definition.registry === 'feature-tests' && /^TEST-F-(?:00[1-9]|01[0-7])$/.test(definition.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const canonicalEdges = relations.map((relation) => ({ ...relation, trace: canonicalizeRelation(relation.from, relation.to) }));
  const registryIds = new Set(definitions
    .filter((definition) => definition.sourceKind === 'registry')
    .map((definition) => definition.id));
  const groups = [];
  for (const testDefinition of featureTests) {
    const specs = unique(relationTargets(relations, testDefinition.id, 'feature-design'));
    const ucs = unique(specs.flatMap((spec) => relationTargets(relations, spec, 'use-case')));
    const scenarioIds = unique(canonicalEdges
      .filter((relation) => relation.trace.canonicalFrom && relation.trace.canonicalFrom === relation.from && classifyId(relation.from) === 'use-case' && classifyId(relation.to) === 'scenario-test' && ucs.includes(relation.from))
      .map((relation) => relation.to)
      .concat(canonicalEdges
        .filter((relation) => relation.trace.canonicalFrom && classifyId(relation.trace.canonicalFrom) === 'use-case' && classifyId(relation.trace.canonicalTo) === 'scenario-test' && ucs.includes(relation.trace.canonicalFrom))
        .map((relation) => relation.trace.canonicalTo)));
    const requirements = unique(canonicalEdges
      .filter((relation) => relation.trace.canonicalFrom && classifyId(relation.trace.canonicalFrom) !== 'use-case' && classifyId(relation.trace.canonicalTo) === 'use-case' && ucs.includes(relation.trace.canonicalTo))
      .map((relation) => relation.trace.canonicalFrom));
    const scenarioTestIds = unique(scenarioIds);
    groups.push({
      groupId: testDefinition.id.replace('TEST-F-', 'FEATURE-GROUP-'),
      testFId: testDefinition.id,
      status: testDefinition.status,
      title: testDefinition.title,
      specIds: specs,
      useCaseIds: ucs,
      requirementIds: requirements,
      scenarioTestIds,
      registryUseCaseIds: ucs.filter((id) => registryIds.has(id)),
      detailUseCaseIds: ucs.filter((id) => !registryIds.has(id)),
      registryRequirementIds: requirements.filter((id) => registryIds.has(id)),
      detailRequirementIds: requirements.filter((id) => !registryIds.has(id)),
      registryScenarioTestIds: scenarioTestIds.filter((id) => registryIds.has(id)),
      detailScenarioTestIds: scenarioTestIds.filter((id) => !registryIds.has(id)),
      source: { file: testDefinition.file, line: testDefinition.line },
      note: 'Registry feature-test group; this count is not a detailed QA-case total.',
    });
  }
  return groups;
}

export function buildCatalog({ projectRoot = DEFAULT_PROJECT_ROOT, sourceSpecs = DEFAULT_SOURCES, generatedAtUtc = new Date().toISOString() } = {}) {
  const allDefinitions = [];
  const allRelations = [];
  const allReferences = [];
  const allNativeSpecReferences = [];
  const allDelegations = [];
  const sourceInventory = [];
  const parsedSources = [];

  for (const spec of sourceSpecs) {
    const absolutePath = resolve(projectRoot, spec.path);
    if (!existsSync(absolutePath)) {
      sourceInventory.push({ path: spec.path, sourceKind: spec.sourceKind, registry: spec.registry, coverageNote: spec.coverageNote || null, exists: false });
      continue;
    }
    const text = readFileSync(absolutePath, 'utf8');
    const parsed = parseMarkdownSource({ ...spec, relativePath: spec.path, text });
    parsedSources.push(parsed);
    allDefinitions.push(...parsed.definitions);
    allRelations.push(...parsed.relations);
    allReferences.push(...parsed.referenceClusters);
    allNativeSpecReferences.push(...parsed.nativeSpecReferences);
    allDelegations.push(...parsed.delegations);
    const stat = statSync(absolutePath);
    sourceInventory.push({
      path: spec.path,
      sourceKind: spec.sourceKind,
      registry: spec.registry,
      coverageNote: spec.coverageNote || null,
      exists: true,
      bytes: stat.size,
      lines: parsed.lines.length,
      sha256: hashText(text),
      definitionCount: parsed.definitions.length,
      relationCount: parsed.relations.length,
      referenceClusterCount: parsed.referenceClusters.length,
    });
  }

  const entityMap = new Map();
  for (const definition of allDefinitions) {
    let entity = entityMap.get(definition.id);
    if (!entity) {
      entity = {
        id: definition.id,
        layer: definition.layer,
        definitions: [],
        sourceKinds: [],
        registries: [],
        title: definition.title,
      };
      entityMap.set(definition.id, entity);
    }
    entity.definitions.push(definition);
    if (!entity.sourceKinds.includes(definition.sourceKind)) entity.sourceKinds.push(definition.sourceKind);
    if (definition.registry && !entity.registries.includes(definition.registry)) entity.registries.push(definition.registry);
    if (!entity.title || entity.title === entity.id) entity.title = definition.title;
  }

  const relationMap = new Map();
  for (const relation of allRelations) {
    const enriched = {
      ...relation,
      sourceKnown: entityMap.has(relation.from),
      targetKnown: entityMap.has(relation.to),
      status: entityMap.has(relation.to) ? 'MAPPED' : 'UNMAPPED',
      trace: canonicalizeRelation(relation.from, relation.to),
    };
    relationMap.set(relationKey(enriched), enriched);
  }
  const relations = [...relationMap.values()];
  const references = allReferences.map((reference) => ({
    ...reference,
    status: reference.ids.every((id) => entityMap.has(id)) ? 'MAPPED' : 'UNMAPPED',
    knownIds: reference.ids.filter((id) => entityMap.has(id)),
    unknownIds: reference.ids.filter((id) => !entityMap.has(id)),
  }));

  const nativeSpecReferences = [];
  const nativeSeen = new Set();
  for (const reference of allNativeSpecReferences) {
    const key = `${reference.path}|${reference.file}|${reference.line}|${reference.ownerId || ''}`;
    if (!nativeSeen.has(key)) {
      nativeSeen.add(key);
      nativeSpecReferences.push(reference);
    }
  }

  const definitionsBySource = {};
  for (const definition of allDefinitions) {
    definitionsBySource[definition.file] = (definitionsBySource[definition.file] || 0) + 1;
  }
  const registryDefinitions = allDefinitions.filter((definition) => definition.sourceKind === 'registry');
  const allIds = allDefinitions.map((definition) => definition.id);
  const registryIds = registryDefinitions.map((definition) => definition.id);
  const unmappedRelations = relations.filter((relation) => relation.status === 'UNMAPPED');
  const unmappedReferences = references.filter((reference) => reference.status === 'UNMAPPED');
  const scenarioDefinitions = allDefinitions.filter((definition) => definition.layer === 'scenario-catalog');
  const scenarioCatalogEntries = scenarioDefinitions.map((definition) => {
    const mappings = relations
      .filter((relation) => relation.from === definition.id && classifyId(relation.to) === 'use-case')
      .map((relation) => ({
        id: relation.to,
        status: relation.status,
        file: relation.file,
        line: relation.line,
        evidence: relation.evidence,
      }));
    return {
      id: definition.id,
      title: definition.title,
      file: definition.file,
      line: definition.line,
      status: mappings.length && mappings.every((mapping) => mapping.status === 'MAPPED') ? 'MAPPED' : 'UNMAPPED',
      ucMappings: mappings,
      gap: mappings.length ? null : 'No explicit UC mapping on the scenario definition row.',
    };
  });
  const scenarioCatalogGaps = scenarioCatalogEntries.filter((entry) => entry.status === 'UNMAPPED');

  const catalog = {
    schemaVersion: SCHEMA_VERSION,
    generatedAtUtc,
    projectRoot: projectRoot,
    scope: {
      registrySources: sourceSpecs.filter((source) => source.sourceKind === 'registry').map((source) => source.path),
      detailSources: sourceSpecs.filter((source) => source.sourceKind !== 'registry').map((source) => source.path),
      statusGroupDefinition: 'TEST-F-001..TEST-F-017 from 05.features-tests/INDEX.md; registry groups are not detailed QA-case totals.',
      scenarioCatalogDefinition: 'S-prefixed scenario IDs from docs/user-scenarios.md are preserved as an independent catalog layer; their UC links are evidence and remain UNMAPPED when no selected-source definition resolves them.',
      unresolvedPolicy: 'References whose target has no definition in the selected sources remain UNMAPPED; no IDs are invented from narrative text.',
    },
    sourceInventory,
    totals: {
      uniqueEntities: entityMap.size,
      definitionOccurrences: allDefinitions.length,
      relationCount: relations.length,
      mappedRelationCount: relations.filter((relation) => relation.status === 'MAPPED').length,
      unmappedRelationCount: unmappedRelations.length,
      referenceClusterCount: references.length,
      unmappedReferenceClusterCount: unmappedReferences.length,
      uniqueEntitiesByLayer: uniqueIdsByLayer(allIds),
      definitionOccurrencesByLayer: groupByLayer(allDefinitions),
      registryUniqueEntitiesByLayer: uniqueIdsByLayer(registryIds),
      registryDefinitionOccurrences: registryDefinitions.length,
      definitionsBySource,
    },
    entities: [...entityMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    definitions: allDefinitions,
    relations,
    references,
    scenarioCatalog: {
      totalEntries: scenarioCatalogEntries.length,
      mappedEntries: scenarioCatalogEntries.filter((entry) => entry.status === 'MAPPED').length,
      unmappedEntries: scenarioCatalogGaps.length,
      entries: scenarioCatalogEntries,
      gaps: scenarioCatalogGaps,
    },
    unmapped: {
      relations: unmappedRelations,
      references: unmappedReferences,
    },
    nativeSpecReferences,
    delegations: uniqueDelegations(allDelegations),
    statusGroups: statusGroups({ definitions: allDefinitions, relations, entities: entityMap }),
    notes: [
      'SPEC entities come from the feature-design registry and are preserved as the feature-design layer; FR/FE/NFR are separate requirement layers.',
      'S-prefixed user-scenario originals (including S01..S71, S52b, and S-* rows such as S-INSTALL) are preserved in scenarioCatalog; an absent or unresolved UC mapping is a traceability gap, not an invented UC.',
      'TEST-S and TEST-F registry entries are traceability sources. Their names and files are not used as the total number of product QA cases.',
      'Agent-side feature delegation to new-naia-agent is retained as a delegation note rather than reported as an absent shell SPEC.',
    ],
  };
  return catalog;
}

function uniqueDelegations(delegations) {
  const seen = new Set();
  return delegations.filter((delegation) => {
    const key = `${delegation.file}|${delegation.line}|${delegation.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mdCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function countsTable(counts) {
  const rows = ['| Layer | Unique IDs | Definition occurrences |', '| --- | ---: | ---: |'];
  for (const layer of LAYER_ORDER) rows.push(`| ${layer} | ${counts.unique?.[layer] ?? 0} | ${counts.occurrences?.[layer] ?? 0} |`);
  return rows.join('\n');
}

export function renderMarkdown(catalog) {
  const lines = [];
  lines.push('# QA traceability source inventory');
  lines.push('');
  lines.push(`Generated at UTC: ${catalog.generatedAtUtc}`);
  lines.push('');
  lines.push('This artifact is a mechanically extracted relationship graph and gap inventory. The 17 feature-test registry groups are a source grouping, not a claim about the total number of detailed QA cases.');
  lines.push('');
  lines.push('## Schema');
  lines.push('');
  lines.push('- `definitions`: IDs defined by a table first cell or an ID-led heading, with source file and line.');
  lines.push('- `relations`: IDs appearing with a definition on the same row or heading; each target is `MAPPED` only when a definition exists in the selected sources.');
  lines.push('- `references`: multi-ID narrative lines without an ID definition; these remain evidence clusters rather than invented edges.');
  lines.push('- `scenarioCatalog`: independent `S01`/`S52b`/`S-*` scenario definitions from the detailed user-scenario source, with explicit UC mappings and gaps.');
  lines.push('- `statusGroups`: `TEST-F-001..017` registry groups linked to SPEC, UC, requirements, and TEST-S where explicit evidence exists.');
  lines.push('- `qa-detail` sources record detailed test coverage that is intentionally kept outside registry entity totals.');
  lines.push('');
  lines.push('## Source inventory');
  lines.push('');
  lines.push('| Source | Kind | Exists | Lines | Definitions | Relations | SHA-256 | Coverage note |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | --- | --- |');
  for (const source of catalog.sourceInventory) {
    lines.push(`| ${mdCell(source.path)} | ${mdCell(source.sourceKind)} | ${source.exists ? 'yes' : 'no'} | ${source.lines ?? ''} | ${source.definitionCount ?? ''} | ${source.relationCount ?? ''} | ${source.sha256 ? source.sha256.slice(0, 16) + '…' : ''} | ${mdCell(source.coverageNote || '')} |`);
  }
  lines.push('');
  lines.push('## Totals by hierarchy');
  lines.push('');
  lines.push(countsTable({ unique: catalog.totals.uniqueEntitiesByLayer, occurrences: catalog.totals.definitionOccurrencesByLayer }));
  lines.push('');
  lines.push(`Registry definitions: ${catalog.totals.registryDefinitionOccurrences}; unique entities: ${Object.values(catalog.totals.registryUniqueEntitiesByLayer).reduce((a, b) => a + b, 0)}.`);
  lines.push(`Relations: ${catalog.totals.relationCount} total, ${catalog.totals.mappedRelationCount} MAPPED, ${catalog.totals.unmappedRelationCount} UNMAPPED.`);
  lines.push('');
  lines.push('## Independent scenario catalog');
  lines.push('');
  lines.push(`Scenario entries: ${catalog.scenarioCatalog.totalEntries}; ${catalog.scenarioCatalog.mappedEntries} have only resolved UC mappings; ${catalog.scenarioCatalog.unmappedEntries} are UNMAPPED because no explicit/resolved UC mapping is present.`);
  lines.push('');
  if (!catalog.scenarioCatalog.entries.length) {
    lines.push('No independent S-prefixed scenario definition was found in the selected sources.');
  } else {
    lines.push('| Scenario ID | Title | UC mapping | Status | Source | Gap |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const entry of catalog.scenarioCatalog.entries) {
      const mappings = entry.ucMappings.map((mapping) => `${mapping.id} (${mapping.status})`).join(', ');
      lines.push(`| ${mdCell(entry.id)} | ${mdCell(entry.title)} | ${mdCell(mappings)} | ${entry.status} | ${mdCell(entry.file)}:${entry.line} | ${mdCell(entry.gap || '')} |`);
    }
  }
  lines.push('');
  lines.push('## Registry status groups');
  lines.push('');
  lines.push('| Group | Status | SPEC | Registry UC | Detail UC | Registry REQ | Detail REQ | Registry TEST-S | Detail TEST-S |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const group of catalog.statusGroups) {
    lines.push(`| ${mdCell(group.testFId)} | ${mdCell(group.status || '')} | ${mdCell(group.specIds.join(', '))} | ${mdCell(group.registryUseCaseIds.join(', '))} | ${mdCell(group.detailUseCaseIds.join(', '))} | ${mdCell(group.registryRequirementIds.join(', '))} | ${mdCell(group.detailRequirementIds.join(', '))} | ${mdCell(group.registryScenarioTestIds.join(', '))} | ${mdCell(group.detailScenarioTestIds.join(', '))} |`);
  }
  lines.push('');
  lines.push('The table above is the 17 registry grouping only. It must not be read as the product QA-case count.');
  lines.push('');
  lines.push('## Explicit registry relations');
  lines.push('');
  lines.push('| From | To | Trace pair | Status | Source | Line |');
  lines.push('| --- | --- | --- | --- | --- | ---: |');
  for (const relation of catalog.relations.filter((item) => item.sourceKind === 'registry')) {
    lines.push(`| ${mdCell(relation.from)} | ${mdCell(relation.to)} | ${mdCell(relation.trace.name)} (${relation.trace.orientation}) | ${relation.status} | ${mdCell(relation.file)} | ${relation.line} |`);
  }
  lines.push('');
  lines.push('## UNMAPPED gaps');
  lines.push('');
  const unmapped = catalog.unmapped.relations;
  if (!unmapped.length) lines.push('No unmapped relation targets in the selected source set.');
  else {
    lines.push('| From | Missing target | Source | Line |');
    lines.push('| --- | --- | --- | ---: |');
    for (const relation of unmapped) lines.push(`| ${mdCell(relation.from)} | ${mdCell(relation.to)} | ${mdCell(relation.file)} | ${relation.line} |`);
  }
  if (catalog.unmapped.references.length) {
    lines.push('');
    lines.push('Narrative reference clusters with missing definitions:');
    lines.push('');
    for (const reference of catalog.unmapped.references) lines.push(`- ${reference.file}:${reference.line}: ${reference.unknownIds.join(', ')} — ${mdCell(reference.evidence)}`);
  }
  lines.push('');
  lines.push('## Native and delegation evidence');
  lines.push('');
  if (catalog.nativeSpecReferences.length) {
    lines.push('| Native spec path | Owner ID | Source | Line |');
    lines.push('| --- | --- | --- | ---: |');
    for (const reference of catalog.nativeSpecReferences) lines.push(`| ${mdCell(reference.path)} | ${mdCell(reference.ownerId || '')} | ${mdCell(reference.file)} | ${reference.line} |`);
  } else {
    lines.push('No native e2e spec path was found in the selected documents.');
  }
  lines.push('');
  for (const delegation of catalog.delegations) lines.push(`- Delegation ${delegation.file}:${delegation.line}: ${mdCell(delegation.summary)}`);
  lines.push('');
  lines.push('Product-wide tests and GUI execution were not run by this parser task; only parser fixture semantics are validated.');
  lines.push('');
  return lines.join('\n');
}

export function writeCatalog({ projectRoot = DEFAULT_PROJECT_ROOT, jsonOut = '.agents/progress/qa-resume-20260907/qa-source-inventory-20260908.json', markdownOut = '.agents/progress/qa-resume-20260907/qa-source-inventory-20260908.md' } = {}) {
  const catalog = buildCatalog({ projectRoot });
  const jsonPath = resolve(projectRoot, jsonOut);
  const markdownPath = resolve(projectRoot, markdownOut);
  mkdirSync(dirname(jsonPath), { recursive: true });
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderMarkdown(catalog), 'utf8');
  return { catalog, jsonPath, markdownPath };
}

function cliArguments(argv) {
  const args = { projectRoot: DEFAULT_PROJECT_ROOT, jsonOut: undefined, markdownOut: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root') args.projectRoot = resolve(argv[++index]);
    else if (argument === '--json-out') args.jsonOut = argv[++index];
    else if (argument === '--markdown-out') args.markdownOut = argv[++index];
  }
  return args;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const args = cliArguments(process.argv.slice(2));
  const result = writeCatalog(args);
  const { catalog } = result;
  console.log(JSON.stringify({
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    generatedAtUtc: catalog.generatedAtUtc,
    uniqueEntities: catalog.totals.uniqueEntities,
    definitions: catalog.totals.definitionOccurrences,
    relations: catalog.totals.relationCount,
    mappedRelations: catalog.totals.mappedRelationCount,
    unmappedRelations: catalog.totals.unmappedRelationCount,
    statusGroups: catalog.statusGroups.length,
  }, null, 2));
}
