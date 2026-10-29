import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';
import { lampWorlds } from '../src/engine.js';

// Actual local HTTP with a deliberately labeled stub adapter. No provider call.
const ENV = { NEBIUS_API_KEY: 'server-test-secret', NEBIUS_MODEL: 'configured/model' };
const coachInput = () => ({ worlds: lampWorlds(), experiments: [{ id: 'force-A-on', intervention: { A: 1 } }],
  history: [{ intervention: {}, outcome: { A: 1, B: 1 } }], explanation: 'Matching lamps prove that A causes B.', currentHypotheses: ['A-causes-B'] });
const authorInput = () => ({ brief: 'Create a two-lamp causal experiment.', variableIds: ['A', 'B'] });
const coachProposal = () => ({ schema: 'equivia.coach.v1', interpretation: 'correlation_direction',
  learnerQuote: 'Matching lamps prove', question: 'predict_before_clamp', experimentId: 'force-A-on', factIds: ['observational', 'experiment:force-A-on'] });
const authorProposal = () => ({ schema: 'equivia.author.v1', title: 'Stub test pair', worlds: lampWorlds(), experiment: { intervention: { A: 1 } } });
const stubReply = (content) => ({ ok: true, content: JSON.stringify(content), metadata: { provider: 'stub', model: 'stub-not-live' } });
const safeStub = async (request) => stubReply(request.purpose === 'coach' ? coachProposal() : authorProposal());

