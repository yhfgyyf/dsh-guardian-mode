# dsh-guardian-mode

The **fifth mode** of DeepSeek Harness (DSH): preset id `guardian`, combining
PTC *code* presentation, independent review, and a human-approved Cordis
remediation loop.

An agent on this preset keeps full standard-mode capabilities (shell,
filesystem, web, skills, goals, subagents, workflows, Code Mode tool
presentation). Cordis self-modification tools stay model-hidden during ordinary
work and are exposed temporarily only after the user accepts a `critical`
remediation. Separately, every session
drives one **persistent Codex app-server** process:

| Worker | Model | Effort | Job |
| --- | --- | --- | --- |
| luna | `gpt-5.6-luna` | medium | incremental trace summary per round |
| sol | `gpt-5.6-sol` | max | independent audit → `pass` / `warning` / `critical` |

All unaccepted feedback and reviewer state is written to a **sidecar**
(`${DSH_HOME:-~/.dsh}/guardian/sidecars/<sessionId>.json`). Only explicit human
acceptance appends a bounded `<guardian-remediation>` prompt and capability
lease at the context tail. The model then loads the named skills through DSH's
stable `skill` tool; prior messages are never rewritten and raw reviewer output
remains private.

## Install

```bash
# in your dsh profile (profiles/web and profiles/tui use the same pattern)
cd ~/.dsh/profiles/web
pnpm add dsh-guardian-mode@github:yhfgyyf/dsh-guardian-mode
# Recommended stable tool discovery for Guardian and Auto target presets:
pnpm add dsh-progressive-tools@github:yhfgyyf/dsh-progressive-tools
# add both bundles to package.json dsh.profile.bundles (both profiles),
# then restart the profile.
```

The bundle patch adds one dual-face row:

```yaml
- insert:
    - id: guardian-bundle
      name: dsh-guardian-mode
```

The node half mounts the host `guardians` service, registers the `/guardian`
command, and (when a webserver is present) the Remote API. The same row's
browser half (`dsh.client`) renders the guardian strip in the composer dock.

## Using the mode

- Start a session with `--preset guardian` (TUI) or pick **guardian** in the
  Web preset chip, or `/preset guardian` on a blank session.
- `/guardian status` — round, cadence interval, last verdict, pause state.
- `/guardian now` — force an audit (out of cadence).
- `/guardian history` — recent audits from the sidecar.
- `/guardian accept [audit-id]` — approve the latest/specified remediation.
- `/guardian resume` — clear a non-critical-review failure/manual pause.

## Behavior

- **Cadence**: the first audit requires at least two steps and 60 seconds;
  later audits run every three steps or three minutes, with a 60-second minimum
  gap. Anomalies audit at the next safe boundary.
- **Warning approval**: a warning leaves the main Agent running. Acceptance
  cancels the current turn, appends the approved repair prompt, executes one
  repair turn, and performs a fresh verification audit.
- **Critical approval**: critical pauses the main Agent and active Goal first.
  Acceptance temporarily exposes Cordis tools and appends a capability lease.
  The repair Agent must load `editing-cordis-compositions` through the stable
  `skill` loader, and loads `cordis-plugin-development` only for plugin or
  model-facing-tool work. The original task resumes only after the repair audit
  is no longer critical.
- **Three consecutive failures** (codex unreachable, timeouts, malformed
  replies) pause the session with reason `failures`.
- **Every 5 rounds** a full objective-alignment audit runs (objective +
  boundary rules + recent summaries).
- **Final audit** runs when the session is disposed (or `/guardian now` with
  the Remote API `final: true`).
- **Fixed capability**: `guardian` (`GUARDIAN_CAPABILITY`). The auto router
  keeps routing only standard / code / minimal / cordis.

## Remote API (browser)

Third-party routes, declared by this package:

| Method | Path | Body / query |
| --- | --- | --- |
| GET | `/api/guardian/snapshot` | `?session=<id>` |
| GET | `/api/guardian/watch` | `?session=<id>` (SSE `event: guardian`) |
| POST | `/api/guardian/request-now` | `{ sessionId, final? }` |
| POST | `/api/guardian/accept` | `{ sessionId, auditId? }` |
| POST | `/api/guardian/resume` | `{ sessionId }` |

The Web dock strip registers at `conversation.input.dock` **order 5** —
rendered between the Todo strip (order 0) and the Goal strip (order 10).

## TUI

`dsh-tui-app` renders an independent color-coded block (pass=green,
warning/critical/paused=red) beside the config row:

- `a` — accept a pending remediation (empty composer only)
- `c` — copy feedback while paused
- `r` — resume a non-critical-review pause
- `Esc` / `Ctrl+C` — stop current work

## Development

```bash
npm test            # unit + integration
npm run check       # syntax, package manifest, tests
npm run pack:check  # npm pack --dry-run
```

`scripts/build-preset.mjs` regenerates `presets/guardian/agent.cordis.yml`
from the shipped `code` + `cordis` compositions (checked-in result, so the
package works standalone). Tests use `test/fixtures/fake-codex.mjs` — no real
Codex login is required. The Codex models are config, not constants:
```jsonc
{ "models": { "luna": { "model": "gpt-5.6-luna", "effort": "medium" }, "sol": { "model": "gpt-5.6-sol", "effort": "max" } } }
```

## Compatibility

- Never calls `session.delete` or any session-removal API; disposal is
  observed via the host `session/disposed` event for a final audit only.
- Auto still routes only the original four modes. When the companion auto
  router supports capability hints, those names are appended after routing and
  do not alter the original user prompt.
- Images, ordinary skills, goals, subagents, and workflows flow unchanged.
  Guardian's two composition skills are progressive, critical-approval-only
  additions (see `presets/guardian/agent.cordis.yml`).
- Persisted messages remain byte-for-byte unchanged. Acceptance only appends
  remediation, runtime-catalog, and continuation tail messages, so the prior
  message prefix remains eligible for KV-cache reuse. With
  `dsh-progressive-tools`, Cordis restriction changes affect discovery results
  rather than the model-visible system/tool prefix. Without that companion,
  DSH normally rebuilds the Code Mode SDK when visibility changes. An actual
  plugin/system-prompt repair still takes effect through DSH's normal
  restart/new-task prefix rebuild.
- Does not modify the global node_modules; install as a profile bundle.
