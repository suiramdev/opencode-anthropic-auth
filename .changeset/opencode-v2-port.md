---
'@ex-machina/opencode-anthropic-auth': major
---

Port the plugin to the OpenCode v2 plugin API. This release requires OpenCode v2 and will not load on v1.

- The plugin is now a `Plugin.define({ id, setup })` default export with id `ex-machina.anthropic-auth`, configured through `plugins` rather than `plugin`.
- Claude Pro/Max and console API-key login are registered as OAuth methods on OpenCode's `anthropic` integration. Token refresh is handled by OpenCode, so the plugin's inflight-refresh guard is gone.
- Manual API-key entry is dropped from the plugin; OpenCode ships a `key` method for the `anthropic` integration already.
- Request and response rewriting moved from a wrapped `fetch` to a plugin-owned native provider package. v2 serves Anthropic through its own Messages route and exposes no response-side hook, so the package wraps the route transport to keep `mcp_` tool-name prefixing round-tripping.
- `ANTHROPIC_INSECURE` now relaxes TLS verification process-wide instead of per request: v2's Effect HTTP client has no per-request TLS control.
