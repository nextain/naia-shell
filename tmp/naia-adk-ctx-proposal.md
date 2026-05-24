# naia-adk Context Management Architecture Proposal

## Background

naia-adk is a development toolkit used by multiple AI agents (Claude Code, Codex, naia-agent, etc.)
to assist with development work across projects (naia-os, onmam, alpha-adk, etc.).

Currently, project knowledge is stored in `.agents/context/*.yaml` files.

---

## Problem Statement

### 1. Token Waste
- To find any information, AI must Grep files → load entire file
- Example: need 10 lines about `gateway_health` → loads 900-line `architecture.yaml` (~4000 tokens)
- Actual need: ~80 tokens. Waste ratio: ~50x

### 2. Noise Injection
- Entire file loaded = unrelated content (voice architecture, VRM pipeline, Discord routing...)
  all enters the context window
- Degrades answer quality, increases hallucination risk
- Harder to reason correctly when irrelevant context dominates

### 3. Not Suitable as SoT
- Triple-mirror system: `.agents/context/` + `.users/context/` + `.users/context/ko/`
  = same information in 3 places
- Manual sync required → mirrors drift → "which one is actually SoT?"
- No per-fact freshness tracking (which section is stale?)
- Partial updates break intra-file consistency

### 4. Runtime Lock-in Risk
- If solved at naia-agent level → Claude Code, Codex, other AIs cannot access
- Must be AI-agnostic infrastructure

---

## Proposed Solution: naia-adk Knowledge Layer

### Core Concept: Knowledge Atomization

Replace file-based storage with **knowledge atoms** — the smallest meaningful knowledge unit.

```json
{
  "id": "naia-os:gateway_health_cmd",
  "title": "gateway_health Tauri Command",
  "project": "naia-os",
  "tags": ["tauri", "rust", "health-check", "naia-agent"],
  "related": ["naia-os:naia_agent_lifecycle", "naia-os:settings_tab_ui"],
  "content": "fn gateway_health() -> bool\nChecks naia-agent child process liveness.\nUsed by SettingsTab health check button: invoke<boolean>(\"gateway_health\")",
  "confidence": "high",
  "updated": "2026-05-17"
}
```

### Knowledge Graph

Atoms are connected via `related` links, enabling graph traversal:

```
ctx_get("naia-os:gateway_health_cmd")
  └── related:
        naia-os:naia_agent_lifecycle
        naia-os:settings_tab_ui
          └── related: naia-os:tauri_commands
```

AI loads only what it needs, traverses only as deep as required.

---

## Architecture

```
naia-adk/
├── ctx/
│   ├── engine/     # atom store (SQLite), graph traversal, search
│   ├── tools/      # ctx_search, ctx_get, ctx_edit, ctx_relate
│   ├── sync/       # existing YAML → atom migration
│   └── export/     # atom → human-readable files (inverse)
└── projects/
    ├── naia-os/    # atoms tagged project:naia-os
    ├── onmam/      # atoms tagged project:onmam
    └── ...
```

### Access Layer (AI-agnostic)

```
CLI:        naia-ctx search "gateway health check"  → any AI with shell access
MCP server: ctx:// protocol                         → any MCP-compatible AI
naia-agent: skill wrapper around CLI                → naia-agent sessions
Claude Code: shell invocation or MCP               → this session
```

Any AI runtime can access the knowledge base. No lock-in.

---

## Tool Interface

| Tool | Signature | Description |
|------|-----------|-------------|
| `ctx_search` | `(query, project?, tags?)` | Semantic/tag search → relevant atoms |
| `ctx_get` | `(id)` | Get single atom by ID |
| `ctx_edit` | `(id, content)` | Update atom content |
| `ctx_relate` | `(id1, id2, relation)` | Link atoms |
| `ctx_add` | `(atom)` | Create new atom |
| `ctx_export` | `(project, format)` | Generate human-readable files |

---

## Impact

| Aspect | Current | After ctx |
|--------|---------|-----------|
| Token cost | ~4000 tokens/query | ~80 tokens/query |
| Noise | Full file content | Relevant atoms only |
| SoT | 3 mirrored files (drift-prone) | Single atom DB |
| Freshness | Unknown | atom.updated + confidence |
| Cross-project | Manual copy | Shared atom store |
| AI access | Any AI (files) | Any AI (CLI/MCP) |
| Mirror maintenance | Manual (hook-enforced) | Auto-generated exports |

---

## Migration Path

1. Atom schema design + validation
2. ctx engine (SQLite atom store + graph)
3. Migration tool: existing `.agents/context/*.yaml` → atoms
4. CLI + MCP server
5. naia-agent skill wrapper
6. Apply to naia-os first, then other projects
7. Retire triple-mirror system → auto-export only

---

## Open Questions for Review

1. **Atom granularity**: How small is "too small"? What's the right unit?
2. **Conflict resolution**: When two projects have overlapping knowledge, how to handle?
3. **Versioning**: Should atoms be versioned? Or just `updated` timestamp?
4. **Search strategy**: Tag-based first, add embeddings later? Or embeddings from day 1?
5. **Export frequency**: On-demand vs. automated (git hook)?
6. **Schema evolution**: How to handle atom schema changes over time?
7. **Cold start**: How to bootstrap atom DB for a new project?
