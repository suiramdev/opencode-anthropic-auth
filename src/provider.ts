/**
 * Plugin-owned Anthropic provider package.
 *
 * OpenCode v2 serves `@ai-sdk/anthropic` through its own native
 * `AnthropicMessages` route rather than the Vercel AI SDK, and the v2 plugin
 * API has no response-side hook — only `session.request` can touch an
 * outbound request. Claude Code's `mcp_`-prefixed tool names therefore cannot
 * round-trip through the documented hooks: prefixing the request without
 * un-prefixing the stream makes every tool call fail with `Unknown tool`.
 *
 * So the plugin points the `anthropic` provider's `package` at this module
 * (a `file://` specifier, which `Provider.loadPackage` imports directly).
 * OpenCode calls `model(modelID, settings)` and we return a model built from
 * the stock route with one wrapped transport: outbound requests get the Claude
 * Code treatment, inbound SSE frames get the tool prefix stripped back off.
 */

import type {
  LanguageModel,
  ProviderOptions,
  ProviderPackageSettings,
} from '@opencode-ai/ai'
import { Auth } from '@opencode-ai/ai'
import { AnthropicMessages } from '@opencode-ai/ai/protocols/anthropic-messages'
import type { HttpRequest, HttpRequestTransform } from '@opencode-ai/ai/route'
import { Effect, Stream } from 'effect'
import { AUTH_MODE_KEY, type AuthMode } from './constants.ts'
import { isRecord } from './guards.ts'
import {
  isInsecure,
  resolveApiBaseUrl,
  rewriteRequestBody,
  setOAuthHeaders,
  stripToolPrefix,
} from './transform.ts'

/** Transport shape carried by the Anthropic Messages route. */
export type AnthropicTransport = (typeof AnthropicMessages.route)['transport']

/** Input `AnthropicTransport.prepare` receives from the route. */
export type AnthropicPrepareInput = Parameters<AnthropicTransport['prepare']>[0]

/**
 * What OpenCode's model resolver hands a native provider package.
 *
 * `apiKey` carries the secret for every credential type, `AUTH_MODE_KEY`
 * arrives from the credential metadata this plugin stores at login, and
 * `headers` / `body` / `limits` are the resolved provider+model overlays.
 * Any other key is user-supplied provider config.
 */
export type Settings = ProviderPackageSettings & {
  readonly apiKey?: string
  readonly providerOptions?: ProviderOptions
  readonly [AUTH_MODE_KEY]?: AuthMode
}

/**
 * Settings consumed directly here. Everything left over is forwarded as
 * `providerOptions.anthropic`, mirroring what OpenCode does for AI SDK
 * providers so the models.dev thinking variants keep working.
 */
const RESERVED_SETTINGS = new Set([
  'apiKey',
  'authToken',
  'baseURL',
  'headers',
  'body',
  'limits',
  'providerOptions',
  AUTH_MODE_KEY,
])

/**
 * Wrap the route transport so OAuth requests look like Claude Code.
 *
 * `prepare` runs after OpenCode's own `session.request` plugin hooks, which
 * reach us as `input.transform`; ours is chained behind them so a hook still
 * sees the untouched request. `frames` undoes the tool prefix before the
 * protocol decodes each SSE event.
 */
export function claudeCodeTransport(
  base: AnthropicTransport,
  accessToken: string,
): AnthropicTransport {
  const spoof: HttpRequestTransform = (request: HttpRequest) =>
    Effect.sync(() => {
      setOAuthHeaders(request.headers, accessToken)
      if (request.body !== undefined) {
        request.body = rewriteRequestBody(request.body)
      }
    })

  return {
    id: `${base.id}+claude-code`,
    prepare: (input) =>
      base.prepare({
        ...input,
        transform: (request) => {
          const upstream = input.transform?.(request)
          return upstream === undefined
            ? spoof(request)
            : Effect.flatMap(upstream, () => spoof(request))
        },
      }),
    frames: (prepared, request, runtime) =>
      Stream.map(base.frames(prepared, request, runtime), (frame) =>
        typeof frame === 'string' ? stripToolPrefix(frame) : frame,
      ),
  }
}

/**
 * OpenCode's `ProviderPackage.Definition["model"]`.
 *
 * Keeps stock Anthropic behaviour for plain API keys and only layers the
 * subscription treatment on when the active credential came from this
 * plugin's Claude Pro/Max OAuth method.
 */
export function model(modelID: string, settings: Settings): LanguageModel {
  const oauth = settings[AUTH_MODE_KEY] === 'oauth'
  const secret = settings.apiKey ?? ''

  // Bun and Node only expose TLS verification globally, so an opt-in insecure
  // proxy has to relax it process-wide rather than per request.
  if (isInsecure()) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  const explicit = settings.providerOptions
  const explicitAnthropic = isRecord(explicit?.anthropic)
    ? explicit.anthropic
    : {}
  const overlay = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !RESERVED_SETTINGS.has(key)),
  )

  return AnthropicMessages.route
    .with({
      endpoint: {
        baseURL: resolveApiBaseUrl(settings.baseURL),
        ...(oauth ? { query: { beta: 'true' } } : {}),
      },
      // In OAuth mode the transport owns every auth header so the Claude Code
      // header set stays in one place; otherwise use the stock API-key auth.
      auth: oauth
        ? Auth.none
        : Auth.optional(secret || undefined, 'apiKey').pipe(
            Auth.header('x-api-key'),
          ),
      headers:
        settings.headers === undefined ? undefined : { ...settings.headers },
      http:
        settings.body === undefined
          ? undefined
          : { body: { ...settings.body } },
      limits: settings.limits,
      providerOptions: {
        ...explicit,
        anthropic: { ...overlay, ...explicitAnthropic },
      },
      ...(oauth
        ? {
            transport: claudeCodeTransport(
              AnthropicMessages.route.transport,
              secret,
            ),
          }
        : {}),
    })
    .model({ id: modelID })
}
