---
name: cordis-plugin-development
description: Create, inspect, test, repair, or extend a DSH Cordis plugin or model-facing tool when Guardian mode needs a missing capability.
---

# Develop DSH Cordis plugins

Use this only when the current task genuinely needs a DSH capability that the mounted profile does not provide.

1. Inspect the live Host and Client interfaces with the Cordis inspect tools before writing code. Do not infer service methods, event payloads, slot props, or theme tokens.
2. Choose the owning plane: files, processes, sessions, and cross-session state belong on Host; page layout and visual state belong on Client. A feature spanning both uses a small private bridge.
3. Read the current plugin/package with the self-inspection tool before updating it. Add a new immutable package version; do not rewrite history.
4. Register every effect through the Cordis lifecycle and retain the disposer. Keep optional services optional with `ctx.get()`; declare `inject` only for hard dependencies.
5. Client code is plain JavaScript with `React.createElement`, not JSX. Host code must use the inspected builtins and services.
6. Preview and define the smallest implementation, activate the exact returned package, inspect diagnostics, then verify the behavior that motivated the change.
7. Stop or roll back a bad package. Permanently undefine only when the user explicitly wants deletion.

For Guardian extensions, keep the top-level model tool fixed as `guardian_capability`. Register new behavior behind the Guardian service capability registry so the early prompt and tool catalog do not change. Never expose audit feedback through this bridge and never add it to the DSH session event log.
