/**
 * One bounded live-provider acceptance attempt through an existing authorized
 * process environment. No credential discovery, retry, fixture, or fallback.
 */
import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { providerStatus, callNemotron } from '../src/provider.js';
import {
  ModelContractError, buildLearnerContext, makeLearnerRequest,
  validateLearnerResponse, renderLearnerAdvice,
  makeAuthorRequest, validateAuthorResponse, verifyAuthoredProposal,
} from '../src/model.js';

const USAGE = 'Usage: node tools/live-model-check.mjs --purpose coach|author --input request.json --output evidence.json';
const LIMITS = Object.freeze({ maxProviderRequests: 1, providerDeadlineMs: 45000,
  maxResponseBytes: 65536, maxInputBytes: 262144, retryCount: 0 });

class CheckFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new CheckFailure(code, message); }
function argumentsFrom(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null;
  if (argv.length !== 6) fail('INVALID_ARGUMENTS', USAGE);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--purpose', '--input', '--output'].includes(flag) || Object.hasOwn(args, flag)
      || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS', USAGE);
    args[flag] = value;
  }
  if (!['coach', 'author'].includes(args['--purpose'])) fail('INVALID_ARGUMENTS', USAGE);
  const input = path.resolve(args['--input']), output = path.resolve(args['--output']);
  if (input === output) fail('INVALID_ARGUMENTS', 'Input and evidence files must be different.');
  return { purpose: args['--purpose'], input, output };
}
function safeFailure(error) {
  if (error instanceof CheckFailure || error instanceof ModelContractError) return { code: error.code, message: error.message };
  return { code: 'CHECK_FAILED', message: 'The acceptance check could not be completed. No retry was made.' };
}
async function inputFrom(filename) {
  const info = await stat(filename);
  if (!info.isFile() || info.size > LIMITS.maxInputBytes) fail('INVALID_INPUT', 'Use a regular JSON input file no larger than 256 KiB.');
  const bytes = await readFile(filename);
  if (bytes.length > LIMITS.maxInputBytes) fail('INVALID_INPUT', 'The input file exceeds 256 KiB.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_INPUT', 'The input must be one valid UTF-8 JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'The input must be a JSON object.');
  return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function main() {
  let args;
  try { args = argumentsFrom(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ accepted: false, error: safeFailure(error) })); return 2; }
  if (!args) { console.log(USAGE); return 0; }

  // Reserve a new receipt before a provider attempt. Never overwrite prior
  // evidence, and never spend a request when its output path cannot be opened.
  let output;
  try { output = await open(args.output, 'wx', 0o600); }
  catch { console.error(JSON.stringify({ accepted: false, error: { code: 'EVIDENCE_PATH_UNAVAILABLE',
    message: 'Use a new evidence filename in an existing writable directory. No provider call was made.' } })); return 2; }

  const config = providerStatus(process.env);
  let attempts = 0, httpResponseReceived = false, httpStatus;
  const evidence = {
    schema: 'equivia.live-model-check.v1', purpose: args.purpose,
    startedAt: new Date().toISOString(), configuration: config,
    limits: { ...LIMITS, maxTokens: args.purpose === 'coach' ? 1200 : 4096 },
    accepted: false,
  };
  let exitCode = 2;
  try {
    if (!config.configured) fail('MODEL_UNAVAILABLE', 'An existing authorized NEBIUS_API_KEY and explicit NEBIUS_MODEL are required. No provider call was made.');
    if (typeof globalThis.fetch !== 'function') fail('MODEL_UNAVAILABLE', 'This runtime has no native fetch implementation. No provider call was made.');
    const { value: input, sha256 } = await inputFrom(args.input);
    evidence.inputSha256 = sha256;
    let context, request;
    if (args.purpose === 'coach') {
      context = buildLearnerContext(input);
      request = makeLearnerRequest(context, { model: config.model });
    } else {
      if (Object.keys(input).some((key) => !['brief', 'variableIds'].includes(key))) {
        fail('INVALID_INPUT', 'Author input permits only brief and variableIds.');
      }
      request = makeAuthorRequest(input, { model: config.model });
    }

    const nativeFetch = globalThis.fetch.bind(globalThis);
    const response = await callNemotron({ ...request, purpose: args.purpose }, {
      env: process.env,
      fetchImpl: async (url, options) => {
        if (attempts >= LIMITS.maxProviderRequests) fail('REQUEST_LIMIT', 'The one-request limit was reached.');
        const sent = JSON.parse(options.body);
        if (sent.max_tokens !== evidence.limits.maxTokens || sent.stream !== false) {
          fail('LIMIT_MISMATCH', 'The provider request no longer matches this consumer\'s reviewed bounds.');
        }
        // Record only safe numerical request settings, never headers or messages.
        evidence.requestSettings = { maxTokens: sent.max_tokens, temperature: sent.temperature, stream: sent.stream };
        attempts++;
        const result = await nativeFetch(url, options);
        httpResponseReceived = true; httpStatus = result.status;
        return result;
      },
    });
    exitCode = attempts ? 1 : 2;
    if (!response.ok) {
      evidence.validation = { accepted: false, stage: 'provider', error: response.error };
    } else {
      evidence.provider = response.metadata;
      if (args.purpose === 'coach') {
        const proposal = validateLearnerResponse(response.content, context);
        const advice = renderLearnerAdvice(proposal, context);
        evidence.validation = { accepted: true, stage: 'coach-contract' };
        evidence.coaching = { proposal, advice, learnerReview: 'pending' };
        evidence.accepted = true;
      } else {
        // Preserve a structurally valid generated candidate even when its
        // mathematical claims fail, clearly marking it as unaccepted.
        const proposal = validateAuthorResponse(response.content, { variableIds: input.variableIds });
        evidence.generatedProposal = proposal;
        const checked = verifyAuthoredProposal(proposal, { variableIds: input.variableIds });
        evidence.validation = checked.accepted
          ? { accepted: true, stage: 'author-contract-and-exact-proof' }
          : { accepted: false, stage: 'author-exact-proof', error: checked.error };
        if (checked.accepted) evidence.proof = checked.proof;
        evidence.accepted = checked.accepted;
      }
      if (evidence.accepted && attempts === 1 && httpResponseReceived && httpStatus >= 200 && httpStatus < 300) exitCode = 0;
      else if (evidence.accepted) fail('MISSING_LIVE_RECEIPT', 'Contract acceptance lacks a completed provider response.');
    }
  } catch (error) {
    evidence.accepted = false;
    evidence.validation = { accepted: false, stage: attempts ? 'response-contract' : 'preflight', error: safeFailure(error) };
    exitCode = attempts ? 1 : 2;
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.execution = { providerRequestsAttempted: attempts, httpResponseReceived,
    ...(httpStatus === undefined ? {} : { httpStatus }), retried: false, fallbackUsed: false };

  let serialized = JSON.stringify(evidence, null, 2) + '\n';
  const secret = typeof process.env.NEBIUS_API_KEY === 'string' ? process.env.NEBIUS_API_KEY.trim() : '';
  if (secret && serialized.includes(secret)) {
    // Reject, rather than silently alter, an evidence artifact containing the key.
    evidence.validation = { accepted: false, stage: 'evidence', error: { code: 'SENSITIVE_OUTPUT_REJECTED',
      message: 'The evidence contained credential material and was not retained. No retry was made.' } };
    serialized = JSON.stringify({ schema: evidence.schema, purpose: args.purpose, accepted: false,
      startedAt: evidence.startedAt, finishedAt: evidence.finishedAt, execution: evidence.execution,
      validation: evidence.validation }, null, 2) + '\n';
    evidence.accepted = false; exitCode = attempts ? 1 : 2;
  }
  try {
    await output.writeFile(serialized, 'utf8'); await output.sync();
  } catch {
    console.error(JSON.stringify({ accepted: false, providerRequestsAttempted: attempts,
      error: { code: 'EVIDENCE_WRITE_FAILED', message: 'The evidence could not be saved. Do not assume that no provider request occurred; no retry was made.' } }));
    return 1;
  } finally { await output.close(); }
  console.log(JSON.stringify({ accepted: evidence.accepted, purpose: args.purpose,
    providerRequestsAttempted: attempts, httpResponseReceived,
    validationStage: evidence.validation?.stage, evidenceSaved: true }));
  return exitCode;
}

process.exitCode = await main();
