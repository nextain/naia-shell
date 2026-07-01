# Issue #361 Naia Character Loop Framework (2026-06-25)

## Goal

Build Naia avatar production as an iterative loop, not as a one-shot VRM export.
The acceptance target is visual identity convergence against the canonical Naia
character sheet plus technical VRM 1.0 compatibility in `naia-os`.

Current `Naia.vrm` is treated as a functional prototype only. It is not a final
character asset.

## Source Of Truth

Reference inputs:

- Canonical image: `https://naia.nextain.io/naia-character.png`
- Product page: `https://naia.nextain.io/ko/naia`
- Persona doc: `D:\alpha-adk\data-company\nextain-docs\05. 디자인\naia-persona.md`
- Generated model sheet candidates under `packages/shell/public/avatars/`

The production source of truth should become a Blender file, not the exported
VRM:

- `Naia-Base.blend`: base mascot body
- `Naia-Hair.blend`: hair-added variant
- `exports/Naia-Base.vrm`
- `exports/Naia.vrm`
- `renders/{variant}/{view}/{expression}.png`
- `reports/loop-{iteration}.json`

## Positive Identity Targets

The evaluator should score positive Naia identity, not merely reject bad
examples.

Core visual targets:

- translucent jelly-like mascot body
- cat-ear silhouette integrated into the body shape
- triangular crown or symbol above the head
- cyan and blue glow palette
- internal circuit or digital particle pattern
- minimal face
- compact mascot proportions
- clear Naia OS symbolic identity

Variant targets:

- base variant has no hair
- hair variant keeps the same body identity and adds coherent cyan/teal hair
- hair color must be present in every hair-view sheet and every 3D render

## Regression Guards

These are not primary pass criteria. They exist only to prevent known failed
directions from re-entering the loop.

- `human_schoolgirl_like`: asset reads as a humanoid student character
- `cat_props_on_human`: cat ears or ornaments are attached to a human base
- `primitive_stack_visible`: visible simple spheres/capsules/cubes dominate
- `mouth_static`: lip sync expressions exist but do not change rendered mouth
- `arms_too_high`: arms appear attached to the head or ear area
- `flattened_sheet`: character sheet loses the original rounded volume
- `overweight_proportion`: body becomes wider/fatter than the reference
- `hair_color_missing`: hair variant lacks cyan/teal hair color
- `render_view_incoherent`: multi-view render has detached or inconsistent parts
- `app_render_blank`: app capture produced a blank or context-lost render

## Loop

Each iteration follows this sequence:

1. Generate or revise the character sheet.
2. Update the Blender source mesh, materials, rig, and shape keys.
3. Render fixed comparison views from Blender.
4. Compare character sheet crops against 3D renders.
5. Produce a loop report with scores and regression flags.
6. Revise the source asset based on the lowest scoring dimensions.
7. Export VRM only after visual identity gates pass.
8. Validate the exported VRM inside `naia-os`.

The loop should never promote an asset because it only loads successfully.

## Render Set

For each variant:

- Views: `front`, `side`, `back`, `threeQuarter`
- Expressions: `neutral`, `happy`, `angry`, `sad`, `relaxed`, `surprised`, `think`
- Lip sync: `aa`, `ih`, `ou`, `ee`, `oh`
- Blink: `blink`, `blinkLeft`, `blinkRight`

Each render should use the same camera focal length, orthographic scale, light
setup, transparent background, and image size.

## Scoring

Scores are `0.0` to `5.0`.

Promotion thresholds:

- `identity >= 4.0`
- `silhouette >= 4.0`
- `proportion >= 4.0`
- `material >= 3.8`
- `face >= 4.0`
- `hair_variant >= 4.0` for the hair variant
- `expression_motion >= 3.8`
- `mouth_motion >= 3.8`
- `rig_health >= 4.0`
- `app_render >= 4.0`
- no severe regression flag

Suggested score dimensions:

- `identity`: does it read as Naia
- `silhouette`: outline match across fixed views
- `proportion`: head/body/ear/arm/crown placement
- `material`: translucent body, glow, internal patterns
- `face`: minimal face and readable expression change
- `hair_variant`: hair shape and cyan/teal color consistency
- `expression_motion`: visible emotion shape changes
- `mouth_motion`: visible lip sync shape changes
- `rig_health`: humanoid rig, VRMA compatibility, spring bone, lookAt
- `app_render`: loads and renders correctly in `naia-os`

