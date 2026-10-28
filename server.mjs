import { realpathSync } from 'node:fs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerStatus, callNemotron } from './src/provider.js';
import { buildLearnerContext, makeLearnerRequest, validateLearnerResponse, renderLearnerAdvice,
  makeAuthorRequest, verifyAuthoredProposal } from './src/model.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const routes = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['public/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ...['engine', 'model', 'session'].map(name => [`/src/${name}.js`, [`src/${name}.js`, 'text/javascript; charset=utf-8']]),
]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};

export function createServer({ env = process.env, invokeModel = callNemotron } = {}) {
  let active = false;
  const server = http.createServer(async (req, res) => {
    const reply = (code, value, type = 'application/json; charset=utf-8') => {
      const body = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value);
      res.writeHead(code, { ...securityHeaders, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const failure = (code, message, httpStatus = 400) => reply(httpStatus, { ok: false, error: { code, message } });
    try {
      const port = server.address()?.port;
      const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (!hosts.has(req.headers.host)) return failure('LOCAL_ADDRESS_REQUIRED', 'Open the local application address.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === '/api/config') return reply(200, { model: providerStatus(env), version: '0.1.0' });
        if (url.pathname === '/health') return reply(200, { ok: true, application: 'equivia' });
        const asset = routes.get(url.pathname);
        if (!asset) return failure('NOT_FOUND', 'Not found.', 404);
        return reply(200, await readFile(path.join(root, asset[0])), asset[1]);
      }
      if (req.method !== 'POST' || !['/api/coach', '/api/author'].includes(url.pathname)) return failure('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const origins = new Set([...hosts].map(host => `http://${host}`));
      if (req.headers.origin && !origins.has(req.headers.origin)) return failure('ORIGIN_REJECTED', 'Use the local studio to request a model response.', 403);
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return failure('JSON_REQUIRED', 'Send JSON.', 415);
      if (active) return failure('MODEL_BUSY', 'A model request is already being prepared.', 409);
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 262144) { req.resume(); return failure('REQUEST_TOO_LARGE', 'This request is too large.', 413); }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return failure('INVALID_JSON', 'The request could not be read. Your investigation is unchanged.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return failure('INVALID_REQUEST', 'Expected an object.');
      const kind = url.pathname === '/api/coach' ? 'coach' : 'author';
      const allowed = kind === 'coach' ? ['worlds', 'experiments', 'history', 'explanation', 'currentHypotheses'] : ['brief', 'variableIds'];
      if (Object.keys(body).some(key => !allowed.includes(key))) return failure('INVALID_REQUEST', 'The request contains unsupported fields.');
      const config = providerStatus(env);
      if (!config.configured) return failure('MODEL_UNAVAILABLE', 'Model assistance is not configured in this installation. The laboratory works locally.', 200);
      let context, request;
      try {
        if (kind === 'coach') { context = buildLearnerContext(body); request = makeLearnerRequest(context, { model: config.model }); }
        else request = makeAuthorRequest(body, { model: config.model });
      } catch (error) {
        if (error.code === 'IMPOSSIBLE_EVIDENCE') return failure('IMPOSSIBLE_EVIDENCE', 'The recorded evidence is impossible under every supplied candidate. Review the notebook before requesting guidance.');
        return failure('INVALID_REQUEST', 'The model request is outside the supported experiment format.');
      }
      if (active) return failure('MODEL_BUSY', 'A model request is already being prepared.', 409);
      active = true;
      try {
        const response = await invokeModel({ ...request, purpose: kind }, { env });
        if (!response.ok) return reply(200, response);
        if (kind === 'coach') {
          const proposal = validateLearnerResponse(response.content, context);
          return reply(200, { ok: true, advice: renderLearnerAdvice(proposal, context), metadata: response.metadata });
        }
        const checked = verifyAuthoredProposal(response.content, { variableIds: body.variableIds });
        return reply(200, { ok: checked.accepted, ...checked, metadata: checked.accepted ? response.metadata : undefined });
      } catch { return failure('MODEL_RESPONSE_REJECTED', 'The model response did not pass the required checks. Your investigation is unchanged.', 200); }
      finally { active = false; }
    } catch { return failure('INVALID_REQUEST', 'The request could not be completed. Your investigation is unchanged.'); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 55000;
  return server;
}
function isDirectEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) {
  const port = process.env.PORT ?? '4192';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error('PORT must be an integer from 0 through 65535.');
  const server = createServer();
  server.listen(Number(port), '127.0.0.1', () => console.log(`EQUIVIA ready at http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
