# Patents

Copyright 2026 Nextain Inc.

This file explains how Nextain's patents relate to this repository. It does not
change the license of this repository. The license is in [`LICENSE`](LICENSE).

## 1. Claim Boundary Split

The code in this repository is licensed under the Apache License 2.0.
Section 3 of the Apache License 2.0 grants each recipient "a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as
stated in this section) patent license" for the patent claims of each
contributor that are necessarily infringed by that contributor's
Contribution "alone or by combination of their Contribution(s) with the Work".

As Section 3 of the Apache License 2.0 states, that patent license terminates
for a party that institutes patent litigation "alleging that the Work or a
Contribution incorporated within the Work constitutes direct or contributory
patent infringement".

Nextain does not narrow that grant. Nothing in this file takes away or limits
any right that the Apache License 2.0 gives you for the code contained in this
repository—including using, modifying, or distributing this repository's code
in a paid hosted or managed service (SaaS) or in an organization of any size.

The claim boundary in this file splits:

- **Tier-1 open-source code and interfaces contained in this repository**,
  which are licensed under the Apache License 2.0 (including Section 3 of the
  Apache License 2.0); and
- **Tier-2 patented methods and proprietary commercial modules not contained in
  this repository**, which are not licensed under the Apache License 2.0 and
  are governed by Section 2 and Section 3 of this file.

## 2. Conditional Patent Pledge

Subject to the limitations, terminations, and exclusions in Section 2 and
Section 3 of this file, Nextain covenants not to sue a Covered Person for
infringement of the Listed Patents (Section 4) for making, having made, using,
modifying, offering to sell, selling, importing, or distributing software to
the extent it uses this repository's code or implements its public interfaces
in compliance with Section 2. Activities and modules listed in Section 3 are
outside the scope of this covenant from the outset and are never covered by it.
Within its scope, this covenant is irrevocable except as stated in Section 2
and Section 3 and binds Nextain's successors and assigns.

A **Covered Person** is, solely with respect to the permitted activity below:

- an individual acting in a personal, non-commercial capacity and not on behalf
  of an employer or other entity, solely for that personal, non-commercial
  activity;
- a non-profit organization, school, or academic research group, solely for its
  non-commercial research or educational work; or
- a developer or company building an app, extension, or content for the Naia
  ecosystem, solely with respect to that app, extension, or content, provided
  that it passes the official conformance tests published by Nextain for this
  repository (until Nextain publishes such conformance tests, no person or
  software qualifies under this third bullet) and does not fall under the
  termination conditions in Section 2 or the exclusions in Section 3.

This Section 2 covenant ends automatically for a person or entity that:

1. offers a paid hosted or managed service to third parties that practices a
   Listed Patent through any method or module not contained in this repository
   (beyond the scope already licensed under Section 3 of the Apache License
   2.0), whether or not the service also uses this repository's code;
2. deploys software that practices a Listed Patent through any method or module
   not contained in this repository (beyond the scope already licensed under
   Section 3 of the Apache License 2.0) commercially within or on behalf of an
   organization (including its Affiliates, where an **Affiliate** of a party in
   this file means any entity that controls, is controlled by, or is under
   common control with that party, and "control" has the meaning given in the
   definition of "Legal Entity" in Section 1 of the Apache License 2.0) that
   has annual consolidated revenue of more than KRW 1,000,000,000, or in a
   deployment exceeding 100 seats; or
3. triggers Defensive Termination as described below.

### Defensive Termination

This Section 2 covenant ends automatically as of the filing date for any person
or entity that (directly, through an Affiliate as defined above, or through any
entity acting in concert with it) institutes (a) patent litigation (including a
cross-claim or counterclaim in a lawsuit) against Nextain or any of its
Affiliates (as defined above), (b) patent litigation (including a cross-claim
or counterclaim in a lawsuit) against any contributor or user of this
repository alleging that this repository or software implementing its public
interfaces infringes a patent, or (c) an administrative validity challenge
(including an invalidation trial, opposition, inter partes review (IPR), or
post-grant review (PGR)) against any Listed Patent. This defensive termination
ends only the Section 2 covenant; it never affects, modifies, or limits the
patent license or termination conditions in Section 3 of the Apache License 2.0
([`LICENSE`](LICENSE), confirmed in Section 1 of this file).

## 3. Commercial Patent License Requirement

