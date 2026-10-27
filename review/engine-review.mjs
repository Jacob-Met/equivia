/** Independent EQUIVIA exact-probability evaluator. Prepared, not executed locally.
 * EQUIVIA_ENGINE_MODULE=/absolute/path/src/engine.js node review/engine-review.mjs OUTPUT_DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { expectedDistribution, WORLDS } from './oracle.mjs';

const engineUrl = process.env.EQUIVIA_ENGINE_MODULE
  ? pathToFileURL(path.resolve(process.env.EQUIVIA_ENGINE_MODULE))
  : new URL('../src/engine.js', import.meta.url);
const engine = await import(engineUrl.href);
const outputDirectory = path.resolve(process.argv[2] || 'review-output');
fs.mkdirSync(outputDirectory, { recursive: true });
const results = [];
const clone = x => JSON.parse(JSON.stringify(x));
const F = (n, d = 1) => ({ numerator: String(n), denominator: String(d) });
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function fractionEqual(actual, numerator, denominator = 1) {
  assert.equal(typeof actual?.numerator, 'string', 'numerator must retain exact integer text');
  assert.equal(typeof actual?.denominator, 'string', 'denominator must retain exact integer text');
  assert.match(actual.numerator, /^(0|[1-9]\d*)$/);
  assert.match(actual.denominator, /^[1-9]\d*$/);
  const n = BigInt(actual.numerator), d = BigInt(actual.denominator);
  assert.equal(gcd(n, d), 1n, 'fractions must be canonically reduced');
  assert.ok(n <= d, 'probability must not exceed one');
  assert.equal(n * BigInt(denominator), BigInt(numerator) * d, 'exact probability differs from independent oracle');
}
function sumFractions(values) {
  let n = 0n, d = 1n;
  for (const value of values) {
    const q = BigInt(value.denominator), p = BigInt(value.numerator);
    n = n * q + p * d; d *= q;
    const divisor = gcd(n, d); n /= divisor; d /= divisor;
  }
  return F(n, d);
}
function exactNumber(probability, value) {
  if (value === 0) fractionEqual(probability, 0);
  else if (value === 0.5) fractionEqual(probability, 1, 2);
  else if (value === 1) fractionEqual(probability, 1);
  else throw new Error('The independent table uses only 0, 1/2, and 1.');
}
function check(name, operation) {
  try { const evidence = operation(); results.push({ name, passed: true, evidence: evidence ?? null }); }
  catch (error) { results.push({ name, passed: false, error: { name: error.name, message: error.message, code: error.code ?? null, stack: error.stack } }); }
}
function rejection(operation) {
  try { operation(); } catch (error) {
    assert.equal(error.name, 'EquiviaError');
    assert.ok(typeof error.code === 'string' && error.code.length > 0, 'validation failures need a stable error code');
    return error.code;
  }
  assert.fail('invalid or over-budget input was accepted');
}

// These SCMs are authored here from the mathematical definition. No engine demos
// or engine-generated worlds are used to construct the independent references.
const root = id => ({ id, parents: [], noiseBits: 1, table: [0, 1] });
const copy = (id, parent) => ({ id, parents: [parent], noiseBits: 0, table: [0, 1] });
const forward = { schema: 'equivia.scm.v1', id: WORLDS[0], variables: [root('A'), copy('B', 'A')], observed: ['A', 'B'] };
const reverse = { schema: 'equivia.scm.v1', id: WORLDS[1], variables: [root('B'), copy('A', 'B')], observed: ['A', 'B'] };
const confounded = { schema: 'equivia.scm.v1', id: WORLDS[2], variables: [root('U'), copy('A', 'U'), copy('B', 'U')], observed: ['A', 'B'] };
const pair = [forward, reverse], trio = [forward, reverse, confounded];
const interventions = [{}, { A: 0 }, { A: 1 }, { B: 0 }, { B: 1 }, { A: 0, B: 0 }, { A: 0, B: 1 }, { A: 1, B: 0 }, { A: 1, B: 1 }];
const tableEvidence = [];

check('all independent fixtures validate without mutation', () => {
  const before = JSON.stringify(trio);
  for (const world of trio) engine.validateWorld(world);
  assert.equal(JSON.stringify(trio), before);
});

for (const world of trio) for (const intervention of interventions) {
  check(`${world.id}: exact law after ${JSON.stringify(intervention)}`, () => {
    const actual = engine.distribution(world, { intervention, observed: ['A', 'B'] });
    assert.equal(actual.status, 'ok'); assert.deepEqual(actual.observed, ['A', 'B']);
    assert.equal(actual.outcomes.length, 4, 'include every visible binary outcome, including zero probabilities');
    assert.equal(new Set(actual.outcomes.map(o => o.key)).size, 4);
    const expected = expectedDistribution(world.id, intervention);
    for (const key of ['00', '01', '10', '11']) {
      const outcome = actual.outcomes.find(o => o.key === key);
      assert.ok(outcome, `missing outcome ${key}`);
      assert.deepEqual(outcome.values, { A: Number(key[0]), B: Number(key[1]) });
      exactNumber(outcome.probability, expected[key]);
    }
    fractionEqual(sumFractions(actual.outcomes.map(o => o.probability)), 1);
    fractionEqual(actual.evidence, 1);
    tableEvidence.push({ world: world.id, intervention, distribution: actual });
    return { intervention, expected };
  });
}

check('observational equality includes the hidden common cause', () => {
  const actual = engine.compareWorlds(trio, { observed: ['A', 'B'] });
  assert.equal(actual.status, 'ok'); assert.equal(actual.equivalent, true); assert.equal(actual.separates, false);
  assert.equal(actual.pairs.length, 3);
  for (const comparison of actual.pairs) { assert.equal(comparison.relation, 'equal'); fractionEqual(comparison.totalVariation, 0); }
  return actual;
});

check('single clamp separates directions with total variation one half', () => {
  const actual = engine.compareWorlds(pair, { intervention: { A: 1 }, observed: ['A', 'B'] });
  assert.equal(actual.equivalent, false); assert.equal(actual.separates, true);
  assert.equal(actual.pairs[0].relation, 'separated'); fractionEqual(actual.pairs[0].totalVariation, 1, 2);
  return actual;
});

check('clamping both lamps supplies no direction evidence', () => {
  const actual = engine.compareWorlds(trio, { intervention: { A: 1, B: 0 }, observed: ['A', 'B'] });
  assert.equal(actual.equivalent, true); assert.equal(actual.separates, false);
  for (const comparison of actual.pairs) fractionEqual(comparison.totalVariation, 0);
});

check('conditioning on A=1 is different from doing A=1', () => {
  for (const world of trio) {
    const conditioned = engine.distribution(world, { observed: ['A', 'B'], condition: { A: 1 } });
    assert.equal(conditioned.status, 'ok'); fractionEqual(conditioned.evidence, 1, 2);
    for (const outcome of conditioned.outcomes) fractionEqual(outcome.probability, outcome.key === '11' ? 1 : 0);
  }
  const intervened = engine.distribution(reverse, { intervention: { A: 1 }, observed: ['A', 'B'] });
  fractionEqual(intervened.outcomes.find(o => o.key === '10').probability, 1, 2);
});

check('impossible conditioning is explicit, not a uniform law', () => {
  const actual = engine.distribution(forward, { condition: { A: 0, B: 1 } });
  assert.equal(actual.status, 'zero_evidence'); fractionEqual(actual.evidence, 0); assert.deepEqual(actual.outcomes, []);
  const contradiction = engine.distribution(forward, { intervention: { A: 1 }, condition: { A: 0 } });
  assert.equal(contradiction.status, 'zero_evidence'); assert.deepEqual(contradiction.outcomes, []);
  return actual;
});

check('undefined conditional comparison is not declared equivalent', () => {
  const actual = engine.compareWorlds(pair, { condition: { A: 0, B: 1 } });
  assert.equal(actual.equivalent, null); assert.equal(actual.separates, false);
  assert.equal(actual.pairs[0].relation, 'undefined');
  return actual;
});

function hypothesis(result, id) { const h = result.hypotheses.find(h => h.worldId === id); assert.ok(h); return h.probability; }
const trial11 = { intervention: { A: 1 }, outcome: { A: 1, B: 1 } };
check('one matching outcome remains inconclusive', () => {
  const actual = engine.posterior(pair, [trial11]);
  assert.equal(actual.status, 'ok'); fractionEqual(hypothesis(actual, forward.id), 2, 3); fractionEqual(hypothesis(actual, reverse.id), 1, 3);
  fractionEqual(actual.evidence, 3, 4); assert.equal(actual.firstImpossibleStep, null);
  return actual;
});

check('a separating outcome eliminates only its inconsistent candidate', () => {
  const actual = engine.posterior(pair, [{ intervention: { A: 1 }, outcome: { A: 1, B: 0 } }]);
  assert.equal(actual.status, 'ok'); fractionEqual(hypothesis(actual, forward.id), 0); fractionEqual(hypothesis(actual, reverse.id), 1);
  fractionEqual(actual.evidence, 1, 4);
  return actual;
});

check('passive observations cannot resolve these directions', () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ intervention: {}, outcome: { A: i % 2, B: i % 2 } }));
  const actual = engine.posterior(pair, history);
  fractionEqual(hypothesis(actual, forward.id), 1, 2); fractionEqual(hypothesis(actual, reverse.id), 1, 2);
  fractionEqual(actual.evidence, 1, 4096);
});

check('all 64 inconclusive trials retain exact nonzero alternative weight', () => {
  const actual = engine.posterior(pair, Array.from({ length: 64 }, () => clone(trial11)));
  const power = 1n << 64n;
  fractionEqual(hypothesis(actual, forward.id), power, power + 1n);
  fractionEqual(hypothesis(actual, reverse.id), 1n, power + 1n);
  assert.notEqual(hypothesis(actual, forward.id).denominator, '1');
  return actual;
});

check('impossible trial retains a distinct zero-evidence result', () => {
  const history = [trial11, { intervention: { A: 1 }, outcome: { A: 0, B: 0 } }, trial11];
  const actual = engine.posterior(pair, history);
  assert.equal(actual.status, 'zero_evidence'); fractionEqual(actual.evidence, 0);
  assert.equal(actual.firstImpossibleStep, 1);
  for (const h of actual.hypotheses) fractionEqual(h.probability, 0);
  return actual;
});

check('zero prior support is not repaired by inventing new prior mass', () => {
  const actual = engine.posterior(pair, [{ intervention: { A: 1 }, outcome: { A: 1, B: 0 } }],
    { prior: { [forward.id]: F(1), [reverse.id]: F(0) } });
  assert.equal(actual.status, 'zero_evidence'); fractionEqual(actual.evidence, 0);
  assert.equal(actual.firstImpossibleStep, 0);
});

check('hidden common cause survives a single directional falsifier', () => {
  const actual = engine.posterior(trio, [{ intervention: { A: 1 }, outcome: { A: 1, B: 0 } }]);
  fractionEqual(hypothesis(actual, forward.id), 0); fractionEqual(hypothesis(actual, reverse.id), 1, 2); fractionEqual(hypothesis(actual, confounded.id), 1, 2);
  return actual;
});

check('two complementary interventions isolate the stipulated common cause', () => {
  const actual = engine.posterior(trio, [
    { intervention: { A: 1 }, outcome: { A: 1, B: 0 } },
    { intervention: { B: 1 }, outcome: { A: 0, B: 1 } },
  ]);
  fractionEqual(hypothesis(actual, forward.id), 0); fractionEqual(hypothesis(actual, reverse.id), 0); fractionEqual(hypothesis(actual, confounded.id), 1);
  fractionEqual(actual.evidence, 1, 12);
  return actual;
});

check('sequential updates equal one batch update exactly', () => {
  const history = [trial11, { intervention: { B: 0 }, outcome: { A: 0, B: 0 } }, trial11,
    { intervention: {}, outcome: { A: 1, B: 1 } }];
  const batch = engine.posterior(trio, history);
  let prior;
  for (const trial of history) {
    const updated = engine.posterior(trio, [trial], prior ? { prior } : {});
    assert.equal(updated.status, 'ok'); prior = Object.fromEntries(updated.hypotheses.map(h => [h.worldId, h.probability]));
  }
  for (const h of batch.hypotheses) assert.deepEqual(h.probability, prior[h.worldId]);
  const reordered = engine.posterior(trio, [...history].reverse());
  for (const h of batch.hypotheses) assert.deepEqual(h.probability, hypothesis(reordered, h.worldId));
  assert.deepEqual(batch.evidence, reordered.evidence);
  return batch;
});

check('accepted authored priors remain reusable after exact normalization growth', () => {
  const scale = 10n ** 150n;
  const [a, b, c] = [scale + 1n, scale + 3n, scale + 7n];
  const prior = { [forward.id]: F(1, a), [reverse.id]: F(1, b), [confounded.id]: F(1, c) };
  const initial = engine.posterior(trio, [], { prior });
  assert.equal(initial.status, 'ok');
  assert.ok(initial.hypotheses.some(h => h.probability.denominator.length > 256), 'the fixture must exercise normalization beyond the authored-term limit');
  const normalizedPrior = Object.fromEntries(initial.hypotheses.map(h => [h.worldId, h.probability]));
  const sequential = engine.posterior(trio, [trial11], { prior: normalizedPrior });
  const batch = engine.posterior(trio, [trial11], { prior });
  const common = 2n * b * c + a * c + a * b;
  fractionEqual(hypothesis(sequential, forward.id), 2n * b * c, common);
  fractionEqual(hypothesis(sequential, reverse.id), a * c, common);
  fractionEqual(hypothesis(sequential, confounded.id), a * b, common);
  for (const h of sequential.hypotheses) assert.deepEqual(h.probability, hypothesis(batch, h.worldId));
  return { authoredDenominatorDigits: String(a).length,
    normalizedDenominatorDigits: initial.hypotheses.map(h => h.probability.denominator.length),
    note: 'Bounded exact state reuse; no claim of unlimited sequential closure.' };
});

check('partial outcome observation marginalizes unobserved lamps', () => {
  const actual = engine.posterior(pair, [{ intervention: { A: 1 }, outcome: { A: 1 } }]);
  fractionEqual(hypothesis(actual, forward.id), 1, 2); fractionEqual(hypothesis(actual, reverse.id), 1, 2);
  fractionEqual(actual.evidence, 1);
});

check('truth-table parent and noise indices use the declared MSB order', () => {
  const asymmetric = { schema: 'equivia.scm.v1', id: 'asymmetric', observed: ['A', 'B', 'C'],
    variables: [root('A'), root('B'), { id: 'C', parents: ['A', 'B'], noiseBits: 0, table: [0, 0, 1, 0] }] };
  const law = engine.distribution(asymmetric);
  for (const outcome of law.outcomes) fractionEqual(outcome.probability, ['000', '010', '101', '110'].includes(outcome.key) ? 1 : 0, 4);
  const noisy = { schema: 'equivia.scm.v1', id: 'parent-then-noise', observed: ['A', 'C'],
    variables: [root('A'), { id: 'C', parents: ['A'], noiseBits: 1, table: [0, 1, 0, 0] }] };
  const second = engine.distribution(noisy);
  const expected = { '00': F(1, 4), '01': F(1, 4), '10': F(1, 2), '11': F(0) };
  for (const outcome of second.outcomes) assert.deepEqual(outcome.probability, expected[outcome.key]);
});

check('sampling respects clamps, support, replay, and advances the seed', () => {
  const initial = { seed: 123456789, intervention: { A: 1 }, observed: ['A', 'B'] };
  assert.deepEqual(engine.sample(reverse, initial), engine.sample(reverse, initial));
  let seed = initial.seed; const seen = new Set();
  for (let i = 0; i < 64; i++) {
    const sampled = engine.sample(reverse, { ...initial, seed });
    assert.equal(sampled.outcome.A, 1); assert.ok([0, 1].includes(sampled.outcome.B));
    assert.ok(Number.isInteger(sampled.nextSeed) && sampled.nextSeed >= 0 && sampled.nextSeed <= 0xffffffff);
    seen.add(`${sampled.outcome.A}${sampled.outcome.B}`); seed = sampled.nextSeed;
  }
  assert.deepEqual([...seen].sort(), ['10', '11']);
  for (const seed of [0, 1, 2, 12345, 0xffffffff]) assert.deepEqual(engine.sample(forward, { ...initial, seed }).outcome, { A: 1, B: 1 });
  return { observedSupport: [...seen].sort(), note: 'Deterministic replay/support check, not a statistical randomness claim.' };
});

check('cycle, unknown parent, and invalid ordering fail distinctly', () => {
  const cycle = clone(forward); cycle.variables[0] = copy('A', 'B');
  const unknown = clone(forward); unknown.variables[1].parents = ['missing'];
  const outOfOrder = clone(forward); outOfOrder.variables.reverse();
  const codes = [cycle, unknown, outOfOrder].map(w => rejection(() => engine.validateWorld(w)));
  assert.equal(new Set(codes).size, 3); return { codes };
});

check('malformed world definitions reject before enumeration', () => {
  const malformed = [];
  let w = clone(forward); w.variables[1].id = 'A'; malformed.push(w);
  w = clone(forward); w.variables[1].table = [0]; malformed.push(w);
  w = clone(forward); w.variables[1].table = [0, 2]; malformed.push(w);
  w = clone(forward); w.variables[1].noiseBits = -1; malformed.push(w);
  w = clone(forward); w.variables[0].table = Array(2); malformed.push(w);
  w = clone(forward); w.observed = ['A', 'A']; malformed.push(w);
  w = clone(forward); w.observed = ['missing']; malformed.push(w);
  return { codes: malformed.map(world => rejection(() => engine.validateWorld(world))) };
});

check('bad interventions and observations do not coerce binary values', () => {
  const calls = [
    () => engine.distribution(forward, { intervention: { A: '1' } }),
    () => engine.distribution(forward, { intervention: { A: 2 } }),
    () => engine.distribution(forward, { intervention: { unknown: 1 } }),
    () => engine.distribution(forward, { condition: { unknown: 0 } }),
    () => engine.posterior(pair, [{ intervention: {}, outcome: { A: Number.NaN } }]),
  ];
  return { codes: calls.map(rejection) };
});

check('world, variable, noise and history limits reject oversized work', () => {
  const manyWorlds = Array.from({ length: 9 }, (_, i) => ({ ...clone(forward), id: `world-${i}` }));
  const manyVariables = { schema: 'equivia.scm.v1', id: 'too-many-vars', observed: ['V0'], variables: Array.from({ length: 13 }, (_, i) => ({ id: `V${i}`, parents: [], noiseBits: 0, table: [0] })) };
  const manyNoise = { schema: 'equivia.scm.v1', id: 'too-much-noise', observed: ['N0'], variables: Array.from({ length: 4 }, (_, i) => ({ id: `N${i}`, parents: [], noiseBits: 4, table: Array(16).fill(0) })) };
  const oversizedTable = { schema: 'equivia.scm.v1', id: 'too-wide-table', observed: ['C'],
    variables: [...Array.from({ length: 11 }, (_, i) => ({ id: `P${i}`, parents: [], noiseBits: 0, table: [0] })),
      { id: 'C', parents: Array.from({ length: 11 }, (_, i) => `P${i}`), noiseBits: 2, table: Array(8192).fill(0) }] };
  const calls = [() => engine.posterior(manyWorlds, []), () => engine.validateWorld(manyVariables),
    () => engine.validateWorld(manyNoise), () => engine.validateWorld(oversizedTable),
    () => engine.posterior(pair, Array.from({ length: 65 }, () => trial11))];
  return { codes: calls.map(rejection) };
});

check('hidden state cannot be smuggled in as a learner observation', () => {
  const code = rejection(() => engine.posterior(trio, [{ intervention: {}, outcome: { U: 1 } }]));
  return { code };
});

check('mismatched candidates and invalid priors fail explicitly', () => {
  const mismatch = clone(reverse); mismatch.observed = ['A'];
  const calls = [
    () => engine.posterior([forward, { ...clone(reverse), id: forward.id }], []),
    () => engine.compareWorlds([forward, mismatch]),
    () => engine.posterior(pair, [], { prior: { [forward.id]: F(0), [reverse.id]: F(0) } }),
    () => engine.posterior(pair, [], { prior: { [forward.id]: F(-1), [reverse.id]: F(2) } }),
    () => engine.posterior(pair, [], { prior: { [forward.id]: F(1, 0), [reverse.id]: F(1) } }),
  ];
  return { codes: calls.map(rejection) };
});

const report = { evaluator: 'EQUIVIA independent exact-probability review v1', executed: true,
  generatedAt: new Date().toISOString(), engine: engineUrl.href, total: results.length,
  passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results,
  limits: 'Finite stipulated binary SCMs; this is neither universal causal identification nor evidence of any model-provider runtime.' };
fs.writeFileSync(path.join(outputDirectory, 'independent-results.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outputDirectory, 'independent-tables.json'), JSON.stringify(tableEvidence, null, 2));
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed,
  failures: results.filter(r => !r.passed).map(r => ({ name: r.name, error: r.error.message })), outputDirectory }, null, 2));
process.exitCode = report.failed ? 1 : 0;
