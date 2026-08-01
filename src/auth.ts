import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const json = (await result.json()) as {
    refresh_token: string
    access_token: string
    expires_in: number
  }

  return {
    type: 'success',
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * OpenCode v2 owns refresh scheduling: it calls the integration method's
 * `refresh` whenever a stored credential is within five minutes of expiry and
 * persists the result, so this only has to perform the exchange. Transient
 * 5xx and network failures are retried with exponential backoff because a
 * throw here fails the model request that triggered the refresh.
 */
export async function refreshTokens(
  refreshToken: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const maxRetries = 2
  const baseDelayMs = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1))
      await promise
    }

    let response: Response
    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      })
    } catch (error) {
      if (attempt < maxRetries && isNetworkError(error)) continue
      throw error
    }

    if (!response.ok) {
      if (response.status >= 500 && attempt < maxRetries) {
        await response.body?.cancel()
        continue
      }
      const body = await response.text().catch(() => '')
      throw new Error(`Token refresh failed: ${response.status} — ${body}`)
    }

    const json = (await response.json()) as {
      refresh_token: string
      access_token: string
      expires_in: number
    }

    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    }
  }

  // Unreachable — each iteration either returns, continues, or throws.
  throw new Error('Token refresh exhausted all retries')
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.includes('fetch failed')) return true
  if (!('code' in error)) return false
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}
