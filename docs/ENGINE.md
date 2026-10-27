# EQUIVIA exact binary causal engine

Browser/Node ESM with no dependencies: `src/engine.js`.

This is a bounded experiment-design teaching model. It compares **authored candidate mechanisms**; it does not discover a real-world causal graph or identify a physical truth. A posterior is a weight within the supplied hypothesis set and prior. The hidden mechanism remains fixed across trials; private exogenous noise is freshly sampled independently for every trial. Each intervention acts on that trial only.

## First experiment: two matching lamps

`lampWorlds()` returns two mechanisms with a fair binary root:

- `A-causes-B`: `A = U`, `B = A`.
- `B-causes-A`: `B = U`, `A = B`.

Ordinary observations have the same distribution in both: `P(00)=1/2`, `P(11)=1/2`. Under `do(A=1)`, the first mechanism always produces `11`; the second produces `10` and `11` with probability `1/2` each. Thus the **distributions** separate, while one observed `11` remains inconclusive. With equal priors, that result gives weights `2/3` and `1/3`, not certainty. Observing `10` eliminates the first candidate within these idealized hypotheses.

## Authored world schema

```json
{
  "schema": "equivia.scm.v1",
  "id": "A-causes-B",
  "label": "A drives B",
  "observed": ["A", "B"],
  "variables": [
    {"id":"A", "parents":[], "noiseBits":1, "table":[0,1]},
    {"id":"B", "parents":["A"], "noiseBits":0, "table":[0,1]}
  ]
}
```

All endogenous variables are binary. Each variable owns `noiseBits` independent fair bits; noise sources are independent across nodes. Shared causes must be authored as explicit variables, which may be hidden by omitting them from `observed`.

The truth-table index concatenates **parent values in the listed order, most significant bit first, followed by the node's local noise bits**. With parent `A` and one noise bit, `[0,1,1,0]` means `A XOR noise`. Two noise bits with `[0,0,0,1]` produce `1` with probability `1/4`. Zero parents and zero noise require a one-cell constant table.

Variables must be declared in topological order. Validation identifies a genuine directed cycle separately from an acyclic graph declared out of order. IDs begin with a letter and contain at most64 letters, digits, underscores or hyphens. Numeric `0` and `1` are accepted; Boolean substitutes are rejected. Caller inputs are never mutated.

Limits are explicit:1–12 variables,0–4 private noise bits per variable, at most12 noise bits in total (4096 exact assignments), and at most12 combined parent/noise input bits per table (4096 cells). Candidate collections contain1–8 uniquely identified worlds with the same observed-variable set. Observation order may differ across worlds; comparisons normalize it to the first world's order. Hidden-variable sets may differ. The optional `observed` query override is an explicit author/analysis operation, not a learner permission boundary.

## Exact probabilities

Every public fraction is a reduced JSON-safe pair of decimal strings:

```json
{"numerator":"1","denominator":"2"}
```

All arithmetic, posterior products and scientific equality checks use BigInt integers. `fractionToNumber(fraction)` provides an approximate display conversion only. Its rounding or underflow must never determine equivalence or elimination. Display the exact fraction when precision matters.

## Exports

### `validateWorld(world)`

Throws `EquiviaError` on invalid input. Returns `{valid:true, variableCount, totalNoiseBits, noiseAssignments, observed}` on success. It does not clone or rewrite the model.

### `distribution(world, options = {})`

Options: `{intervention?: {A:1}, observed?: ['A','B'], condition?: {B:1}}`.

An intervention **replaces the target's entire equation**, including its original parent/noise dependence. Descendants use the forced value. Conditioning instead filters the distribution obtained under the chosen intervention. For `A→B`, observing `B=1` implies `A=1`, while forcing `B=1` leaves `A` fair.

Return shape:

```json
{
  "status":"ok",
  "observed":["A","B"],
  "outcomes":[{"key":"00","values":{"A":0,"B":0},"probability":{"numerator":"1","denominator":"2"}}],
  "evidence":{"numerator":"1","denominator":"1"}
}
```

The actual `outcomes` array includes every binary row, including zero-probability rows, in binary lexicographic order of `observed`. `evidence` is the probability of the conditioning event under the intervention, before conditional normalization. With no condition it is1. Impossible conditioning returns `{status:'zero_evidence', observed, outcomes:[], evidence:0/1}`; it never fabricates a conditional distribution. Observing no variables returns one row with key`''`, values`{}`, probability1 when evidence is possible.

