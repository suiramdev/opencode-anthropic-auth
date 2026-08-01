import { Credential, Integration, Plugin } from '@opencode-ai/plugin'
import { Money } from '@opencode-ai/schema/money'
import { authorize, exchange, refreshTokens } from './auth.ts'
import {
  AUTH_MODE_KEY,
  type AuthMode,
  INTEGRATION_ID,
  METHOD_CONSOLE,
  METHOD_MAX,
  PLUGIN_ID,
} from './constants.ts'

/** Native provider package this plugin swaps in for OAuth connections. */
const PROVIDER_PACKAGE = new URL('./provider.js', import.meta.url).href

const MAX_METHOD = Integration.MethodID.make(METHOD_MAX)
const CONSOLE_METHOD = Integration.MethodID.make(METHOD_CONSOLE)

const FREE = {
  input: Money.USDPerMillionTokens.zero,
  output: Money.USDPerMillionTokens.zero,
  cache: {
    read: Money.USDPerMillionTokens.zero,
    write: Money.USDPerMillionTokens.zero,
  },
} as const

export default Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    /**
     * Auth mode of the active `anthropic` connection, or `undefined` when it
     * is not one of ours (no connection, or a plain API key).
     *
     * The catalog transform below is synchronous, so the mode is resolved
     * ahead of time and refreshed whenever the connection changes.
     */
    let mode: AuthMode | undefined

    const readMode = async () => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type !== 'oauth') return undefined
      if (credential.methodID === MAX_METHOD) return 'oauth' as const
      if (credential.methodID === CONSOLE_METHOD) return 'api-key' as const
      return undefined
    }

    await ctx.integration.transform((integrations) => {
      integrations.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: MAX_METHOD,
          type: 'oauth',
          label: 'Claude Pro/Max',
        },
        authorize: async () => {
          const result = await authorize('max')
          return {
            mode: 'code',
            url: result.url,
            instructions: 'Paste the authorization code here:',
            callback: async (code: string) =>
              credentialFrom(MAX_METHOD, 'oauth', code, result),
          }
        },
        // OpenCode refreshes within five minutes of expiry and persists the
        // rotated pair, so this only performs the exchange.
        refresh: async (credential) => {
          const tokens = await refreshTokens(credential.refresh)
          return Credential.OAuth.make({
            type: 'oauth',
            methodID: MAX_METHOD,
            ...tokens,
            metadata: { [AUTH_MODE_KEY]: 'oauth' },
          })
        },
      })

      integrations.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: CONSOLE_METHOD,
          type: 'oauth',
          label: 'Create an API Key',
        },
        authorize: async () => {
          const result = await authorize('console')
          return {
            mode: 'code',
            url: result.url,
            instructions: 'Paste the authorization code here:',
            callback: async (code: string) => {
              const tokens = await exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (tokens.type === 'failed') {
                throw new Error('Authorization code exchange failed')
              }
              const response = await fetch(
                'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    authorization: `Bearer ${tokens.access}`,
                  },
                },
              )
              if (!response.ok) {
                throw new Error(`API key creation failed: ${response.status}`)
              }
              const created = (await response.json()) as { raw_key: string }
              // The minted key never expires and has nothing to refresh, so it
              // is stored as a non-expiring credential with no refresh token.
              return Credential.OAuth.make({
                type: 'oauth',
                methodID: CONSOLE_METHOD,
                access: created.raw_key,
                refresh: '',
                expires: 0,
                metadata: { [AUTH_MODE_KEY]: 'api-key' },
              })
            },
          }
        },
      })
    })

    await ctx.catalog.transform((catalog) => {
      if (!mode) return
      const record = catalog.provider.get(INTEGRATION_ID)
      if (!record) return

      // Route the provider through this plugin's package so the Claude Code
      // request/response rewrites apply.
      catalog.provider.update(INTEGRATION_ID, (provider) => {
        provider.package = PROVIDER_PACKAGE
      })

      for (const model of record.models.values()) {
        // A per-model package would shadow the provider one.
        if (model.package !== undefined) model.package = PROVIDER_PACKAGE
        // Subscription usage is not billed per token.
        if (mode === 'oauth') {
          model.cost = model.cost.map((cost) => ({ ...cost, ...FREE }))
        }
      }
    })

    const sync = async () => {
      const next = await readMode()
      if (next === mode) return
      mode = next
      await ctx.catalog.reload()
    }

    await sync()

    // Track connection changes so a login/logout re-derives the mode and
    // replays the catalog transform.
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        if (event.type !== 'integration.connection.updated') continue
        if (event.data.integrationID !== INTEGRATION_ID) continue
        await sync()
      }
    })().catch(() => {})

    // Aborting is the whole teardown; the watcher is never awaited so a
    // stream that ignores the signal cannot wedge plugin shutdown.
    return () => controller.abort()
  },
})

async function credentialFrom(
  methodID: Integration.MethodID,
  authMode: AuthMode,
  code: string,
  result: { verifier: string; redirectUri: string; state: string },
) {
  const tokens = await exchange(
    code,
    result.verifier,
    result.redirectUri,
    result.state,
  )
  if (tokens.type === 'failed') {
    throw new Error('Authorization code exchange failed')
  }
  return Credential.OAuth.make({
    type: 'oauth',
    methodID,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    metadata: { [AUTH_MODE_KEY]: authMode },
  })
}