The Conditional Patent Pledge in Section 2 never covers the following, which
are excluded from the Section 2 covenant from the outset. To the extent any of
the following practices a Listed Patent through a method or module not
contained in this repository (beyond the scope already licensed under Section 3
of the Apache License 2.0), contact Nextain for a separate commercial patent
license (see [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)):

1. Any activity listed under the termination conditions in Section 2, to the
   extent it practices a Listed Patent through a method or module not contained
   in this repository (beyond the scope already licensed under Section 3 of the
   Apache License 2.0).
2. Embedding or implementing a Listed Patent method that is not contained in
   this repository (beyond the scope already licensed under Section 3 of the
   Apache License 2.0) in a closed-source product, an OEM shipment, or an
   enterprise-wide deployment exceeding the revenue or seat thresholds in
   Section 2.
3. The proprietary Nextain Tier-2 Enterprise and Cloud Modules to the extent
   not included in the Source form of this repository:
   - enterprise multi-layer context compaction plug-ins (to be specified after
     patent filing) and centralized multi-vendor strike-routing servers
     (`CrossVendorStrikeMatrix`);
   - automated long-term memory to fine-tuning (`LoRA`/`FT`) circulation cloud
     pipelines (`MemoryToLoRAConverter`, `PersonaWeightBakingPipeline`),
     encrypted cloud memory vault synchronization
     (`EncryptedCloudMemoryVault`), and multi-tenant organization memory graphs
     (`MultiTenantOrgMemoryGraph`);
   - enterprise multi-tenant RBAC harness provisioning servers
     (`MultiTenantHarnessProvisioner`), centralized multi-session audit
     dashboard servers (`EnterpriseAuditDashboardServer`), and N2SF air-gapped
     deployment bundles or ERP/groupware commercial connectors
     (`N2SFAirgapBundleInstaller`);
   - the Naia Studio server generation pipeline and hybrid media cloud
     (`DittoPrerenderPipeline`, `VisemeSeamlessStitcherPro`,
     `VoxCPM2TensorRTCascade`, `NvaStudioGenerator`, `DittoMotionExtractor`,
     `BC250ClusterDispatcher`, `StudioVocalCloneTrainer`,
     `AppStoreRevenueSettlement`); and
   - enterprise ACL-federated knowledge bases (`EnterpriseFederatedKB`),
     commercial AI curriculum professor engines (`CurriculumProfessorEngine`),
     and commercial automated patent claim generation servers
     (`AutoPatentClaimGenerator`).

Any baseline code, scripts, hooks, skills, adapters, or public interfaces
included in the Source form of this repository remain licensed under the Apache
License 2.0 as confirmed in Section 1 of this file. Section 3 of this file
never limits what Section 1 of this file confirms.

## 4. Listed Patents

The Listed Patents are the patent applications listed below (as updated from
time to time in this repository), any domestic, PCT, or foreign patent
applications claiming priority to or the benefit of any of them (including
domestic priority applications under Article 55 of the Korean Patent Act,
conversion applications, continuations, continuations-in-part, divisionals, and
reissues), and any patents issuing from any of the foregoing. Nextain may add
patent applications to this list when filed; Nextain will not remove a patent
application from the Section 2 covenant for a Covered Person who already
received this repository while that application was listed.

| Application | Title (short) |
|---|---|
| 10-2026-0054378 | Source-context based AI curriculum generation |
| 10-2026-0054380 | Codebase based AI patent discovery and filing pipeline |
| 10-2026-0054383 | Neuroscience based multi-store long-term memory for AI agents |
| 10-2026-0054384 | AI-agent linked dynamic panel extension |
| 10-2026-0056403 | Domain-aware strike accumulation for multi-agent cross validation |
| 10-2026-0065859 | Episode-consolidation based safe context compaction |
| 10-2026-0065894 | Multimodal structuring of legacy website conversion requirements |
| 10-2026-0065895 | Organization memory based harness tuning in multi-tenant SaaS |
| 10-2026-0078232 | Importance-gated cognitive memory |
| 10-2026-0090454 | Ambient media event linked long-term memory and proactive speech |
| 10-2026-0095948 | AI workspace context file integrity verification |
| 10-2026-0096205 | Composite state inference for multiple AI agent sessions |
| (To be added after filing) | (To be added after filing) |

## 5. Contact

Commercial patent licensing: see [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md).
