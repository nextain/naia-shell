import { SPEECH_UNITS } from "./speech-plan.js";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^(src|job)_[A-Za-z0-9]{12,64}$/;
const REPRESENTATIONS = new Set(["factorized-difference-layer", "whole-head-layer"]);
const REQUIRED_ROLES = new Set([
  "neutral_head",
  "speech_atlas",
  "speech_atlas_index",
  "validation_report",
  "quality_report",
]);
const QUALITY_SECTIONS = ["sync", "continuity", "naturalness", "performance", "bundle"];

function rejectUnknown(object, allowed, where, fail) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail(`${where}.${key} is not allowed`);
}

function relativeBundlePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

export function validateGenerationJob(job) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!job || typeof job !== "object" || Array.isArray(job))
    return { ok: false, errors: ["generation job must be an object"] };
  rejectUnknown(job, new Set(["version", "source_asset_id", "representation", "inventory_version"]), "job", fail);
  if (job.version !== "1") fail('version must be "1"');
  if (!OPAQUE_ID.test(job.source_asset_id || "") || !job.source_asset_id.startsWith("src_"))
    fail("source_asset_id must be an opaque src_ identifier");
  if (!REPRESENTATIONS.has(job.representation)) fail("unsupported representation");
  if (job.inventory_version !== "1.0.0")
    fail("inventory_version must be 1.0.0");

  const forbidden = ["source_image_base64", "source_url", "source_path", "source_image", "image"];
  for (const field of forbidden) if (field in job) fail(`${field} must not cross the public contract`);
  if (typeof job.source_asset_id === "string" && /[:/\\]/.test(job.source_asset_id))
    fail("source_asset_id must not contain a URL or path");
  return { ok: errors.length === 0, errors };
}

// Speech asset total (alpha-adk D25 shared definition): the byte sum of the five speech fragment files
// that manifest.speech_motion points to (neutral_head, atlas, atlas_index, validation_report, quality_report),
// which is the set the receipt assets[] lists. The receipt itself and natural-eu side files are not counted.
// The gateway (packaging, upload check, status check) and the studio web loader count the same set.
export const SPEECH_ASSET_MAX_BYTES = 160 * 1024 * 1024;

export function speechAssetTotalBytes(result) {
  if (!result || !Array.isArray(result.assets)) return 0;
  let total = 0;
  for (const asset of result.assets) {
    if (asset && typeof asset === "object" && Number.isSafeInteger(asset.bytes) && asset.bytes > 0) total += asset.bytes;
  }
  return total;
}

