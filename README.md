# OpenCode Anthropic Auth Plugin

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode/packages/@ex-machina` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

> [!IMPORTANT]
> This fork targets **OpenCode v2** and will not load on v1. The v1 plugin API (`auth.loader` returning a custom `fetch`) was removed in v2; see [Porting notes](#porting-notes) for what changed. For OpenCode v1, use [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) instead.

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth"]
}
```

Then connect an account with `opencode auth login` and pick **Claude Pro/Max**.

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@2.0.0"]
}
```

The plugin's `id` is `ex-machina.anthropic-auth`; disable it without removing the entry using `"-ex-machina.anthropic-auth"`.

## Authentication Methods

The plugin adds two OAuth methods to OpenCode's built-in `anthropic` integration:

- **Claude Pro/Max** — OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
- **Create an API Key** — OAuth flow via `console.anthropic.com` that creates an API key on your behalf.

OpenCode already ships **Manually enter API Key** for the `anthropic` integration, so the plugin no longer registers its own.

## Configuration

The plugin supports the following environment variables:

| Variable             | Description                                                                                                                                                          |
|----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL` | Override the API origin (e.g. for proxying). Must be a valid HTTP(S) URL; only the origin is used, the `/v1` prefix is preserved.                                    |
| `ANTHROPIC_INSECURE` | Set to `1` or `true` to skip TLS certificate verification. Only effective when `ANTHROPIC_BASE_URL` is also set. Applies process-wide — see the warning below.        |

> [!WARNING]
> On v2 the request goes through OpenCode's Effect HTTP client, which offers no per-request TLS control. `ANTHROPIC_INSECURE` therefore sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the whole OpenCode process, not just Anthropic traffic. Use it only against a local proxy you control.

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Registers an OAuth method on OpenCode's `anthropic` integration and runs a PKCE flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens, tagged with an auth-mode marker in the credential metadata
3. Lets OpenCode refresh expired tokens through the method's `refresh` callback
4. Repoints the `anthropic` provider at the plugin's own native provider package
5. Injects the required OAuth headers and beta flags into API requests
6. Sanitizes the system prompt for compatibility (see below)
7. Renames tools to Claude Code's `mcp_`+PascalCase convention on the way out and back on the way in
8. Zeros out model costs (since usage is covered by the subscription)

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Porting notes

OpenCode v2 removed the `auth` plugin surface this project was built on. The v2 equivalents:

| v1 | v2 |
|----|----|
| `auth.methods` | `ctx.integration.transform` → `method.update({ authorize, refresh })` |
| Manual token refresh with an inflight-promise guard | OpenCode's own refresh scheduling, via the method's `refresh` callback |
| `auth.loader` zeroing `provider.models[].cost` | `ctx.catalog.transform` |
| `auth.loader` returning a wrapped `fetch` | A plugin-owned native provider package (`src/provider.ts`) |

The last row is the interesting one. In v2 the `anthropic` provider is served by OpenCode's own `AnthropicMessages` route rather than the Vercel AI SDK, and the plugin API exposes no response-side hook — `session.request` can mutate an outbound request but nothing can touch the response stream. Prefixing tool names on the way out without un-prefixing them on the way back makes every tool call fail with `Unknown tool`.

So the plugin points the provider's `package` at `dist/provider.js` (a `file://` specifier, which OpenCode imports directly). That module rebuilds the stock Anthropic route with one wrapped transport: outbound requests get the Claude Code headers, URL, and body treatment, and inbound SSE frames get the tool prefix stripped back off. `src/tests/integration.test.ts` drives a real `LLM.stream` through that stack against a local server to catch breaking changes in those (beta, unstable) internals.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks `dist/` into `.opencode/plugins/anthropic-auth` so OpenCode loads it as a local plugin package. The whole directory is linked, not just `index.js`, because the plugin resolves `provider.js` relative to its own module URL.
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. Disable the published one with `"-ex-machina.anthropic-auth"` — the two share an `id`, so the later entry wins.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
