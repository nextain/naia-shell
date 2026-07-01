#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const requiredScores = [
  'identity',
  'silhouette',
  'proportion',
  'material',
  'face',
  'expression_motion',
  'mouth_motion',
  'rig_health',
  'app_render',
];

const views = ['front', 'side', 'back', 'threeQuarter'];
const requiredFrontRenderSlots = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'think',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
];

const thresholds = {
  identity: 4.0,
  silhouette: 4.0,
  proportion: 4.0,
  material: 3.8,
  face: 4.0,
  hair_variant: 4.0,
  expression_motion: 3.8,
  mouth_motion: 3.8,
  rig_health: 4.0,
  app_render: 4.0,
};

const severeRegressionFlags = new Set([
  'human_schoolgirl_like',
  'cat_props_on_human',
  'primitive_stack_visible',
  'mouth_static',
  'arms_too_high',
  'flattened_sheet',
  'overweight_proportion',
  'hair_color_missing',
  'render_view_incoherent',
  'app_render_blank',
  'detached_surface_elements',
  'side_view_attachment_failure',
  'hair_not_integrated',
  'surface_detail_not_embedded',
  'app_render_face_loss',
]);

function resolveEvidencePath(baseDir, evidencePath) {
  if (typeof evidencePath !== 'string' || evidencePath.trim().length === 0) {
    return null;
  }

  return resolve(baseDir, evidencePath);
}

function requireExistingFile(failures, baseDir, label, evidencePath) {
  const resolved = resolveEvidencePath(baseDir, evidencePath);
  if (!resolved) {
    failures.push(`${label} evidence path is required`);
    return;
  }

  if (!existsSync(resolved)) {
    failures.push(`${label} evidence file not found: ${evidencePath}`);
  }
}

