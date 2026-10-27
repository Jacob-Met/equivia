# EQUIVIA model integration contract

This document describes the implemented model boundary, its operation, and the evidence needed before claiming that a live provider path works. The local causal laboratory, exact calculations, notebook, and deterministic verification remain useful when model assistance is unavailable.

The implementation lives in `src/model.js`, `src/provider.js`, and `server.mjs`. The exact finite-SCM semantics live in `src/engine.js`. The application persists investigations through `src/session.js`; model responses do not directly replace a session.

## Current acceptance boundary

At this checkpoint, the lead has reported actual brokered execution passing **48 integrated tests, 53 independent mathematical checks, and 16 browser journeys**. These results establish the tested local behavior. Model and HTTP tests use explicitly identified stub responses where a provider response is needed.

**No live Nebius response has been qualified.** The checked coordinator environment lacks the necessary key/model configuration, and no working existing authorized provider route has been established. A configured flag, a stub response, a passing exact proof, or a polished browser flow must not be described as a live-provider receipt. Durable execution and access records belong in `WORK.md` and the owner's access-tracking record.

The retained worker's last fully read operating prompt is version `2026-10-27.10`. A referenced version 11 refresh was blocked by an original-owner routing error; this document does not claim that version was read.

## Two distinct model roles

### Learner coaching

The model interprets the learner's actual explanation and selects a useful question focus. It must quote the learner accurately, select a permitted experiment, and cite known calculation facts. The interpretation is explicitly tentative: the learner can reject a misreading and continue the investigation.

The model does not calculate the displayed probabilities. The deterministic engine calculates them from the public candidate worlds. Restricting the output structure reduces unsupported assertions, but it does **not** guarantee that the model has understood the learner correctly or chosen the best pedagogical question.

The current session adapter sends the declared candidate IDs as `currentHypotheses`. This is not a separate self-reported confidence vector. The learner's own reasoning is supplied in `explanation`; conditional candidate weights are engine calculations.

### World authoring

The model generates actual finite structural equations as truth tables, two candidate worlds, and a proposed separating intervention. This is a generative task, not selection from the first lesson's templates.

The application accepts a proposed pair only after the engine independently proves both claims:

1. The full observational joint distributions are exactly equal.
2. The proposed intervention produces different joint distributions.

An accepted proof applies to the supplied finite models and their assumptions. It does not establish a causal mechanism in the outside world. The user reviews the proposal and explicitly opens it as a new investigation; a model response does not silently replace the current notebook.

## Configuration and availability

`providerStatus(env)` returns only:

```json
{
  "provider": "nebius",
  "configured": false,
  "model": null,
  "baseUrl": "https://api.tokenfactory.us-central1.nebius.com/v1/"
}
```

The actual values depend on the supplied environment object. No key or raw environment object is returned.

| Input | Implemented behavior |
| --- | --- |
| `NEBIUS_API_KEY` | Required. Supplied by an already authorized runtime or adapter; never discovered, created, or stored by this module. |
| `NEBIUS_MODEL` | Required and explicit. There is no automatic model selection. |
| `NEBIUS_BASE_URL` | Optional. Defaults to the verified US Central endpoint above. |
| Accepted base hosts | `api.tokenfactory.us-central1.nebius.com` and `api.tokenfactory.nebius.com`, using HTTPS and `/v1` or `/v1/`. |
| Rejected base forms | Other hosts, HTTP, user information, queries, fragments, unsupported paths, and nondefault ports. |

The lead's verified current Nebius cookbook identifies `nvidia/nemotron-3-super-120b-a12b` and the US Central endpoint. The identifier is documented in the source, but **the operator must still supply `NEBIUS_MODEL` explicitly**. This documentation does not establish account entitlement or permission to spend.

`configured: true` means that the required values are present and syntactically accepted. It does not prove that the key works, the account can use the model, the route is reachable, or a request has succeeded.

| State | User-visible and operational meaning |
| --- | --- |
| Missing or invalid configuration | `MODEL_UNAVAILABLE`; no provider request is dispatched and no model reply is invented. |
| Configured but not yet exercised | Optional assistance may be offered, but the provider path remains unqualified. |
| Network or HTTP failure | A safe failure response; the investigation remains unchanged. |
| Complete provider response, invalid domain proposal | The response is rejected by the coaching or authoring validator; it is not accepted as advice or a replacement puzzle. |
| Complete provider response and valid domain proposal | The server can return accepted advice or an independently verified authoring proposal, together with safe provider metadata. |

## HTTP and module interfaces

The server exposes `GET /api/config`, `POST /api/coach`, and `POST /api/author`. It binds its CLI listener to loopback. The server owns request-body limits, local Host/Origin checks, and the shared in-flight model guard. The provider module owns only the outbound provider request.

### Coaching request