Example loop report:

```json
{
  "iteration": 3,
  "variant": "hair",
  "evidence": {
    "character_sheet": "tmp/naia-character-loop/iter-003/sheet-hair.png",
    "model_source": "tmp/naia-character-loop/iter-003/Naia-Hair.blend",
    "vrm": "tmp/naia-character-loop/iter-003/Naia.vrm",
    "app_render": "tmp/naia-character-loop/iter-003/app-render.png",
    "renders": {
      "front": {
        "neutral": "tmp/naia-character-loop/iter-003/renders/front-neutral.png",
        "happy": "tmp/naia-character-loop/iter-003/renders/front-happy.png",
        "angry": "tmp/naia-character-loop/iter-003/renders/front-angry.png",
        "sad": "tmp/naia-character-loop/iter-003/renders/front-sad.png",
        "relaxed": "tmp/naia-character-loop/iter-003/renders/front-relaxed.png",
        "surprised": "tmp/naia-character-loop/iter-003/renders/front-surprised.png",
        "think": "tmp/naia-character-loop/iter-003/renders/front-think.png",
        "aa": "tmp/naia-character-loop/iter-003/renders/front-aa.png",
        "ih": "tmp/naia-character-loop/iter-003/renders/front-ih.png",
        "ou": "tmp/naia-character-loop/iter-003/renders/front-ou.png",
        "ee": "tmp/naia-character-loop/iter-003/renders/front-ee.png",
        "oh": "tmp/naia-character-loop/iter-003/renders/front-oh.png",
        "blink": "tmp/naia-character-loop/iter-003/renders/front-blink.png",
        "blinkLeft": "tmp/naia-character-loop/iter-003/renders/front-blinkLeft.png",
        "blinkRight": "tmp/naia-character-loop/iter-003/renders/front-blinkRight.png"
      },
      "side": {
        "neutral": "tmp/naia-character-loop/iter-003/renders/side-neutral.png"
      },
      "back": {
        "neutral": "tmp/naia-character-loop/iter-003/renders/back-neutral.png"
      },
      "threeQuarter": {
        "neutral": "tmp/naia-character-loop/iter-003/renders/threeQuarter-neutral.png"
      }
    }
  },
  "scores": {
    "identity": 4.1,
    "silhouette": 3.7,
    "proportion": 3.4,
    "material": 4.0,
    "face": 4.2,
    "hair_variant": 3.1,
    "expression_motion": 3.0,
    "mouth_motion": 1.2,
    "rig_health": 4.0,
    "app_render": 4.0
  },
  "regression_flags": [
    "arms_too_high",
    "mouth_static"
  ],
  "decision": "revise",
  "next_actions": [
    "lower arm anchors away from head silhouette",
    "add real mouth shape keys for aa/ih/ou/ee/oh",
    "restore cyan hair material on all hair locks"
  ]
}
```

## Automation Plan

Short term:

- Keep the current procedural VRM as a prototype only.
- Store sheet-to-render review reports as JSON.
- Require evidence paths in each loop report before any promotion decision.
- Use Claude/Codex cross review on each loop report before promoting an asset.
- Add app render screenshots from Playwright as evidence.
- Validate reports with
  `node packages/shell/scripts/naia-character-loop-report.mjs <loop-report.json>`.

Mid term:

- Use Blender Python to batch render every required view and expression.
- Use an image evaluator to compare sheet crops and render crops.
- Fail the loop if visual identity scores regress from the previous iteration.
- Keep per-iteration artifacts under `tmp/naia-character-loop/` until a final
  asset is promoted into `packages/shell/public/avatars/`.

Final promotion:

- Export `Naia-Base.vrm` and `Naia.vrm` from the Blender source.
- Generate matching `.webp` thumbnails.
- Run static VRM validation for VRM 1.0 metadata, expressions, humanoid bones,
  lookAt, spring bone, and custom `think`.
- Run `pnpm -C packages/shell build`.
- Run `naia-os` render validation and compare screenshots with the accepted
  model sheet.

The loop report gate is not a substitute for the final static VRM validator.
It only blocks obvious false success by requiring evidence files and required
render slots before the score threshold can be accepted.

The report gate has two layers:

- structural validity: report fields, known regression flags, finite scores, and
  sheet plus render evidence files are present
