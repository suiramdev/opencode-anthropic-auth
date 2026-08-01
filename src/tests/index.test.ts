import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Context } from '@opencode-ai/plugin/promise/plugin'
import plugin from '../index'

type OAuthMethod = {
  integrationID: string
  method: { id: string; type: string; label: string }
  authorize: (inputs: Record<string, string>) => Promise<{
    mode: string
    url: string
    instructions: string
    callback: (code: string) => Promise<Record<string, unknown>>
  }>
  refresh?: (credential: {
    refresh: string
  }) => Promise<Record<string, unknown>>
}

type ModelRecord = {
  package?: string
  cost: Array<{ input: number; output: number; cache: Record<string, number> }>
}

type ProviderRecord = { package: string }

const MAX_METHOD = 'claude-pro-max'
const CONSOLE_METHOD = 'claude-console-key'

/**
 * Minimal stand-in for the plugin context.
 *
 * `credential` decides what the active `anthropic` connection resolves to, so
 * a test can drive the catalog transform down each branch.
 */
function createContext(credential?: { type: string; methodID?: string }) {
  const methods: OAuthMethod[] = []
  const provider: ProviderRecord = { package: 'aisdk:@ai-sdk/anthropic' }
  const models = new Map<string, ModelRecord>([
    [
      'claude-sonnet-4-5',
      {
        package: 'aisdk:@ai-sdk/anthropic',
        cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      },
    ],
  ])

  let runCatalog: (() => void) | undefined
  const reload = mock(() => {
    runCatalog?.()
    return Promise.resolve()
  })

  const ctx = {
    integration: {
      transform: (callback: (draft: unknown) => void) => {
        callback({
          update: () => {},
          method: { update: (item: OAuthMethod) => methods.push(item) },
        })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      connection: {
        active: () =>
          Promise.resolve(
            credential ? { type: 'credential', id: 'cred_1' } : undefined,
          ),
        resolve: () => Promise.resolve(credential),
      },
    },
    catalog: {
      transform: (callback: (draft: unknown) => void) => {
        runCatalog = () =>
          callback({
            provider: {
              get: (id: string) =>
                id === 'anthropic' ? { provider, models } : undefined,
              update: (id: string, update: (p: ProviderRecord) => void) => {
                if (id === 'anthropic') update(provider)
              },
            },
          })
        runCatalog()
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload,
    },
    event: { subscribe: () => emptyStream() },
  }

  return { ctx: ctx as unknown as Context, methods, provider, models, reload }
}

async function* emptyStream() {
  // Never yields; the plugin's watcher parks here until cleanup aborts it.
  await new Promise(() => {})
}

function methodFor(methods: OAuthMethod[], id: string) {
  const found = methods.find((item) => item.method.id === id)
  if (!found) throw new Error(`method ${id} was not registered`)
  return found
}

describe('plugin definition', () => {
  test('exports a stable id and a setup function', () => {
    expect(plugin.id).toBe('suiramdev.anthropic-auth')
    expect(plugin.setup).toBeFunction()
  })
})

describe('integration methods', () => {
  test('registers both OAuth methods on the anthropic integration', async () => {
    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    expect(methods.map((item) => item.method.id)).toEqual([
      MAX_METHOD,
      CONSOLE_METHOD,
    ])
    for (const item of methods) {
      expect(item.integrationID).toBe('anthropic')
      expect(item.method.type).toBe('oauth')
    }
  })

  test('labels the methods for the connect picker', async () => {
    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    expect(methodFor(methods, MAX_METHOD).method.label).toBe('Claude Pro/Max')
    expect(methodFor(methods, CONSOLE_METHOD).method.label).toBe(
      'Create an API Key',
    )
  })

  test('only the subscription method refreshes', async () => {
    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    // A console-minted API key never expires, so there is nothing to rotate.
    expect(methodFor(methods, MAX_METHOD).refresh).toBeFunction()
    expect(methodFor(methods, CONSOLE_METHOD).refresh).toBeUndefined()
  })

  test('authorize starts a paste-the-code flow against claude.ai', async () => {
    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    const attempt = await methodFor(methods, MAX_METHOD).authorize({})
    const url = new URL(attempt.url)

    expect(attempt.mode).toBe('code')
    expect(url.origin).toBe('https://claude.ai')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBeTruthy()
  })
})

describe('token refresh', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('exchanges the refresh token and keeps the oauth marker', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    const refreshed = await methodFor(methods, MAX_METHOD).refresh?.({
      refresh: 'old-refresh',
    })

    expect(refreshed?.access).toBe('new-access')
    expect(refreshed?.refresh).toBe('new-refresh')
    expect(refreshed?.methodID).toBe(MAX_METHOD)
    expect(refreshed?.metadata).toEqual({ anthropicAuthMode: 'oauth' })
    expect(refreshed?.expires as number).toBeGreaterThan(Date.now())
  })

  test('surfaces a permanent refresh failure', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('nope', { status: 400 })),
    ) as unknown as typeof fetch

    const { ctx, methods } = createContext()
    await plugin.setup(ctx)

    expect(
      methodFor(methods, MAX_METHOD).refresh?.({ refresh: 'stale' }),
    ).rejects.toThrow('Token refresh failed: 400')
  })
})

describe('catalog transform', () => {
  let cleanup: (() => Promise<void> | void) | undefined

  beforeEach(() => {
    cleanup = undefined
  })

  afterEach(async () => {
    await cleanup?.()
  })

  test('leaves the catalog untouched without a connection', async () => {
    const { ctx, provider, models } = createContext()
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(provider.package).toBe('aisdk:@ai-sdk/anthropic')
    expect(models.get('claude-sonnet-4-5')?.cost[0]?.input).toBe(3)
  })

  test('leaves the catalog untouched for a plain API key', async () => {
    const { ctx, provider } = createContext({ type: 'key' })
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(provider.package).toBe('aisdk:@ai-sdk/anthropic')
  })

  test('leaves the catalog untouched for a foreign oauth method', async () => {
    const { ctx, provider } = createContext({
      type: 'oauth',
      methodID: 'some-other-plugin',
    })
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(provider.package).toBe('aisdk:@ai-sdk/anthropic')
  })

  test('swaps the provider package and zeroes cost for a subscription', async () => {
    const { ctx, provider, models } = createContext({
      type: 'oauth',
      methodID: MAX_METHOD,
    })
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(provider.package).toContain('provider.js')
    // A per-model package would otherwise shadow the provider one.
    expect(models.get('claude-sonnet-4-5')?.package).toBe(provider.package)
    expect(models.get('claude-sonnet-4-5')?.cost[0]).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test('keeps billing for a console-minted API key', async () => {
    const { ctx, provider, models } = createContext({
      type: 'oauth',
      methodID: CONSOLE_METHOD,
    })
    cleanup = (await plugin.setup(ctx)) ?? undefined

    // The key is billed per token even though it arrived over OAuth.
    expect(provider.package).toContain('provider.js')
    expect(models.get('claude-sonnet-4-5')?.cost[0]?.input).toBe(3)
  })

  test('reloads the catalog once when the mode is discovered', async () => {
    const { ctx, reload } = createContext({
      type: 'oauth',
      methodID: MAX_METHOD,
    })
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(reload).toHaveBeenCalledTimes(1)
  })

  test('does not reload when nothing is connected', async () => {
    const { ctx, reload } = createContext()
    cleanup = (await plugin.setup(ctx)) ?? undefined

    expect(reload).toHaveBeenCalledTimes(0)
  })
})
