import { validateGenerationResult } from "./generation-contract.js";
import { validateSpeechAtlasIndex } from "./speech-atlas-index.js";

export const GENERATION_RECEIPT_PATH = "speech/generation-result.json";

export function speechMotionFromGenerationResult(result) {
  const validation = validateGenerationResult(result);
  if (!validation.ok) throw new TypeError(`invalid GenerationResult: ${validation.errors.join("; ")}`);
  const byRole = Object.fromEntries(result.assets.map((asset) => [asset.role, asset.path]));
  const representation = result.provenance?.representation || "factorized-difference-layer";
  const motion = {
    version: "1",
    representation,
    inventory_version: result.provenance.inventory_version,
    inventory: [...result.provenance.inventory],
    neutral_head: byRole.neutral_head,
    atlas: byRole.speech_atlas,
    atlas_index: byRole.speech_atlas_index,
    validation_report: byRole.validation_report,
    quality_report: byRole.quality_report,
    provenance: GENERATION_RECEIPT_PATH,
  };
  if (representation === "whole-head-layer") {
    motion.region = [...result.provenance.region];
  }
  return motion;
}

export function speechBundlePaths(speechMotion) {
  if (!speechMotion) return [];
  return [
    speechMotion.neutral_head,
    speechMotion.atlas,
    speechMotion.atlas_index,
    speechMotion.validation_report,
    speechMotion.quality_report,
    speechMotion.provenance,
  ].filter(Boolean);
}

async function blobSha256(blob) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifySpeechAtlasAssets(atlasBlob, atlasIndex) {
  if (!(atlasBlob instanceof Blob)) throw new TypeError("atlas must be a Blob");
  const validation = validateSpeechAtlasIndex(atlasIndex, atlasBlob.size);
  if (!validation.ok) throw new TypeError(`invalid speech atlas index: ${validation.errors.join("; ")}`);
  for (const [key, entry] of Object.entries(atlasIndex.entries)) {
    const slice = atlasBlob.slice(entry.offset, entry.offset + entry.length);
    if (await blobSha256(slice) !== entry.sha256) throw new Error(`speech atlas slice hash mismatch: ${key}`);
  }
  return true;
}

export async function verifySpeechMotionBundle(speechMotion, assets) {
  if (!speechMotion || typeof speechMotion !== "object") throw new TypeError("speech_motion is required");
  if (!assets || typeof assets.get !== "function") throw new TypeError("bundle asset map is required");
  const receiptBlob = assets.get(speechMotion.provenance);
  if (!(receiptBlob instanceof Blob)) throw new Error("generation receipt is missing");
  let result;
  try { result = JSON.parse(await receiptBlob.text()); }
  catch (error) { throw new TypeError("generation receipt is invalid", { cause: error }); }
  const expected = speechMotionFromGenerationResult(result);
  for (const field of [
    "version", "representation", "inventory_version", "neutral_head", "atlas", "atlas_index",
    "validation_report", "quality_report", "provenance",
  ]) {
    if (speechMotion[field] !== expected[field]) throw new Error(`speech_motion ${field} is not receipt-bound`);
  }
  if (expected.representation === "whole-head-layer") {
    if (!Array.isArray(speechMotion.region)
        || speechMotion.region.length !== expected.region.length
        || speechMotion.region.some((val, index) => val !== expected.region[index])) {
      throw new Error("speech_motion region is not receipt-bound");
    }
  }
  if (!Array.isArray(speechMotion.inventory)
      || speechMotion.inventory.length !== expected.inventory.length
      || speechMotion.inventory.some((unit, index) => unit !== expected.inventory[index]))
    throw new Error("speech_motion inventory is not receipt-bound");
  for (const asset of result.assets) {
    const blob = assets.get(asset.path);
    if (!(blob instanceof Blob) || blob.size !== asset.bytes)
      throw new Error(`generated asset size mismatch: ${asset.path}`);
    if (await blobSha256(blob) !== asset.sha256)
      throw new Error(`generated asset hash mismatch: ${asset.path}`);
  }
  const atlasBlob = assets.get(expected.atlas);
  const atlasIndex = JSON.parse(await assets.get(expected.atlas_index).text());
  await verifySpeechAtlasAssets(atlasBlob, atlasIndex);
  return { result, atlasBlob, atlasIndex };
}