- promotion readiness: thresholds pass and no known severe regression flag is
  present; VRM and app render evidence are present

A `revise` report can be structurally valid while still not promotable. A
`promote` report must satisfy both layers.

The loop should also detect process stagnation. If the same severe regression
flag appears across three consecutive previous reports, the current report is
still structurally valid but must show a `stuck` warning. That warning means the
next iteration must change production method, not only tweak numeric positions.

## Review Policy

Cross review should evaluate the loop report and rendered evidence, not only the
source files.

Claude review lens:

- Is the asset converging toward the canonical Naia design?
- Are the reported failures specific enough to drive the next iteration?
- Are negative guards being used only as regression checks?
- Are technical VRM requirements still covered?

Codex review lens:

- Are artifacts named and stored consistently?
- Are validation gates reproducible?
- Does the loop prevent false success from a load-only VRM check?
- Is the next action list concrete enough to implement?

## Cross Review Result

Claude review was run against this framework and the report gate script.

- Round 1 found that self-reported scores could pass without evidence files.
- Round 2 found that valid `revise` reports were being treated like failed
  promotion attempts.
- Round 3 found no material blocker after separating structural validity from
  promotion readiness; one LOW documentation mismatch was fixed by adding the
  `app_render >= 4.0` threshold above.

## Current Loop Status

Latest reviewed iterations:

- `iter-013` hair variant: structurally valid, not promotable. Cross review
  calibrated identity, silhouette, face, and hair scores downward because the
  side view exposes detached face, hair, and surface elements.
- `iter-014` hair variant: structurally valid, not promotable. Removing the
  headband-like hair cap improved the front view, but side-view attachment
  failures remained.
- `iter-015-base` base variant: structurally valid, not promotable. Hair was
  deliberately disabled to focus on the canonical Naia mascot shell first.
- `iter-016-base` base variant: structurally valid, not promotable. Circuit
  details were moved inward and the loop cleared the `surface_detail_not_embedded`
  warning, but face attachment, primitive construction, rig health, and app
  render remain blockers.
- `iter-017-base` base variant: structurally valid, rejected experiment.
  Shrinkwrapping face meshes to the shell reduced some side-view gap but damaged
  the minimal eye shapes, so `iter-016-base` remains the better base candidate.
- `iter-018-base` base variant: structurally valid, not promotable. Head-surface
  coordinate placement reduced some side gap but deformed the eyes and increased
  back-view face bleed.
- `iter-019-base` base variant: structurally valid, not promotable. Front-facing
  decal planes reduced back-view face bleed, but the eye shape still drifted.
- `iter-020-base` base variant: structurally valid, not promotable. Decal offset
  tuning restored a cleaner minimal front face while keeping reduced back-view
  bleed. It is the current best base visual candidate.
- Cross review confirmed `iter-020-base` is only a marginal improvement over
  `iter-016-base`. Face micro-adjustments should stop; remaining progress must
  come from a shell/material pass and app-render repair.
- `iter-021-base` base variant: structurally valid, not promotable. VRM export
  plus SwiftShader app render now preserves eyes and mouth after disabling
  backface culling on the face decal material. It is the current best
  app-rendered base candidate, but material, shell quality, side-view attachment,
  and rig warnings remain below threshold.
- `iter-022-base` base variant: structurally valid, not promotable. Compactness
  and app-render readability improved slightly, but cross review found material
  drift toward opaque glossy plastic/porcelain and circuit details still read as
  surface decals rather than internal patterns.
- `iter-023-base` base variant: structurally valid, not promotable. Body
  translucency was partially restored, but app-render face contrast dropped and
  circuit details still read as line meshes rather than embedded/internal
  patterns.
- `iter-024-base` base variant: structurally valid, not promotable. Face material
  tuning improved Blender front render, but app render stayed close to
  `iter-023`, so exported VRM material parity is likely the next bottleneck.
- `iter-025-base` material patch: structurally valid, not promotable. Direct
  VRM/GLB material patches (`balanced`, `contrast`, `jelly`) showed that body
  translucency can be tuned post-export, but face contrast remains weak in app
  render. Material patching alone is not enough.
- `iter-026-base` base variant: structurally valid, not promotable. Moving face
  decals farther forward improved the Blender front render, but app render did
  not materially improve. This closed the material-only path and confirmed the
  need to change exported geometry/expression treatment.