export function validateGenerationResult(result) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!result || typeof result !== "object" || Array.isArray(result))
    return { ok: false, errors: ["generation result must be an object"] };
  rejectUnknown(result, new Set(["version", "job_id", "assets", "provenance", "quality", "source_deleted_at", "source_retention"]), "result", fail);
  if (result.version !== "1") fail('version must be "1"');
  if (!OPAQUE_ID.test(result.job_id || "") || !result.job_id.startsWith("job_"))
    fail("job_id must be an opaque job_ identifier");

  const seenRoles = new Set();
  if (!Array.isArray(result.assets) || !result.assets.length) fail("assets must be non-empty");
  else for (const [index, asset] of result.assets.entries()) {
    if (!asset || typeof asset !== "object") {
      fail(`assets[${index}] must be an object`);
      continue;
    }
    rejectUnknown(asset, new Set(["role", "path", "sha256", "bytes"]), `assets[${index}]`, fail);
    if (!REQUIRED_ROLES.has(asset.role)) fail(`assets[${index}].role is unsupported`);
    if (seenRoles.has(asset.role)) fail(`assets[${index}].role is duplicated`);
    seenRoles.add(asset.role);
    if (!relativeBundlePath(asset.path)) fail(`assets[${index}].path must stay inside the bundle`);
    if (!SHA256.test(asset.sha256 || "")) fail(`assets[${index}].sha256 is invalid`);
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) fail(`assets[${index}].bytes must be positive`);
  }
  for (const role of REQUIRED_ROLES) if (!seenRoles.has(role)) fail(`asset role ${role} is required`);
  if (speechAssetTotalBytes(result) > SPEECH_ASSET_MAX_BYTES) fail("speech assets exceed the 160 MiB speech asset limit");

  const assetsByRole = new Map((result.assets || []).map((asset) => [asset?.role, asset]));

  const provenance = result.provenance;
  let representation = "factorized-difference-layer";
  if (!provenance || typeof provenance !== "object") fail("provenance is required");
  else {
    // alpha local patch (naia.land studio, 2026-10-10): allow the provenance keys the canonical
    // speech-set generator records. Allowed only; their values are not interpreted here.
    rejectUnknown(provenance, new Set(["generator", "input_sha256", "settings_sha256", "inventory_version", "inventory", "validation", "representation", "region", "generator_commit", "anchor_frame_index", "natural_eu_sha256", "e_u_source", "residual_source", "anchor_background_rgb", "face_guide", "face_guide_policy", "silhouette_leak", "silhouette_leak_threshold", "anchor_source", "mouth_calibration_scale"]), "provenance", fail);
    rejectUnknown(provenance.generator, new Set(["kind", "version"]), "provenance.generator", fail);
    rejectUnknown(provenance.validation, new Set(["status", "report_sha256"]), "provenance.validation", fail);
    if (provenance.anchor_source !== undefined) {
      const anchorSource = provenance.anchor_source;
      if (!anchorSource || typeof anchorSource !== "object" || Array.isArray(anchorSource)) {
        fail("provenance.anchor_source must be an object");
      } else {
        rejectUnknown(anchorSource, new Set(["asset_id", "sha256", "uri"]), "provenance.anchor_source", fail);
        if (typeof anchorSource.asset_id !== "string" || !anchorSource.asset_id.trim())
          fail("provenance.anchor_source.asset_id is required");
        if (!SHA256.test(anchorSource.sha256 || ""))
          fail("provenance.anchor_source.sha256 is invalid");
        if (typeof anchorSource.uri !== "string" || !anchorSource.uri.trim())
          fail("provenance.anchor_source.uri is required");
      }
    }
    if (provenance.mouth_calibration_scale !== undefined
      && (typeof provenance.mouth_calibration_scale !== "number"
        || !Number.isFinite(provenance.mouth_calibration_scale)
        || provenance.mouth_calibration_scale <= 0)) {
      fail("provenance.mouth_calibration_scale must be a positive finite number");
    }
    if (provenance.representation !== undefined) {
      if (!REPRESENTATIONS.has(provenance.representation)) {
        fail("provenance.representation is unsupported");
      } else {
        representation = provenance.representation;
      }
    }
    if (provenance.region !== undefined) {
      if (!Array.isArray(provenance.region) || provenance.region.length !== 4 || provenance.region.some((v) => !Number.isSafeInteger(v))) {
        fail("provenance.region must be four integers [x,y,w,h]");
      }
    }
    if (representation === "whole-head-layer") {
      if (!provenance.region) {
        fail("provenance.region is required for whole-head-layer");
      }
    }
    if (typeof provenance.generator?.kind !== "string" || !provenance.generator.kind)
      fail("provenance.generator.kind is required");
    if (typeof provenance.generator?.version !== "string" || !provenance.generator.version)
      fail("provenance.generator.version is required");
    for (const field of ["input_sha256", "settings_sha256"])
      if (!SHA256.test(provenance[field] || "")) fail(`provenance.${field} is invalid`);
    if (provenance.inventory_version !== "1.0.0")
      fail("provenance.inventory_version is invalid");
    if (!Array.isArray(provenance.inventory)
      || provenance.inventory.length !== SPEECH_UNITS.length
      || provenance.inventory.some((unit, index) => unit !== SPEECH_UNITS[index]))
      fail("provenance.inventory must equal the frozen inventory in order");
    if (provenance.validation?.status !== "passed") fail("provenance.validation must be passed");
    if (!SHA256.test(provenance.validation?.report_sha256 || ""))
      fail("provenance.validation.report_sha256 is invalid");
    if (assetsByRole.get("validation_report")?.sha256 !== provenance.validation?.report_sha256)
      fail("validation report asset is not bound to provenance.validation.report_sha256");
  }

  if (!result.quality || typeof result.quality !== "object") fail("quality is required");
  else {
    rejectUnknown(result.quality, new Set(["report_sha256", ...QUALITY_SECTIONS]), "quality", fail);
    if (!SHA256.test(result.quality.report_sha256 || "")) fail("quality.report_sha256 is invalid");
    if (assetsByRole.get("quality_report")?.sha256 !== result.quality.report_sha256)
      fail("quality report asset is not bound to quality.report_sha256");
    for (const section of QUALITY_SECTIONS) {
      rejectUnknown(result.quality[section], new Set(["status"]), `quality.${section}`, fail);
      const status = result.quality[section]?.status;
      if (representation === "whole-head-layer") {
        if (status !== "screened" && status !== "not_evaluated") {
          fail(`quality.${section}.status must be "screened" or "not_evaluated" for whole-head-layer`);
        }
      } else {
        if (status !== "passed") fail(`quality.${section} must be passed`);
      }
    }
  }

  if (representation === "whole-head-layer" && result.source_deleted_at === null && result.source_retention === "local-operator-file") {
    // Permitted local operator retention exception for whole-head-layer
  } else {
    if (result.source_retention !== undefined) {
      fail('source_retention is not allowed for this representation or configuration');
    }
    const deletedAt = typeof result.source_deleted_at === "string" ? Date.parse(result.source_deleted_at) : NaN;
    if (!Number.isFinite(deletedAt) || new Date(deletedAt).toISOString() !== result.source_deleted_at)
      fail("source_deleted_at must be an ISO timestamp");
  }

  return { ok: errors.length === 0, errors };
}
