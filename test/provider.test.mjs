import test from 'node:test';
import assert from 'node:assert/strict';
import { providerStatus, callNemotron } from '../src/provider.js';

// All success responses here are fetch stubs, never a live-provider receipt.
const env = { NEBIUS_API_KEY: 'stub-only-secret', NEBIUS_MODEL: 'configured/model' };
const request = (purpose = 'coach') => ({ model: env.NEBIUS_MODEL, purpose, messages: [{ role: 'system', content: 'Return bounded JSON.' }, { role: 'user', content: '{"explanation":"test"}' }] });
const body = (choice = {}) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"proposal":"stub"}' }, ...choice }],
  usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
const response = (value = body()) => new Response(JSON.stringify(value), { headers: { 'x-request-id': 'test-request-id' }, status: 200 });

test('explicit model and existing key are required; unavailable means no fabricated reply or request', async () => {
  assert.equal(providerStatus({ NEBIUS_API_KEY: 'secret' }).configured, false);
  assert.equal(providerStatus({ NEBIUS_MODEL: 'configured/model' }).configured, false);
  let calls = 0;
  const result = await callNemotron(request(), { env: {}, fetchImpl: async () => { calls++; return response(); } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(Object.hasOwn(result, 'content'), false);
  assert.equal(calls, 0);
});

test('safe status and approved endpoint never disclose the credential', async () => {
  assert.deepEqual(providerStatus(env), { configured: true, provider: 'nebius', model: 'configured/model', baseUrl: 'https://api.tokenfactory.nebius.com/v1/' });
  for (const base of ['http://api.tokenfactory.nebius.com/v1/', 'https://evil.invalid/v1/', 'https://user:pass@api.tokenfactory.nebius.com/v1/', 'https://api.tokenfactory.nebius.com/v1/?secret=bad']) {
    const status = providerStatus({ ...env, NEBIUS_BASE_URL: base });
    assert.equal(status.configured, false); assert.equal(status.baseUrl, null);
  }
  assert.equal(JSON.stringify(providerStatus(env)).includes(env.NEBIUS_API_KEY), false);
});

test('transport uses fixed purpose bounds and only returns safe successful response metadata', async () => {
  for (const [purpose, tokenLimit] of [['coach', 2048], ['author', 8192]]) {
    let calls = 0;
    const result = await callNemotron(request(purpose), { env, fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal instanceof AbortSignal, true);
      const sent = JSON.parse(options.body);
      assert.equal(sent.max_tokens, tokenLimit);
      assert.equal(sent.stream, false);
      assert.equal(Object.hasOwn(sent, 'purpose'), false);
      return response();
    } });
    assert.equal(result.ok, true);
    assert.equal(result.metadata.provider, 'nebius');
    assert.equal(result.metadata.requestId, 'test-request-id');
    assert.deepEqual(result.metadata.usage, { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 });
    assert.equal(JSON.stringify(result).includes(env.NEBIUS_API_KEY), false);
    assert.equal(calls, 1);
  }
});

test('caller cannot override configured model, endpoint, or arbitrary provider settings', async () => {
  for (const invalid of [{ ...request(), model: 'another/model' }, { ...request(), endpoint: 'https://evil.invalid' }, { ...request(), purpose: 'unbounded' },
    { ...request(), max_tokens: 1000000 }, { ...request(), messages: [{ role: 'tool', content: 'run code' }] }]) {
    let calls = 0;
    const result = await callNemotron(invalid, { env, fetchImpl: async () => { calls++; return response(); } });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'INVALID_REQUEST'); assert.equal(calls, 0);
  }
});

test('truncation and refusal have safe distinct errors with no retry or success metadata', async () => {
  for (const [choice, code] of [
    [{ finish_reason: 'length' }, 'PROVIDER_TRUNCATED'],
    [{ message: { role: 'assistant', content: '', refusal: 'private-provider-message' } }, 'PROVIDER_REFUSED'],
  ]) {
    let calls = 0;
    const result = await callNemotron(request(), { env, fetchImpl: async () => { calls++; return response(body(choice)); } });
    assert.equal(result.ok, false); assert.equal(result.error.code, code); assert.equal(calls, 1);
    assert.equal(Object.hasOwn(result, 'metadata'), false);
    assert.equal(JSON.stringify(result).includes('private-provider-message'), false);
  }
});

test('network and HTTP failures never expose exceptions, keys, or provider bodies', async () => {
  for (const fetchImpl of [async () => { throw new Error(env.NEBIUS_API_KEY); }, async () => new Response('private-error-body', { status: 403 })]) {
    const result = await callNemotron(request(), { env, fetchImpl });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'PROVIDER_FAILED');
    assert.equal(JSON.stringify(result).includes(env.NEBIUS_API_KEY), false);
    assert.equal(JSON.stringify(result).includes('private-error-body'), false);
  }
});

test('streamed oversized and malformed provider responses are rejected', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  const tooLarge = await callNemotron(request(), { env, fetchImpl: async () => new Response(stream, { status: 200 }) });
  assert.equal(tooLarge.ok, false); assert.equal(cancelled, true);
  const malformed = await callNemotron(request(), { env, fetchImpl: async () => new Response('{incomplete', { status: 200 }) });
  assert.equal(malformed.ok, false); assert.equal(malformed.error.code, 'INVALID_PROVIDER_RESPONSE');
});

test('null tool and function fields from OpenAI-compatible providers are treated as absent', async () => {
  // Shape observed from the live Token Factory endpoint: explicit nulls, finish_reason stop.
  const nullFields = body({ message: { role: 'assistant', content: '{"proposal":"stub"}', refusal: null, tool_calls: null, function_call: null } });
  const result = await callNemotron(request(), { env, fetchImpl: async () => response(nullFields) });
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"proposal":"stub"}');
  const toolCall = await callNemotron(request(), { env, fetchImpl: async () => response(body({ message: { role: 'assistant', content: '{}', tool_calls: [{ id: 'x' }] } })) });
  assert.equal(toolCall.ok, false); assert.equal(toolCall.error.code, 'INVALID_PROVIDER_RESPONSE');
});
