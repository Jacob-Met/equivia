/** Server-only, bounded Nebius transport. No credential discovery or offline reply. */
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
const HOSTS = new Set(['api.tokenfactory.us-central1.nebius.com', 'api.tokenfactory.nebius.com']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const LIMIT = 65536;
const TOKEN_LIMITS = Object.freeze({ coach: 2048, author: 8192 });
class ProviderFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ProviderFailure(code, message); }
function configuration(env) {
  const rawModel = typeof env?.NEBIUS_MODEL === 'string' ? env.NEBIUS_MODEL.trim() : '';
  const model = MODEL_ID.test(rawModel) ? rawModel : null;
  const rawKey = typeof env?.NEBIUS_API_KEY === 'string' ? env.NEBIUS_API_KEY.trim() : '';
  const key = rawKey.length > 0 && rawKey.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(rawKey) ? rawKey : null;
  let baseUrl = null;
  try {
    const rawUrl = env?.NEBIUS_BASE_URL === undefined ? BASE_URL : env.NEBIUS_BASE_URL;
    if (typeof rawUrl !== 'string' || rawUrl.length > 240 || /[?#]/.test(rawUrl)) throw new Error('Invalid base');
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || url.port
      || !['/v1', '/v1/'].includes(url.pathname)) throw new Error('Invalid base');
    baseUrl = `https://${url.hostname}/v1/`;
  } catch { /* Report only a safe null configuration, never the supplied URL. */ }
  return { model, key, baseUrl, configured: Boolean(model && key && baseUrl) };
}
export function providerStatus(env = process.env) {
  const { configured, model, baseUrl } = configuration(env);
  return Object.freeze({ provider: 'nebius', configured, model, baseUrl });
}
function validateRequest(request, model) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['model', 'messages', 'purpose'].includes(key))
    || request.model !== model || !Object.hasOwn(TOKEN_LIMITS, request.purpose)
    || !Array.isArray(request.messages) || request.messages.length !== 2) {
    fail('INVALID_REQUEST', 'The model request is not configured correctly. No state was changed.');
  }
  const roles = ['system', 'user'];
  let bytes = 0;
  const messages = request.messages.map((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some((key) => !['role', 'content'].includes(key))
      || message.role !== roles[index] || typeof message.content !== 'string' || !message.content.trim()) {
      fail('INVALID_REQUEST', 'The model messages are invalid. No state was changed.');
    }
    bytes += new TextEncoder().encode(message.content).length;
    return { role: message.role, content: message.content };
  });
  if (bytes > 262144) fail('INVALID_REQUEST', 'The model context is too large. No state was changed.');
  return { model, messages, temperature: 0.2, max_tokens: TOKEN_LIMITS[request.purpose], stream: false };
}
async function boundedJSON(response) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > LIMIT) {
    try { await response.body?.cancel(); } catch { /* Closed already. */ }
    fail('INVALID_PROVIDER_RESPONSE', 'The model response exceeded its size limit. No state was changed.');
  }
  if (!response.body || typeof response.body.getReader !== 'function') fail('INVALID_PROVIDER_RESPONSE', 'The model returned no usable response. No state was changed.');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid bytes');
      size += value.byteLength;
      if (size > LIMIT) fail('INVALID_PROVIDER_RESPONSE', 'The model response exceeded its size limit. No state was changed.');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve original failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { fail('INVALID_PROVIDER_RESPONSE', 'The model service returned malformed data. No state was changed.'); }
}
function contentFrom(body) {
  if (!body || !Array.isArray(body.choices) || body.choices.length !== 1) fail('INVALID_PROVIDER_RESPONSE', 'The model returned an invalid message. No state was changed.');
  const choice = body.choices[0], message = choice?.message;
  if (choice?.finish_reason === 'length') fail('PROVIDER_TRUNCATED', 'The model response reached its token limit. No state was changed.');
  if (message?.refusal !== undefined && message.refusal !== null && message.refusal !== '') fail('PROVIDER_REFUSED', 'The model did not provide a proposal. No state was changed.');
  if (choice?.finish_reason !== 'stop' || message?.role !== 'assistant' || typeof message.content !== 'string'
    || !message.content.trim() || new TextEncoder().encode(message.content).length > LIMIT
    || (message.tool_calls !== undefined && message.tool_calls !== null && (!Array.isArray(message.tool_calls) || message.tool_calls.length))
    || (message.function_call !== undefined && message.function_call !== null)) fail('INVALID_PROVIDER_RESPONSE', 'The model returned an incomplete or unsupported message. No state was changed.');
  return message.content;
}
function usageFrom(body) {
  if (!body?.usage || typeof body.usage !== 'object') return undefined;
  const usage = {};
  for (const name of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const value = body.usage[name];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 1000000000) usage[name] = value;
  }
  return Object.keys(usage).length ? Object.freeze(usage) : undefined;
}

/** Domain acceptance remains the caller's separate deterministic validation step. */
export async function callNemotron(request, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  try {
    const config = configuration(env);
    if (!config.configured || typeof fetchImpl !== 'function') fail('MODEL_UNAVAILABLE', 'Model assistance is not configured. Your current learning state and puzzle are unchanged.');
    const body = validateRequest(request, config.model);
    const response = await fetchImpl(new URL('chat/completions', config.baseUrl).href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${config.key}` },
      body: JSON.stringify(body),
    });
    if (!response?.ok) {
      try { await response?.body?.cancel(); } catch { /* Never echo provider error bodies. */ }
      fail('PROVIDER_FAILED', 'The model service could not complete the request. No state was changed.');
    }
    const envelope = await boundedJSON(response), content = contentFrom(envelope), usage = usageFrom(envelope);
    const requestId = response.headers?.get('x-request-id');
    return Object.freeze({ ok: true, content, metadata: Object.freeze({ provider: 'nebius', model: config.model,
      ...(usage ? { usage } : {}), ...(typeof requestId === 'string' && MODEL_ID.test(requestId) ? { requestId } : {}) }) });
  } catch (error) {
    return Object.freeze({ ok: false, error: Object.freeze({
      code: error instanceof ProviderFailure ? error.code : 'PROVIDER_FAILED',
      message: error instanceof ProviderFailure ? error.message : 'The model request failed. Your current learning state and puzzle are unchanged.',
    }) });
  }
}