function readReport(baseDir, reportPath, failures, index) {
  const resolved = resolveEvidencePath(baseDir, reportPath);
  if (!resolved || !existsSync(resolved)) {
    failures.push(`history.previous_reports[${index}] not found: ${reportPath}`);
    return null;
  }

  return JSON.parse(readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

function fileHash(baseDir, evidencePath) {
  const resolved = resolveEvidencePath(baseDir, evidencePath);
  if (!resolved || !existsSync(resolved)) return null;

  return createHash('sha256').update(readFileSync(resolved)).digest('hex');
}

function usage() {
  console.error('Usage: node packages/shell/scripts/naia-character-loop-report.mjs <loop-report.json>');
  process.exit(2);
}

const reportPath = process.argv[2];
if (!reportPath) usage();

const reportText = readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '');
const report = JSON.parse(reportText);
const reportDir = dirname(resolve(reportPath));
const failures = [];
const promotionBlockers = [];
const warnings = [];

if (!Number.isInteger(report.iteration) || report.iteration < 1) {
  failures.push('iteration must be a positive integer');
}

if (!['base', 'hair'].includes(report.variant)) {
  failures.push('variant must be "base" or "hair"');
}

if (!report.scores || typeof report.scores !== 'object') {
  failures.push('scores object is required');
} else {
  const scoreKeys = report.variant === 'hair'
    ? [...requiredScores, 'hair_variant']
    : requiredScores;

  for (const key of scoreKeys) {
    const value = report.scores[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) {
      failures.push(`scores.${key} must be a number from 0.0 to 5.0`);
      continue;
    }

    if (value < thresholds[key]) {
      promotionBlockers.push(`scores.${key}=${value} is below threshold ${thresholds[key]}`);
    }
  }

  if (report.variant === 'base' && 'hair_variant' in report.scores) {
    warnings.push('scores.hair_variant is ignored for base variant');
  }
}

const flags = Array.isArray(report.regression_flags) ? report.regression_flags : [];
if (!Array.isArray(report.regression_flags)) {
  failures.push('regression_flags must be an array');
}

const unknownFlags = flags.filter((flag) => !severeRegressionFlags.has(flag));
for (const flag of unknownFlags) {
  failures.push(`unknown regression flag: ${flag}`);
}

const severeFlags = flags.filter((flag) => severeRegressionFlags.has(flag));
for (const flag of severeFlags) {
  promotionBlockers.push(`severe regression flag present: ${flag}`);
}

if (report.history?.previous_reports !== undefined) {
  if (!Array.isArray(report.history.previous_reports)) {
    failures.push('history.previous_reports must be an array when present');
  } else {
    const previousReports = report.history.previous_reports
      .map((previousPath, index) => readReport(reportDir, previousPath, failures, index))
      .filter(Boolean);

    const previousByIteration = new Map(previousReports.map((previous) => [previous.iteration, previous]));
    const previousOne = previousByIteration.get(report.iteration - 1);
    const previousTwo = previousByIteration.get(report.iteration - 2);
    if (!previousOne) {
      warnings.push(`history gap: previous report for iteration ${report.iteration - 1} is missing`);
    }
    if (!previousTwo) {
      warnings.push(`history gap: previous report for iteration ${report.iteration - 2} is missing`);
    }

    for (const flag of severeRegressionFlags) {
      const currentHasFlag = severeFlags.includes(flag);
      const previousOneHasFlag = Array.isArray(previousOne?.regression_flags) && previousOne.regression_flags.includes(flag);
      const previousTwoHasFlag = Array.isArray(previousTwo?.regression_flags) && previousTwo.regression_flags.includes(flag);
      const consecutiveCount = [previousTwoHasFlag, previousOneHasFlag, currentHasFlag].filter(Boolean).length;
      if (consecutiveCount >= 3) {
        warnings.push(`stuck: severe regression flag repeated across ${consecutiveCount} consecutive reports: ${flag}`);
      }
      if (!currentHasFlag && previousOneHasFlag && previousTwoHasFlag) {
        warnings.push(`cleared severe regression flag after two consecutive reports; verify method changed: ${flag}`);
      }
    }
  }
}

if (!report.evidence || typeof report.evidence !== 'object') {
  failures.push('evidence object is required');
} else {
  requireExistingFile(failures, reportDir, 'character_sheet', report.evidence.character_sheet);

  if (report.evidence.model_source) {
    requireExistingFile(failures, reportDir, 'model_source', report.evidence.model_source);
  }

  if (report.evidence.vrm) {
    requireExistingFile(failures, reportDir, 'vrm', report.evidence.vrm);
  } else {
    promotionBlockers.push('vrm evidence path is required for promotion');
  }

  if (report.evidence.app_render) {
    requireExistingFile(failures, reportDir, 'app_render', report.evidence.app_render);
  } else {
    promotionBlockers.push('app_render evidence path is required for promotion');
  }

  if (!report.evidence.model_source && !report.evidence.vrm) {
    failures.push('either evidence.model_source or evidence.vrm is required');
  }

  const renders = report.evidence.renders;
  if (!renders || typeof renders !== 'object') {
    failures.push('evidence.renders object is required');
  } else {
    for (const view of views) {
      if (!renders[view] || typeof renders[view] !== 'object') {
        failures.push(`evidence.renders.${view} object is required`);
        continue;
      }
    }

    for (const slot of requiredFrontRenderSlots) {
      requireExistingFile(
        failures,
        reportDir,
        `evidence.renders.front.${slot}`,
        renders.front?.[slot],
      );
    }

    for (const view of views.filter((view) => view !== 'front')) {
      requireExistingFile(
        failures,
        reportDir,
        `evidence.renders.${view}.neutral`,
        renders[view]?.neutral,
      );
    }

    const frontNeutralHash = fileHash(reportDir, renders.front?.neutral);
    if (frontNeutralHash) {
      for (const slot of requiredFrontRenderSlots.filter((slot) => slot !== 'neutral')) {
        const slotHash = fileHash(reportDir, renders.front?.[slot]);
        if (slotHash && slotHash === frontNeutralHash) {
          promotionBlockers.push(`evidence.renders.front.${slot} is visually identical to front.neutral`);
        }
      }
    }
  }
}

if (!['revise', 'promote'].includes(report.decision)) {
  failures.push('decision must be "revise" or "promote"');
}

if (report.decision === 'promote' && (failures.length > 0 || promotionBlockers.length > 0)) {
  failures.push('decision cannot be "promote" while gates fail');
}

if (!Array.isArray(report.next_actions) || report.next_actions.length === 0) {
  if (report.decision === 'revise') {
    failures.push('next_actions must be non-empty when decision is "revise"');
  } else {
    warnings.push('next_actions is empty for promoted report');
  }
}

const verdict = failures.length > 0
  ? 'INVALID'
  : promotionBlockers.length > 0
    ? 'VALID_REVISE'
    : 'PROMOTABLE';

console.log(JSON.stringify({
  verdict,
  report: reportPath,
  iteration: report.iteration,
  variant: report.variant,
  failures,
  promotion_blockers: promotionBlockers,
  warnings,
}, null, 2));

process.exit(failures.length === 0 ? 0 : 1);
