# dsh-guardian-mode

The **fifth mode** of DeepSeek Harness (DSH): preset id `guardian`, a
session that combines the PTC *code* presentation with the *cordis* toolset,
watched round-by-round by an **independent auditor**.

An agent on this preset keeps full standard-mode capabilities (shell,
filesystem, web, skills, goals, subagents, workflows, Code Mode tool
presentation, and the Cordis runtime toolset). Separately, every session
drives one **persistent Codex app-server** process:

| Worker | Model | Effort | Job |
| --- | --- | --- | --- |
| luna | `gpt-5.6-luna` | medium | incremental trace summary per round |
| sol | `gpt-5.6-sol` | max | independent audit → `pass` / `warning` / `critical` |

All audit feedback is written to a **sidecar**
(`${DSH_HOME:-~/.dsh}/guardian/sidecars/<sessionId>.json`) — never into the
session log, so the model's context is not polluted and the guardian itself
cannot be steered by prompt injection from audited content.

## Install

```bash
# in your dsh profile (profiles/web and profiles/tui use the same pattern)
cd ~/.dsh/profiles/web
pnpm add dsh-guardian-mode@github:yhfgyyf/dsh-guardian-mode
# add "dsh-guardian-mode" to package.json dsh.profile.bundles (both profiles),
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
- `/guardian resume` — clear a safety/failure pause.

## Behavior

- **Adaptive cadence**: after `pass` the audit interval doubles (1 → 2 → 4 →
  8 rounds, capped); `warning` resets to 1; `critical` pauses the session
  (safety boundary, the live turn is cancelled and no further audit commits
  run until `resume`).
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
| POST | `/api/guardian/resume` | `{ sessionId }` |

The Web dock strip registers at `conversation.input.dock` **order 5** —
rendered between the Todo strip (order 0) and the Goal strip (order 10).

## TUI

`dsh-tui-app` renders an independent color-coded block (pass=green,
warning=amber, critical/paused=red) beside the config row:

- `c` — request an audit now (empty composer only)
- `r` — resume a paused guardian (empty composer only)
- `Esc` — collapse / expand the block

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
- Does not modify the auto router — the four-mode routing is untouched.
- Images, skills, goals, subagents, and workflows flow unchanged through the
  preset (see `presets/guardian/agent.cordis.yml`).
- Does not modify the global node_modules; install as a profile bundle.