### `compareWorlds(worlds, options = {})`

Accepts the same distribution options. Returns `{status, observed, equivalent, separates, pairs, distributions}`. Each distribution includes `worldId`. Each pair is:

```json
{
  "left":"A-causes-B", "right":"B-causes-A",
  "relation":"separated",
  "totalVariation":{"numerator":"1","denominator":"2"},
  "witness":{
    "outcome":{"A":1,"B":0},
    "leftProbability":{"numerator":"0","denominator":"1"},
    "rightProbability":{"numerator":"1","denominator":"2"}
  }
}
```

Relations are `equal`, `separated`, or `undefined`. Equal pairs have total variation0 and no witness. Impossible conditioning gives undefined affected pairs with null distance/witness; if any queried distribution is undefined, overall `equivalent` is null and status is`zero_evidence`. `separates` means at least one well-defined pair differs; it does not mean every pair differs or that one outcome reveals the world. A single supplied world is vacuously equivalent to itself; an authoring exercise requiring ambiguity must additionally require at least two candidates.

### `posterior(worlds, history = [], {prior} = {})`

History contains at most64 ordered, independent trials: `{intervention?:{A:1}, outcome:{A:1,B:1}}`. A missing intervention represents ordinary observation. Partial outcomes are marginalized over unrecorded variables; recording a hidden variable is rejected. An empty outcome conveys no information. Earlier interventions do not persist into later trials.

Optional `prior` maps **every** world ID to a nonnegative fraction. Weights are normalized before use; all-zero priors are rejected. Fraction terms have at most4096 decimal digits. The default prior is uniform. This explicit input-size bound does not promise closure under arbitrarily many successive normalizations: a computed exact fraction may eventually exceed it. The application recomputes from its original equal prior and at most64 recorded trials, avoiding unbounded sequential state growth. Bounded reuse of normalized large priors is tested without rounding.

Return: `{status, trialCount, firstImpossibleStep, evidence, hypotheses:[{worldId,probability}]}`. `evidence` is the joint marginal probability of the entire ordered history under the original normalized prior. It is not the likelihood of just the final trial. `firstImpossibleStep` is null or the zero-based index where all weighted hypotheses first became impossible. In that case status is`zero_evidence`, evidence is0, and every returned hypothesis weight is0; no arbitrary uniform reset is made. Even after impossible evidence, later records are validated.

### `sample(world, {seed, intervention, observed})`

Requires an explicit unsigned32-bit integer seed. Returns `{outcome,nextSeed}`; it does not expose the selected noise assignment. A full-period uint32 linear-congruential step (`1664525*seed+1013904223 mod 2^32`) advances once per trial; the upper declared-noise bits select a complete noise assignment. All declared noise bits participate even when an intervention makes some irrelevant, so an intervention does not silently change random-number consumption. Zero-noise worlds still advance the seed.

Sampling is deterministic and replayable, not cryptographically secure. Exact probabilities come from enumeration, not Monte Carlo frequency estimates. `sample` rejects conditioning; conditional mathematics belongs to `distribution`. Learner-facing code must advance and store `nextSeed` after every trial and keep actual hidden-world identity outside model prompts.

## Validation errors

`EquiviaError.code` distinguishes `INVALID_SCHEMA`, `INVALID_VARIABLE`, `UNKNOWN_VARIABLE`, `CYCLE`, `INVALID_ORDER`, `INVALID_TABLE`, `INVALID_OBSERVED`, `INVALID_ASSIGNMENT`, `INVALID_OPTIONS`, `INVALID_WORLD_IDS`, `INCONSISTENT_OBSERVED`, `INVALID_PRIOR`, `INVALID_FRACTION`, `INVALID_HISTORY`, `INVALID_SEED`, and `LIMIT_EXCEEDED`. These are invalid requests, distinct from valid but impossible evidence.

## Verification

`node --test test/*.test.js` covers the hand-derived lamp distributions, conditioning versus intervention, inconclusive single outcomes, partial observations, sequential posterior updates,64-trial exact arithmetic, impossible evidence, hidden common causes, truth-table order, intervention propagation, graph errors, finite limits, and deterministic sampling. Execution is delegated to the authorized Renpō broker; this staging author has not run code locally. Independently authored review cases are kept outside this implementation directory.