async function serve(options, action) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await action(server); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
function openRequest(server, { method = 'GET', path = '/health', headers = {} } = {}) {
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    request.on('error', reject);
  });
  return { request, response };
}
function send(server, options = {}) {
  const opened = openRequest(server, options); opened.request.end(options.body); return opened.response;
}
const post = (server, path, body, headers = {}) => send(server, { method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('actual HTTP serves EQUIVIA assets and safe status while withholding server/provider source', async () => {
  await serve({ env: ENV, invokeModel: safeStub }, async (server) => {
    assert.deepEqual(JSON.parse((await send(server)).text), { ok: true, application: 'equivia' });
    const config = await send(server, { path: '/api/config' });
    assert.equal(JSON.parse(config.text).model.configured, true);
    assert.equal(config.text.includes(ENV.NEBIUS_API_KEY), false);
    for (const path of ['/', '/styles.css', '/app.js', '/src/engine.js', '/src/model.js', '/src/session.js', '/src/forecast.js']) {
      const asset = await send(server, { path });
      assert.equal(asset.status, 200); assert.ok(asset.text.length);
      assert.equal(asset.headers['x-content-type-options'], 'nosniff');
      assert.match(asset.headers['content-security-policy'], /frame-ancestors 'none'/);
    }
    for (const path of ['/server.mjs', '/src/provider.js', '/.env', '/%2e%2e/server.mjs']) {
      assert.equal((await send(server, { path })).status, 404);
    }
    const head = await send(server, { method: 'HEAD', path: '/' });
    assert.equal(head.status, 200); assert.equal(head.text, '');
  });
});

test('missing configuration yields explicit unavailable results for coach and author without fabrication', async () => {
  let calls = 0;
  await serve({ env: {}, invokeModel: async () => { calls++; return safeStub({ purpose: 'coach' }); } }, async (server) => {
    for (const [path, input] of [['/api/coach', coachInput()], ['/api/author', authorInput()]]) {
      const result = await post(server, path, input), data = JSON.parse(result.text);
      assert.equal(result.status, 200); assert.equal(data.ok, false); assert.equal(data.error.code, 'MODEL_UNAVAILABLE');
      assert.equal(Object.hasOwn(data, 'advice'), false); assert.equal(Object.hasOwn(data, 'proposal'), false);
    }
    assert.equal(calls, 0);
  });
});

test('safe coach stub is grounded in exact engine facts and a reviewable learner quotation', async () => {
  await serve({ env: ENV, invokeModel: async (request) => {
    assert.equal(request.purpose, 'coach');
    const sent = JSON.parse(request.messages[1].content);
    assert.equal(sent.explanation, coachInput().explanation);
    assert.equal(Object.hasOwn(sent, 'hiddenWorldId'), false);
    return stubReply(coachProposal());
  } }, async (server) => {
    const response = await post(server, '/api/coach', coachInput()), data = JSON.parse(response.text);
    assert.equal(data.ok, true); assert.equal(data.advice.rejectable, true);
    assert.equal(data.advice.interpretation.quote, 'Matching lamps prove');
    assert.equal(data.advice.facts[0].comparison.equivalent, true);
    assert.equal(data.advice.facts[1].comparison.separates, true);
    assert.equal(data.metadata.provider, 'stub');
    assert.equal(response.text.includes(ENV.NEBIUS_API_KEY), false);
  });
});

test('safe author stub is accepted only with recomputed equivalence and intervention proof', async () => {
  await serve({ env: ENV, invokeModel: safeStub }, async (server) => {
    const data = JSON.parse((await post(server, '/api/author', authorInput())).text);
    assert.equal(data.ok, true); assert.equal(data.accepted, true);
    assert.equal(data.proof.observational.equivalent, true);
    assert.equal(data.proof.interventional.separates, true);
    assert.ok(data.proof.interventional.pairs[0].witness);
  });
});

test('rejected authored pair supplies no replacement proposal or success metadata, and the coach remains usable', async () => {
  await serve({ env: ENV, invokeModel: async (request) => {
    if (request.purpose === 'coach') return stubReply(coachProposal());
    const invalid = authorProposal(); invalid.experiment.intervention = { A: 1, B: 1 };
    return stubReply(invalid);
  } }, async (server) => {
    const rejected = JSON.parse((await post(server, '/api/author', authorInput())).text);
    assert.equal(rejected.ok, false); assert.equal(rejected.accepted, false);
    assert.equal(rejected.error.code, 'NOT_SEPARATED');
    assert.equal(Object.hasOwn(rejected, 'proposal'), false);
    assert.equal(Object.hasOwn(rejected, 'metadata'), false);
    assert.match(rejected.error.message, /unchanged/);
    assert.equal(JSON.parse((await post(server, '/api/coach', coachInput())).text).ok, true);
  });
});

test('zero-evidence history has a distinct response and never reaches the model', async () => {
  let calls = 0;
  await serve({ env: ENV, invokeModel: async () => { calls++; return stubReply(coachProposal()); } }, async (server) => {
    const input = coachInput(); input.history = [{ intervention: {}, outcome: { A: 1, B: 0 } }];
    const data = JSON.parse((await post(server, '/api/coach', input)).text);
    assert.equal(data.ok, false); assert.equal(data.error.code, 'IMPOSSIBLE_EVIDENCE');
    assert.equal(Object.hasOwn(data, 'advice'), false); assert.equal(calls, 0);
  });
});

test('Host and exact Origin checks reject foreign or malformed origins before model dispatch', async () => {
  let calls = 0;
  await serve({ env: ENV, invokeModel: async (request) => { calls++; return safeStub(request); } }, async (server) => {
    assert.equal((await send(server, { headers: { host: 'evil.invalid' } })).status, 403);
    const port = server.address().port;
    for (const origin of ['https://evil.invalid', 'null', `http://127.0.0.1:${port}/path`, `http://user@127.0.0.1:${port}`]) {
      assert.equal((await post(server, '/api/author', authorInput(), { origin })).status, 403);
    }
    assert.equal(calls, 0);
    assert.equal(JSON.parse((await post(server, '/api/author', authorInput(), { origin: `http://127.0.0.1:${port}` })).text).ok, true);
    assert.equal(calls, 1);
  });
});

test('content type, unsupported fields, malformed JSON, and body bounds produce usable HTTP errors', async () => {
  let calls = 0;
  await serve({ env: ENV, invokeModel: async (request) => { calls++; return safeStub(request); } }, async (server) => {
    assert.equal((await post(server, '/api/author', authorInput(), { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(server, '/api/coach', '{broken')).status, 400);
    assert.equal((await post(server, '/api/coach', { ...coachInput(), hiddenWorldId: 'A-causes-B' })).status, 400);
    assert.equal((await post(server, '/api/author', 'null')).status, 400);
    const large = await post(server, '/api/author', ' '.repeat(262145));
    assert.equal(large.status, 413); assert.equal(JSON.parse(large.text).error.code, 'REQUEST_TOO_LARGE');
    assert.equal(calls, 0); assert.equal((await send(server)).status, 200);
  });
});

test('partial uploads cannot bypass the shared coach/author busy guard', { timeout: 5000 }, async () => {
  let calls = 0, release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  await serve({ env: ENV, invokeModel: async (request) => {
    calls++; if (calls === 1) { entered(); await gate; } return safeStub(request);
  } }, async (server) => {
    const body = JSON.stringify(authorInput());
    const observed = once(server, 'request');
    const slow = openRequest(server, { method: 'POST', path: '/api/author', headers: { 'content-type': 'application/json' } });
    slow.request.write(body.slice(0, 10)); await observed;
    const fast = post(server, '/api/coach', coachInput());
    try {
      await started; slow.request.end(body.slice(10));
      const response = await slow.response;
      assert.equal(response.status, 409); assert.equal(JSON.parse(response.text).error.code, 'MODEL_BUSY'); assert.equal(calls, 1);
    } finally { release(); await fast; slow.request.destroy(); }
  });
});

test('adapter exceptions and unsupported coaching assertions preserve availability and hide private details', async () => {
  let calls = 0;
  await serve({ env: ENV, invokeModel: async (request) => {
    calls++;
    if (calls === 1) throw new Error('server-test-secret');
    if (calls === 2) return stubReply({ ...coachProposal(), actualWorldId: 'A-causes-B' });
    return safeStub(request);
  } }, async (server) => {
    for (let index = 0; index < 2; index++) {
      const response = await post(server, '/api/coach', coachInput()), data = JSON.parse(response.text);
      assert.equal(data.ok, false); assert.equal(data.error.code, 'MODEL_RESPONSE_REJECTED');
      assert.equal(response.text.includes(ENV.NEBIUS_API_KEY), false); assert.equal(Object.hasOwn(data, 'advice'), false);
    }
    assert.equal(JSON.parse((await post(server, '/api/coach', coachInput())).text).ok, true);
  });
});