- `iter-027-base` base variant: structurally valid, not promotable. Face
  readability improved, but the cyan face panel overpowered the jelly material
  and app-render mouth captures still behaved like a static mouth.
- `iter-028-base` base variant: structurally valid, not promotable. Removing the
  static exported mouth made lip motion visible in app render for the first time,
  but the mouth shape-key mesh rendered as a rectangular plate.
- `iter-029-base` base variant: structurally valid, not promotable. Replacing the
  rectangular mouth with an oval fan mesh preserved visible app lip motion while
  returning to a mascot-like minimal mouth. This is the current mouth/expression
  baseline, not a final character candidate.
- `iter-030-base` base variant: structurally valid, not promotable. A VRM JSON
  post-export humanoid patch corrected the left/right bone mappings while
  preserving app render and visible mouth expression behavior. Rig health
  improved, but visual shell quality remains below threshold.
- `iter-031-base` base variant: structurally valid, not promotable. A continuous
  organic body shell improved head/body transition in Blender, but app render
  exposed severe wing-like arm drift.
- `iter-032-base` base variant: structurally valid, not promotable. Smaller
  remeshed arms reduced the wing drift only slightly; the method still mixed arm
  silhouette with body-shell deformation.
- `iter-033-base` base variant: structurally valid, not promotable. Separating
  arms from the body remesh fixed the Blender sheet but not the app render,
  proving that the remaining drift was skinning-weight related.
- `iter-034-base` base variant: structurally valid, not promotable. Compact
  vertical arm capsules looked correct in Blender, but app render still pulled
  body/arm geometry sideways.
- `iter-035-base` base variant: structurally valid, not promotable. Export
  weighting was patched so the continuous body shell no longer binds to arm
  bones. This cleared the body-as-wings app drift, but the arm meshes floated
  outward because they still followed arm bones.
- `iter-036-base` base variant: structurally valid, not promotable. Static mascot
  arm meshes are now chest-bound while humanoid bones remain present and JSON
  corrected. App render keeps visible mouth motion and stable arms. This is the
  first stable app-rendered base candidate after the arm/weight drift fix.
- `iter-037-base` base variant: structurally valid, not promotable. Transparency
  improved, but app render exposed a new detached circuit trace protruding
  outside the body. Rejected despite preserved mouth motion.
- `iter-038-base` base variant: structurally valid, not promotable. Removed the
  detached side trace and restored app-render stability, but the remaining long
  circuit line still read as a surface sticker.
- `iter-039-base` base variant: structurally valid, not promotable. Short
  internal traces reduced the surface-line drift, but the digital pattern became
  too sparse and weakened Naia OS identity.
- `iter-040-base` base variant: structurally valid, not promotable. Added
  internal hologram cores and denser short traces. Naia OS identity improved,
  but the cores read partly like oval surface patches.
- `iter-041-base` base variant: structurally valid, not promotable. Reduced face
  panel and core opacity while preserving circuit density, app render stability,
  and visible mouth motion. This is the current best app-rendered base candidate.
- `iter-042-base` base variant: structurally valid, not promotable. Further
  reduced the central face blob and kept app-scale torso motif readability.
  VRM inspection passes for VRM 1.0, required expression binds, think, blink,
  lip-sync presets, humanoid bones, springBone, and lookAt. This is the current
  best app-rendered base candidate, but surface detail still reads too much like
  surface-aligned linework.
- `iter-043-base` base variant: structurally valid, not promotable. Added
  depth-layered rectangular data shards. Side-view depth improved, but app render
  read the shards as square pixel decals, so the method is rejected.
- `iter-044-base` base variant: structurally valid, not promotable. Replaced
  rectangular shards with small internal spark nodes and short segments. This
  improved app-scale internal digital identity without the chip regression.
- `iter-045-base` base variant: structurally valid, not promotable. Kept the
  internal spark motif, narrowed head/body proportions, and added a shallow
  two-layer crown. App render remains stable and VRM inspection passes. This is
  the current best app-rendered base candidate, but face/mouth and embedded
  detail still miss promotion.
- `iter-046-base` base variant: structurally valid, not promotable. Reduced the
  AA mouth blob while preserving visible lip-sync differences, and added crown
  cross-diagonal edges for a partial side-view improvement. This is the current
  best app-rendered base candidate. Remaining blockers are now mostly final
  silhouette/proportion tuning and embedded-detail depth.

