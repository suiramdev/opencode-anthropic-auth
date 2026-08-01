/**
 * End-to-end guard for the provider package.
 *
 * This plugin builds its model on `@opencode-ai/ai`'s route, transport, and
 * framing internals, which are beta and explicitly unstable. Unit tests cover
 * the rewrites in isolation; this drives a real `LLM.stream` through OpenCode's
 * own stack against a local Anthropic-shaped server, so a breaking change in
 * those internals fails here rather than in a user's session.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LLM, LLMClient, type LLMEvent } from '@opencode-ai/ai'
import { RequestExecutor } from '@opencode-ai/ai/route/executor'
import type { Server } from 'bun'
import { Effect, Layer, Stream } from 'effect'
import { CLAUDE_CODE_IDENTITY } from '../constants'
import { isRecord } from '../guards'
import { model } from '../provider'

type Captured = {
  url: URL
  headers: Record<string, string>
  body: Record<string, unknown>
}

const SSE_EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    // The upstream sees the prefixed name, so this is what comes back.
    content_block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'mcp_Bash',
      input: {},
    },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: 'message_stop' },
]

const SYSTEM_PROMPT =
  'You are OpenCode, a coding agent.\n\nSee https://opencode.ai/docs for help.'

describe('anthropic route round-trip', () => {
  let server: Server<undefined>
  let originalBaseUrl: string | undefined
  let captured: Captured
  let events: LLMEvent[]

  beforeAll(async () => {
    originalBaseUrl = process.env.ANTHROPIC_BASE_URL

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        captured = {
          url: new URL(request.url),
          headers: Object.fromEntries(request.headers.entries()),
          body: JSON.parse(await request.text()),
        }
        const body = SSE_EVENTS.map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        ).join('')
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`

    const built = model('claude-sonnet-4-5', {
      apiKey: 'oauth-access-token',
      anthropicAuthMode: 'oauth',
      limits: { context: 200_000, output: 64_000 },
    })

    const collected = await Effect.runPromise(
      Stream.runCollect(
        LLM.stream(
          LLM.request({
            model: built,
            system: [{ type: 'text', text: SYSTEM_PROMPT }],
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'list files' }] },
            ],
            tools: [
              {
                name: 'bash',
                description: 'Run a shell command',
                inputSchema: {
                  type: 'object',
                  properties: { command: { type: 'string' } },
                  required: ['command'],
                },
              },
            ],
          }),
        ),
      ).pipe(
        Effect.provide(
          LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer)),
        ),
      ),
    )
    events = Array.from(collected)
  })

  afterAll(() => {
    server.stop(true)
    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl
  })

  test('targets the beta messages endpoint on the configured origin', () => {
    expect(captured.url.host).toBe(`127.0.0.1:${server.port}`)
    expect(captured.url.pathname).toBe('/v1/messages')
    expect(captured.url.searchParams.get('beta')).toBe('true')
  })

  test('authenticates as an OAuth client, not an API key', () => {
    expect(captured.headers.authorization).toBe('Bearer oauth-access-token')
    expect(captured.headers['x-api-key']).toBeUndefined()
    expect(captured.headers['anthropic-beta']).toContain('oauth-2025-04-20')
    expect(captured.headers['user-agent']).toStartWith('claude-cli/')
  })

  test('sends Claude Code shaped tools and system blocks', () => {
    const tools = captured.body.tools
    const system = captured.body.system
    if (!Array.isArray(tools) || !Array.isArray(system)) {
      throw new Error('request body is missing tools or system')
    }

    expect(isRecord(tools[0]) && tools[0].name).toBe('mcp_Bash')
    expect(isRecord(system[0]) && system[0].text).toStartWith(
      'x-anthropic-billing-header:',
    )
    expect(isRecord(system[1]) && system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(JSON.stringify(system)).not.toContain('opencode.ai/docs')
  })

  test('hands the un-prefixed tool name back to OpenCode', () => {
    const names = events.flatMap((event) =>
      'name' in event && typeof event.name === 'string' ? [event.name] : [],
    )

    expect(names).not.toBeEmpty()
    expect(names).toContain('bash')
    expect(names.some((name) => name.startsWith('mcp_'))).toBe(false)
  })
})
