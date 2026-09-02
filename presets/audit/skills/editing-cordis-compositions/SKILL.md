---
name: editing-cordis-compositions
description: Create, modify, or mount-validate a DSH Cordis agent preset or composition.
---

# Edit DSH Cordis compositions

Never edit a preset in the installed DSH package. Copy or change only the plugin-owned preset.

- Host composition owns shared registries, persistence, model routing, approvals, permissions, sandboxing, and cross-session services.
- An agent preset owns only the per-session tools, prompt sections, persona, compaction, and skills it contributes.
- A service created by a preset and all its consumers must share an isolated realm. A preset row that only consumes a host service stays outside such a realm.
- Preserve the main session's chosen model, effort, and permissions. Audit is an explicit fifth preset and must not alter Auto Router's original four targets.
- Use `agentPresets.standingKeyFor(id)` to mount-validate the finished preset, then create a real session and inspect its tool list. A roster entry alone is not validation.
- Keep Codex and Claude providers host-side optional bundles; a preset can expose their delegation tools only after the matching provider is installed.

Audit mode combines the shipped code-mode tool presentation with user-approved Cordis self-modification. Keep `audit_capability` as one stable model-facing bridge. Unaccepted summaries, verdicts, findings, and all reviewer thread state stay out of the agent composition and main session messages; only the bounded remediation accepted by the user may be appended at the conversation tail.