`buildLearnerContext(input)` accepts:

```js
{
  worlds,                    // Public candidate SCMs, not a selected hidden world.
  experiments: [
    { id, label, intervention: { A: 1 } }
  ],
  history: [
    { intervention: {}, outcome: { A: 1, B: 1 } }
  ],
  explanation,
  currentHypotheses: [worldId]
}
```

`label` is optional on an experiment. The input has no `activeWorldId`, hidden-world identity, random seed, or caller-supplied facts field. Unknown fields are rejected. The session adapter deliberately omits hidden identity and replay state.

The helper validates 2–8 candidate worlds, 2–4 observed variables, 1–8 permitted nonempty interventions, and at most 64 history records. History must use permitted variables and clamps; an outcome cannot contradict an enforced value. It also evaluates the history under the supplied candidates. A history with zero likelihood under every candidate produces **`IMPOSSIBLE_EVIDENCE`**, distinct from ordinary uncertainty. It does not cause a reset, invented prior, or automatic normalization to uniform weights.

The helper computes an observational comparison and each permitted intervention comparison. Fact IDs are:

- `observational`
- `experiment:<experiment-id>`

The resulting immutable context is registered within the module. `makeLearnerRequest` requires such a freshly built context; a deserialized or forged object cannot substitute asserted probabilities for engine calculations.

The server's normal pipeline is:

```js
const context = buildLearnerContext(body);
const request = makeLearnerRequest(context, { model: config.model });
const response = await callNemotron({ ...request, purpose: 'coach' }, { env });
// On failure, return the safe failure without changing learner state.
const proposal = validateLearnerResponse(response.content, context);
const advice = renderLearnerAdvice(proposal, context);
```

A valid model coaching response has exactly these fields:

```json
{
  "schema": "equivia.coach.v1",
  "interpretation": "correlation_direction",
  "learnerQuote": "an exact substring of the learner's explanation",
  "question": "predict_before_clamp",
  "experimentId": "a-permitted-experiment-id",
  "factIds": ["observational", "experiment:a-permitted-experiment-id"]
}
```

The interpretation and question values must belong to the exported schema's enumerations. The quotation must be an exact, nonempty substring of the actual explanation, up to 180 characters; it may be empty only when the explanation is empty. The selected experiment must be permitted, every cited fact must exist, and the fact for that experiment must be cited. Arbitrary factual prose, invented facts, a hidden-world guess, and extra fields are rejected.

`renderLearnerAdvice` returns a reviewable interpretation with its quotation and rejection prompt, a trusted question, the permitted experiment, and the cited engine facts. Numerical assertions should be rendered from those facts or recomputed from the same engine inputs. The browser should reject stale responses if the investigation changed while a request was pending.

### Authoring request and acceptance

The authoring endpoint accepts:

```js
{ brief: 'A creative description of a causal puzzle', variableIds: ['A', 'B'] }
```

The current lamp UI requests `['A', 'B']`. The helper supports 2–4 requested observed IDs. Its current contract uses exactly those variables, all observed; it does not accept an additional latent shared-cause variable.

`makeAuthorRequest(body, { model })` describes the finite-SCM encoding and requests:

```js
{
  schema: 'equivia.author.v1',
  title,
  worlds: [world1, world2],
  experiment: { intervention: { A: 1 } }
}
```

Each world uses `equivia.scm.v1`. Variables appear in topological order and contain `id`, `parents`, `noiseBits`, and a binary `table`. The table index reads listed parent values most significant first, followed by independent uniform private noise bits. A deliberate clamp replaces the target equation rather than conditioning on its output.

Authoring bounds are 0–3 noise bits and at most 3 parents per variable, with at most 64 table cells. Table lengths and references must also satisfy the engine. Both worlds must use precisely the requested observed variable IDs, in the requested observed order, and have distinct world IDs.

The server's normal pipeline is:

```js
const request = makeAuthorRequest(body, { model: config.model });
const response = await callNemotron({ ...request, purpose: 'author' }, { env });
// On failure, return the safe failure without replacing the current puzzle.
const checked = verifyAuthoredProposal(response.content, {
  variableIds: body.variableIds
});
```

`verifyAuthoredProposal` returns either:

```js
{ accepted: true, proposal, proof: { observational, interventional } }
```

or:

```js
{ accepted: false, error: { code, message } }
```

Rejected results contain no accepted replacement proposal. The acceptance proof includes the engine's exact distributions, pair comparison, and separating witness. Titles, labels, or model assertions are never accepted as mathematical evidence. Browser-side verification runs again before a proposal is offered for adoption or import.

The original first lesson remains the noiseless matching-lamps pair. Some individual intervention outcomes leave both candidates possible; others exclude a candidate within the stipulated model set. The separate noisy pair used in authoring tests demonstrates additional accepted structures and does not replace that first lesson.

