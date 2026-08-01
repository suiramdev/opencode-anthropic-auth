import { afterEach, describe, expect, test } from 'bun:test'
import type { HttpRequest } from '@opencode-ai/ai/route'
import { Effect, Stream } from 'effect'
import { CLAUDE_CODE_IDENTITY, REQUIRED_BETAS } from '../constants'
import {
  claudeCodeTransport,
  model,
  type AnthropicPrepareInput as PrepareInput,
  type AnthropicTransport as Transport,
} from '../provider'

/**
 * Stand-in for the Anthropic route transport. `prepare` records the request it
 * was handed after the wrapper's transform ran; `frames` replays canned SSE
 * payloads so the response mapping can be observed.
 */
function stubTransport(frames: string[]) {
  const seen: PrepareInput[] = []
  const transport = {
    id: 'http-json',
    prepare: (input: PrepareInput) =>
      Effect.gen(function* () {
        seen.push(input)
        yield* input.transform?.(request) ?? Effect.void
        return { request } as never
      }),
    frames: () => Stream.fromIterable(frames),
  } as unknown as Transport

  const request: HttpRequest = {
    url: 'https://api.anthropic.com/v1/messages',
    method: 'POST',
    headers: {},
    body: undefined,
  }

  return { transport, request, seen }
}

async function runPrepare(transport: Transport, input: Partial<PrepareInput>) {
  await Effect.runPromise(
    transport.prepare(input as PrepareInput) as Effect.Effect<unknown>,
  )
}

describe('claudeCodeTransport', () => {
  test('applies Claude Code auth headers to the outbound request', async () => {
    const { transport, request } = stubTransport([])
    request.headers = { 'x-api-key': 'sk-ant-leftover' }

    await runPrepare(claudeCodeTransport(transport, 'oauth-token'), {})

    expect(request.headers.authorization).toBe('Bearer oauth-token')
    expect(request.headers['x-api-key']).toBeUndefined()
    expect(request.headers['user-agent']).toContain('claude-cli')
    for (const beta of REQUIRED_BETAS) {
      expect(request.headers['anthropic-beta']).toContain(beta)
    }
  })

  test('rewrites the request body into a Claude Code shaped payload', async () => {
    const { transport, request } = stubTransport([])
    request.body = JSON.stringify({
      system: 'You are OpenCode, a coding agent.',
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    })

    await runPrepare(claudeCodeTransport(transport, 'token'), {})

    const body = JSON.parse(request.body as string)
    expect(body.tools[0].name).toBe('mcp_Bash')
    expect(
      body.system.some(
        (block: { text: string }) => block.text === CLAUDE_CODE_IDENTITY,
      ),
    ).toBe(true)
  })

  test('leaves a bodyless request alone', async () => {
    const { transport, request } = stubTransport([])

    await runPrepare(claudeCodeTransport(transport, 'token'), {})

    expect(request.body).toBeUndefined()
  })

  test('runs an upstream transform before its own', async () => {
    const { transport, request } = stubTransport([])
    const order: string[] = []

    await runPrepare(claudeCodeTransport(transport, 'token'), {
      transform: (incoming: HttpRequest) =>
        Effect.sync(() => {
          // A session.request hook must observe the untouched request.
          order.push(incoming.headers.authorization ?? 'unset')
        }),
    })

    expect(order).toEqual(['unset'])
    expect(request.headers.authorization).toBe('Bearer token')
  })

  test('strips the tool prefix back off inbound frames', async () => {
    const { transport } = stubTransport([
      '{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Bash"}}',
      '{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read"}}',
    ])

    const wrapped = claudeCodeTransport(transport, 'token')
    const frames = await Effect.runPromise(
      Stream.runCollect(
        wrapped.frames(
          undefined as never,
          undefined as never,
          undefined as never,
        ) as Stream.Stream<string>,
      ),
    )

    expect(Array.from(frames).join('\n')).toContain('"name": "bash"')
    expect(Array.from(frames).join('\n')).toContain('"name": "read"')
    expect(Array.from(frames).join('\n')).not.toContain('mcp_')
  })
})

describe('model', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  })

  test('wraps the transport and targets the beta surface for OAuth', () => {
    const built = model('claude-sonnet-4-5', {
      apiKey: 'oauth-token',
      anthropicAuthMode: 'oauth',
    })

    expect(built.route.transport.id).toContain('claude-code')
    expect(built.route.endpoint.query).toEqual({ beta: 'true' })
  })

  test('keeps the stock transport for a plain API key', () => {
    const built = model('claude-sonnet-4-5', { apiKey: 'sk-ant-key' })

    expect(built.route.transport.id).not.toContain('claude-code')
    expect(built.route.endpoint.query).toBeUndefined()
  })

  test('honours ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const built = model('claude-sonnet-4-5', { apiKey: 'sk-ant-key' })

    expect(built.route.endpoint.baseURL).toBe('http://localhost:8080/v1')
  })

  test('forwards leftover settings as anthropic provider options', () => {
    const built = model('claude-sonnet-4-5', {
      apiKey: 'sk-ant-key',
      thinking: { type: 'enabled', budgetTokens: 4096 },
    })

    expect(built.route.defaults.providerOptions?.anthropic).toEqual({
      thinking: { type: 'enabled', budgetTokens: 4096 },
    })
  })

  test('does not leak the credential into provider options', () => {
    const built = model('claude-sonnet-4-5', {
      apiKey: 'sk-ant-secret',
      anthropicAuthMode: 'oauth',
    })

    expect(JSON.stringify(built.route.defaults.providerOptions)).not.toContain(
      'sk-ant-secret',
    )
  })
})