Current active production path:

- Continue the base variant first.
- Use `iter-050-base` as the promoted base candidate.
- Use `iter-036-base` as the first stable arm/weight baseline after app-render
  wing drift was fixed.
- Use `iter-030-base` as the first rig-corrected technical baseline.
- Use `iter-029-base` as the current best mouth/expression geometry baseline.
- Use `iter-022-base` only as historical material evidence; do not carry forward
  its material drift uncritically.
- Treat `iter-023-base` as a material experiment, not a clear replacement for
  `iter-022-base`.
- Treat `iter-024-base` through `iter-026-base` as evidence that Blender material
  tweaks and direct material patching alone are no longer enough.
- Treat `iter-017-base` as a rejected shrinkwrap experiment.
- Treat `iter-031-base` through `iter-034-base` as rejected/partial experiments:
  they improved body continuity in Blender but produced app-render arm/weight
  drift.
- Treat `iter-035-base` as the proof that body-shell vertices must not bind to
  arm bones.
- Treat `iter-037-base` as a rejected transparency/detail experiment because it
  introduced detached circuit geometry in app render.
- Treat `iter-038-base` through `iter-050-base` as the active surface-detail
  integration series. `iter-050-base` is the first base variant to clear the
  loop validator as `PROMOTABLE`.
- Do not carry forward the rectangular shard method from `iter-043-base`.
- Do not promote or re-export the hair variant until the base shell clears
  side/back view coherence.
- Do not treat the current VRM as final. It remains a prototype/candidate only.

Current blockers:

- base variant now clears the loop validator at `iter-050-base`
- hair-added variant now clears the loop validator at `iter-053-hair`
- `iter-049-base` is rejected because broad head/torso volume glows reintroduced
  surface-patch readability; only the smaller torso cue carried into
  `iter-050-base`
- final application assets have been replaced with promoted variants:
  `Naia.vrm`/`Naia-Base.vrm` = `iter-050-base`,
  `Naia-Hair.vrm` = `iter-053-hair`
- humanoid rig auto-mapping still swaps left/right limbs during Blender VRM
  export, but `iter-030-base` proves the exported VRM can be corrected by a JSON
  post-export patch
- `iter-050-base` and `iter-053-hair` both clear promotion thresholds
- Previous Playwright/three-vrm app capture blanking was traced to browser GPU
  context loss. The reproducible capture path now launches Chromium with
  SwiftShader via `packages/shell/scripts/capture-naia-vrm.mjs`.
- App render is no longer a blank-render blocker. Final filenames
  `/avatars/Naia.vrm` and `/avatars/Naia-Hair.vrm` both load in the capture
  harness and show expression differences.

Next highest-leverage changes:

- Improve the fused shell and material quality instead of continuing only face
  micro-adjustments.
- Reduce visible procedural/primitive construction in the ears, arms, and body
  transitions.
- Keep the decal-plane face approach for now, but do not treat face attachment
  as solved until side-view evidence clears.
- Tune material/view coherence next: restore translucent jelly quality while
  preserving app-render face contrast, and move circuits into embedded/internal
  geometry rather than surface-sticker lines.
- The next useful loop should separate face material from body material so face
  contrast does not fall whenever body translucency improves.
- If app render does not reflect Blender material changes, add a VRM/GLB material
  patch step and score the app render as the authoritative visual evidence.
- Direct material patching has now been tested. The next method change should
  move face geometry or rendering treatment forward so the minimal face remains
  readable through the translucent body.
- The mouth pipeline should keep the `iter-029` oval fan mesh approach. The next
  loop should shift effort to explicit humanoid bone assignment and a cleaner
  continuous body mesh so the character stops reading as assembled primitives.
- The rig pipeline should keep the `iter-030` humanBones JSON patch unless the
  Blender exporter setup is fixed directly. The next visual loop should focus on
  a cleaner continuous body mesh, not more face micro-adjustment.
- `iter-050-base` clears the app-render arm drift, detached circuit regression,
  mouth visibility, face readability, and material-depth gate enough to promote
  the base variant.
- `iter-053-hair` clears the hair-added loop after rejecting `iter-051-hair`
  and `iter-052-hair` for hair integration. Its hair is cyan/blue, non-human,
  and attached as side jelly locks.