## Provider transport contract

`callNemotron({ model, messages, purpose }, { env, fetchImpl })` accepts only the configured model, exactly one system message followed by one user message, and purpose `coach` or `author`. It does not accept arbitrary endpoint overrides, provider options, tools, or an unbounded token request from the browser.

The implemented request uses:

- A 45-second abort deadline and no retries.
- `temperature: 0.2`, `stream: false`.
- Fixed `max_tokens` ceilings: 1,200 for coaching and 4,096 for authoring.
- A 64 KiB provider response limit, enforced while reading the body.
- Redirect rejection and the approved endpoint restriction.

There are no invented model-specific reasoning or structured-output flags. The response schema is explained in the request and enforced locally afterward. A reasoning model may exhaust the token budget before producing usable JSON; `finish_reason: length` is reported as `PROVIDER_TRUNCATED`, not converted into success or silently retried. Any future flag or budget change requires current provider documentation and the owner's access/cost authority.

The transport requires a complete assistant message with `finish_reason: stop`; it rejects refusals, tool/function calls, malformed provider envelopes, and unsupported message content. Domain validators then reject malformed JSON, unknown fields, unsafe properties, unsupported quotations or facts, and invalid SCM proposals.

Success returns:

```js
{
  ok: true,
  content,                  // Assistant content; still needs domain validation.
  metadata: {
    provider: 'nebius',
    model,
    usage,                  // Optional validated numeric token counts.
    requestId               // Optional safe provider request identifier.
  }
}
```

Failure returns `{ ok: false, error: { code, message } }`, with no fabricated assistant content. Raw provider error bodies, exceptions, request headers, and credentials are not returned. The server attaches success metadata to authoring output only when the deterministic proposal check accepts it. A transport success by itself is not world-authoring acceptance.

## Supplying an existing authorized configuration

An approved service or adapter can supply an in-memory environment object to `createServer({ env })` or to the provider helper. It need not write a key into a repository, `.env` file, notebook, test fixture, command argument, log, screenshot, or package.

For example, the integration boundary can receive an object already supplied by an authorized runtime:

```js
import { createServer } from './server.mjs';

export function startAuthorizedLocalServer(existingAuthorizedConfiguration) {
  const server = createServer({ env: existingAuthorizedConfiguration });
  server.listen(4192, '127.0.0.1');
  return server;
}
```

This is an integration example, not an authorization grant or an implemented credential-retrieval route. The existing configuration must carry the required key and explicit model. Do not print or serialize it. A read-only account/session permission does not automatically authorize inference spending, new credentials, persistent access, or deployment changes.

Injecting `fetchImpl` is useful for deterministic tests. A test adapter must remain labeled as a stub; its response metadata cannot be repurposed as a live-provider receipt.

## Bounded live-provider acceptance procedure

Only perform this procedure when an existing route owner has authorized the specific inference calls and their spending boundary. No such qualified route is claimed at this checkpoint.

### Ready consumer for an authorized existing process

`tools/live-model-check.mjs` performs **one selected provider request at most per invocation**. It requires `--purpose`, `--input`, and `--output`; there is no default live request. It uses the existing process environment and does not accept a credential argument, fetch stub, automatic retry, or fallback mode.

After the existing route owner has authorized the use of its quota, run one selected path:

```sh
node tools/live-model-check.mjs --purpose author --input /approved/path/author-request.json --output /approved/path/author-evidence.json
```

For coaching, select `--purpose coach` and provide a JSON file matching the coaching input documented above. Author input is the ordinary `{ "brief": "...", "variableIds": ["A", "B"] }` object. Both commands still require the existing process to carry an authorized `NEBIUS_API_KEY` and explicit `NEBIUS_MODEL`; the command is not permission to obtain credentials or spend quota.

Two ready input files are included under `docs/examples/`:

- `coach-request.json` supplies the original public matching-lamps worlds, the four permitted clamps, and a **stipulated example history and learner explanation**. The shared result after holding A on remains possible under both candidates. It contains no selected hidden-world identity or replay seed. The model should quote this explanation accurately and propose a grounded, reviewable question; there is no single required interpretation label, and a learner may reject a misreading.
- `author-request.json` asks for a noisy two-lamp follow-on pair. It contains a creative brief, not an expected output or a preaccepted fixture. A returned pair still requires exact observational-equivalence and intervention-separation checks.

An authorized owner can substitute `--input docs/examples/coach-request.json` or `--input docs/examples/author-request.json` in the command. Each invocation needs its own new evidence filename and remains limited to the selected request. Using these examples qualifies behavior on these example inputs; it does not turn the stipulated history into a real learner's recorded session.

The evidence filename must be new, and its parent directory must already be writable. The tool reserves that file before any provider attempt. Missing configuration or invalid input fails before dispatch. An attempted call is never automatically repeated, including when evidence writing fails.

The JSON evidence records the input's SHA-256 digest, safe configuration, actual available provider/model/usage/request metadata, request bounds, whether an HTTP response was received, and domain validation. Accepted authoring includes the actual generated worlds and exact proof. A structurally valid but mathematically rejected candidate is retained with its rejection clearly marked. Accepted coaching includes its exact quotation, reviewable interpretation, permitted experiment, and engine facts; `learnerReview: "pending"` explicitly means no human acceptance is claimed.

Exit status `0` requires both a completed provider response and deterministic contract acceptance. Exit `1` indicates an attempted request that did not achieve acceptance, or an evidence-writing failure. Exit `2` indicates a preflight failure without a provider attempt. A saved evidence file is not itself proof of success: inspect its `accepted`, `execution`, and `validation` fields. The script also rejects an evidence artifact containing the configured key rather than persisting credential material.

This consumer has been drafted as a ready interface for the existing auth owner. Its presence in the repository does not mean that it has been run against Nebius or that a live route has been qualified.

1. **Confirm the existing route and scope.** Record the authorized owner and route, explicit model, approved endpoint, and permitted invocation count or cost boundary. Use an existing session or in-process configuration. Do not create credentials or persist access as part of this check.
2. **Inspect safe status.** Verify `providerStatus` reports the intended model and approved base URL. Record only that metadata. Treat `configured: true` as configuration evidence, not connectivity evidence.
3. **Exercise coaching within the authorized budget.** Submit a real learner explanation, public candidates, and valid recorded history through the normal `/api/coach` path. Verify the exact quotation, permitted experiment, linked engine facts, tentative interpretation, and learner rejection action. Confirm no actual hidden-world identity or replay seed was sent.
4. **Exercise actual authoring within the authorized budget.** Submit a creative brief through `/api/author`. Inspect the returned SCM equations. Count it as accepted authoring only if the local verifier proves observational equality and intervention separation, and the independently verified proposal can be reviewed before explicit adoption. A stored fixture or stub cannot substitute for this generation step.
5. **Record a sanitized receipt.** Keep the model, endpoint host, available request ID and numeric usage, outcome code, and deterministic proof or rejection reason. For an accepted authoring result, retain the generated public world pair and its proof. Keep all credentials, authorization headers, and raw provider error bodies out of artifacts.
6. **Stop on the bounded outcome.** If the response is truncated, refused, unavailable, or invalid, record that result and preserve the current investigation. Do not retry automatically, enlarge budgets, add speculative reasoning flags, or replace the result with a local imitation. Qualification remains incomplete until the specific missing condition is resolved through an authorized route.

Passing both live paths would establish those observed transactions, not a universal success rate or an absolute guarantee about future coaching interpretations. Record the exact conditions rather than generalizing beyond them.

## What verification establishes

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Exact engine checks | Finite-SCM enumeration, equality/difference results, and the tested causal semantics. | Real-world causal truth or an unmodeled mechanism. |
| Model-contract tests | Bounded schemas, accurate quotation checks, known fact/experiment references, unsafe-input rejection, and deterministic authoring acceptance/rejection. | That a live model will produce valid or pedagogically useful output. |
| Stub transport tests | Request limits, safe configuration handling, failure behavior, metadata handling, and response validation for supplied cases. | Network access, key validity, model entitlement, spending authority, or live inference. |
| Actual local HTTP tests | The tested server entrypoints, local address/origin controls, body bounds, busy guard, unavailable states, and stub-backed end-to-end validation. | A live Nebius transaction. |
| Browser journeys | The tested user flows, state preservation, review/rejection/adoption behavior, and observed browser rendering. | Live provider qualification unless a separately evidenced real request was used. |
| Extracted-package tests and CLI smoke | The shipped files can be extracted, checked, tested, and started independently with model credentials removed. | An externally deployed or live-provider-enabled service. |

## Portable package and operational notes

`tools/package.mjs` includes the explicit EQUIVIA runtime files: `server.mjs`, `package.json`, the three public assets, and `src/engine.js`, `src/model.js`, `src/provider.js`, and `src/session.js`. It also includes optional README/license/example-configuration files and regular files under `docs`, `test`, `review`, and `tools`.

The package tool writes archive and per-file SHA-256 manifests, extracts into a separate temporary directory, checks each packaged file, runs packaged Node test files, and starts the extracted CLI for HTTP smoke verification. Nebius key/model/base settings are removed from those verification subprocesses. The runtime requires no third-party Node packages; the packaging step uses the system `tar` utility.

Place this document in the integrated repository's `docs/` directory **before** creating the archive so the package includes it. Package success must be taken from the actual execution result, not merely from the presence of an archive or checksum file.
