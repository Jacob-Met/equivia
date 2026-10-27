import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, compareWorlds, posterior, sample, lampWorlds, validateWorld, fractionToNumber, EquiviaError } from '../src/engine.js';

const f = (n, d = 1) => ({ numerator: String(n), denominator: String(d) });
const p = (dist, key) => dist.outcomes.find(row => row.key === key)?.probability;
const weight = (result, id) => result.hypotheses.find(h => h.worldId === id).probability;
const clone = value => JSON.parse(JSON.stringify(value));
const errorCode = code => error => error instanceof EquiviaError && error.code === code;
function commonCause() {
  return { schema: 'equivia.scm.v1', id: 'common-cause', observed: ['A', 'B'], variables: [
    { id: 'U', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'A', parents: ['U'], noiseBits: 0, table: [0, 1] },
    { id: 'B', parents: ['U'], noiseBits: 0, table: [0, 1] }
  ] };
}

test('lamp directions exactly agree observationally and separate under do(A=1)', () => {
  const worlds = lampWorlds();
  for (const w of worlds) {
    const dist = distribution(w);
    assert.deepEqual(dist.outcomes.map(row => row.probability), [f(1, 2), f(0), f(0), f(1, 2)]);
    assert.deepEqual(dist.evidence, f(1));
  }
  const observational = compareWorlds(worlds);
  assert.equal(observational.equivalent, true); assert.equal(observational.separates, false);
  const experimental = compareWorlds(worlds, { intervention: { A: 1 } });
  assert.equal(experimental.equivalent, false); assert.equal(experimental.separates, true);
  assert.deepEqual(experimental.pairs[0].totalVariation, f(1, 2));
  assert.deepEqual(p(experimental.distributions[0], '11'), f(1));
  assert.deepEqual(p(experimental.distributions[1], '10'), f(1, 2));
  assert.deepEqual(p(experimental.distributions[1], '11'), f(1, 2));
});

test('conditioning is not intervention and impossible conditioning stays undefined', () => {
  const [forward] = lampWorlds();
  const seen = distribution(forward, { condition: { B: 1 }, observed: ['A'] });
  const forced = distribution(forward, { intervention: { B: 1 }, observed: ['A'] });
  assert.deepEqual(p(seen, '1'), f(1)); assert.deepEqual(seen.evidence, f(1, 2));
  assert.deepEqual(p(forced, '1'), f(1, 2)); assert.deepEqual(forced.evidence, f(1));
  const impossible = distribution(forward, { intervention: { A: 1 }, condition: { A: 0 } });
  assert.equal(impossible.status, 'zero_evidence'); assert.deepEqual(impossible.outcomes, []); assert.deepEqual(impossible.evidence, f(0));
  const compare = compareWorlds(lampWorlds(), { intervention: { A: 1 }, condition: { A: 0 } });
  assert.equal(compare.equivalent, null); assert.equal(compare.separates, false); assert.equal(compare.pairs[0].relation, 'undefined');
});

test('a single matching experimental result remains inconclusive; a separating result eliminates a candidate', () => {
  const worlds = lampWorlds();
  const matching = posterior(worlds, [{ intervention: { A: 1 }, outcome: { A: 1, B: 1 } }]);
  assert.deepEqual(weight(matching, worlds[0].id), f(2, 3)); assert.deepEqual(weight(matching, worlds[1].id), f(1, 3));
  assert.deepEqual(matching.evidence, f(3, 4));
  const separating = posterior(worlds, [{ intervention: { A: 1 }, outcome: { A: 1, B: 0 } }]);
  assert.deepEqual(weight(separating, worlds[0].id), f(0)); assert.deepEqual(weight(separating, worlds[1].id), f(1));
  const ordinary = posterior(worlds, [{ outcome: { A: 1, B: 1 } }]);
  assert.deepEqual(ordinary.hypotheses.map(h => h.probability), [f(1, 2), f(1, 2)]);
});

test('posterior handles partial observations, sequential Bayes updates and weighted priors exactly', () => {
  const worlds = lampWorlds(), trial = { intervention: { A: 1 }, outcome: { B: 1 } };
  const first = posterior(worlds, [trial]);
  const incremental = posterior(worlds, [trial], { prior: Object.fromEntries(first.hypotheses.map(h => [h.worldId, h.probability])) });
  const combined = posterior(worlds, [trial, trial]);
  assert.deepEqual(incremental.hypotheses, combined.hypotheses);
  assert.deepEqual(combined.hypotheses.map(h => h.probability), [f(4, 5), f(1, 5)]);
  assert.deepEqual(combined.evidence, f(5, 8));
  assert.deepEqual(incremental.evidence, f(5, 6));
  const prior = { [worlds[0].id]: f(2), [worlds[1].id]: f(1) };
  assert.deepEqual(posterior(worlds, [], { prior }).hypotheses.map(h => h.probability), [f(2, 3), f(1, 3)]);
});

test('64 independent trial likelihoods retain exact fractions beyond Number precision', () => {
  const worlds = lampWorlds(), history = Array.from({ length: 64 }, () => ({ intervention: { A: 1 }, outcome: { A: 1, B: 1 } }));
  const result = posterior(worlds, history), power = 1n << 64n;
  assert.deepEqual(weight(result, worlds[0].id), f(power, power + 1n));
  assert.deepEqual(weight(result, worlds[1].id), f(1n, power + 1n));
  assert.deepEqual(result.evidence, f(power + 1n, power * 2n));
  assert.ok(Number.isFinite(fractionToNumber(weight(result, worlds[1].id))));
  const huge = 10n ** 400n;
  assert.equal(fractionToNumber(f(huge, huge * 2n)), 0.5);
  const grown = 10n ** 5000n;
  assert.ok(Math.abs(fractionToNumber(f(grown + 1n, grown * 2n + 3n)) - 0.5) < 1e-15);
});

test('normalization growth from large coprime priors supports bounded sequential reuse exactly', () => {
  const worlds = [...lampWorlds(), commonCause()];
  const a = 10n ** 150n + 1n, b = 10n ** 150n + 3n, c = 10n ** 150n + 7n;
  const prior = { [worlds[0].id]: f(1n, a), [worlds[1].id]: f(1n, b), [worlds[2].id]: f(1n, c) };
  const normalized = posterior(worlds, [], { prior });
  assert.ok(normalized.hypotheses.some(h => h.probability.denominator.length > 256));
  const reusable = Object.fromEntries(normalized.hypotheses.map(h => [h.worldId, h.probability]));
  const history = [{ intervention: { A: 1 }, outcome: { A: 1, B: 1 } }];
  const next = posterior(worlds, history, { prior: reusable });
  assert.deepEqual(next.hypotheses, posterior(worlds, history, { prior }).hypotheses);
  const expected = [2n * b * c, a * c, a * b], denominator = expected.reduce((sum, n) => sum + n, 0n);
  for (let i = 0; i < 3; i++) {
    const got = next.hypotheses[i].probability;
    assert.equal(BigInt(got.numerator) * denominator, expected[i] * BigInt(got.denominator));
  }
});

test('zero likelihood is explicit and later malformed history is still rejected', () => {
  const worlds = lampWorlds();
  const impossible = { intervention: { A: 1 }, outcome: { A: 0 } };
  const result = posterior(worlds, [{ outcome: { A: 1 } }, impossible]);
  assert.equal(result.status, 'zero_evidence'); assert.equal(result.firstImpossibleStep, 1);
  assert.deepEqual(result.evidence, f(0)); assert.deepEqual(result.hypotheses.map(h => h.probability), [f(0), f(0)]);
  assert.throws(() => posterior(worlds, [impossible, { outcome: { unknown: 1 } }]), errorCode('UNKNOWN_VARIABLE'));
});

test('hidden common cause is marginalized and never appears in default observations', () => {
  const confounded = commonCause(), [forward, reverse] = lampWorlds();
  const observational = compareWorlds([forward, reverse, confounded]);
  assert.equal(observational.equivalent, true);
  assert.ok(distribution(confounded).outcomes.every(row => !Object.hasOwn(row.values, 'U')));
  assert.equal(compareWorlds([reverse, confounded], { intervention: { A: 1 } }).equivalent, true);
  assert.equal(compareWorlds([reverse, confounded], { intervention: { B: 1 } }).separates, true);
  assert.throws(() => posterior([confounded], [{ outcome: { U: 1 } }]), errorCode('INVALID_HISTORY'));
  assert.deepEqual(distribution(confounded, { observed: [] }).outcomes, [{ key: '', values: {}, probability: f(1) }]);
});

test('parent order and local noise use the documented truth table bit order', () => {
  const world = { schema: 'equivia.scm.v1', id: 'bit-order', observed: ['A', 'B', 'C'], variables: [
    { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'C', parents: ['B', 'A'], noiseBits: 0, table: [0, 1, 0, 0] }
  ] };
  const dist = distribution(world);
  assert.deepEqual(p(dist, '101'), f(1, 4)); assert.deepEqual(p(dist, '111'), f(0));
  const noisy = { schema: 'equivia.scm.v1', id: 'xor', observed: ['A', 'C'], variables: [
    { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'C', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 0] }
  ] };
  assert.deepEqual(distribution(noisy).outcomes.map(row => row.probability), [f(1, 4), f(1, 4), f(1, 4), f(1, 4)]);
  const biased = { schema: 'equivia.scm.v1', id: 'quarter', observed: ['Q'], variables: [{ id: 'Q', parents: [], noiseBits: 2, table: [0, 0, 0, 1] }] };
  assert.deepEqual(p(distribution(biased), '1'), f(1, 4));
});

test('intervention replaces the target equation and propagates to descendants', () => {
  const world = { schema: 'equivia.scm.v1', id: 'chain', observed: ['A', 'B', 'C'], variables: [
    { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
    { id: 'C', parents: ['B'], noiseBits: 0, table: [0, 1] }
  ] };
  const dist = distribution(world, { intervention: { B: 0 } });
  assert.deepEqual(p(dist, '000'), f(1, 2)); assert.deepEqual(p(dist, '100'), f(1, 2));
  assert.deepEqual(p(distribution(world, { intervention: { A: 1, B: 0, C: 1 } }), '101'), f(1));
});

test('cycles, unknown references, acyclic invalid order and malformed tables are distinguished', () => {
  const base = lampWorlds()[0];
  const unknown = clone(base); unknown.variables[1].parents = ['Z'];
  assert.throws(() => validateWorld(unknown), errorCode('UNKNOWN_VARIABLE'));
  const cycle = clone(base); cycle.variables[0].parents = ['B']; cycle.variables[0].table = [0, 1, 0, 1];
  assert.throws(() => validateWorld(cycle), errorCode('CYCLE'));
  const order = clone(base); order.variables.reverse();
  assert.throws(() => validateWorld(order), errorCode('INVALID_ORDER'));
  const table = clone(base); table.variables[1].table = [0, 1, 0];
  assert.throws(() => validateWorld(table), errorCode('INVALID_TABLE'));
  const boolean = clone(base); boolean.variables[0].table = [false, true];
  assert.throws(() => validateWorld(boolean), errorCode('INVALID_TABLE'));
  const sparse = clone(base); sparse.variables[0].table = new Array(2); sparse.variables[0].table[0] = 0;
  assert.throws(() => validateWorld(sparse), errorCode('INVALID_TABLE'));
});

test('bounded enumeration admits 12 bits and rejects invalid hypothesis, history and prior inputs', () => {
  const boundary = { schema: 'equivia.scm.v1', id: 'boundary', observed: ['X0'], variables: Array.from({ length: 12 }, (_, i) => ({ id: `X${i}`, parents: [], noiseBits: 1, table: [0, 1] })) };
  assert.equal(validateWorld(boundary).noiseAssignments, 4096); assert.deepEqual(p(distribution(boundary), '1'), f(1, 2));
  const overflow = clone(boundary); overflow.variables[0].noiseBits = 2; overflow.variables[0].table = [0, 1, 0, 1];
  assert.throws(() => validateWorld(overflow), errorCode('LIMIT_EXCEEDED'));
  const worlds = lampWorlds();
  assert.throws(() => compareWorlds([worlds[0], worlds[0]]), errorCode('INVALID_WORLD_IDS'));
  const hidden = clone(worlds[1]); hidden.observed = ['A'];
  assert.throws(() => compareWorlds([worlds[0], hidden]), errorCode('INCONSISTENT_OBSERVED'));
  assert.throws(() => posterior(worlds, Array(65).fill({ outcome: {} })), errorCode('INVALID_HISTORY'));
  assert.throws(() => posterior(worlds, [], { prior: { [worlds[0].id]: f(0), [worlds[1].id]: f(0) } }), errorCode('INVALID_PRIOR'));
  assert.throws(() => posterior(worlds, [], { prior: { [worlds[0].id]: f('1'.repeat(4097)), [worlds[1].id]: f(1) } }), errorCode('INVALID_PRIOR'));
  const sparseWorlds = new Array(2); sparseWorlds[0] = worlds[0];
  assert.throws(() => compareWorlds(sparseWorlds), errorCode('INVALID_SCHEMA'));
  assert.throws(() => distribution(worlds[0], { intervention: { A: true } }), errorCode('INVALID_ASSIGNMENT'));
});

test('sampling is seeded, stays in exact support and does not mutate a world', () => {
  const worlds = lampWorlds(), original = JSON.stringify(worlds), options = { seed: 123456, intervention: { A: 1 } };
  assert.deepEqual(sample(worlds[1], options), sample(worlds[1], options));
  let seed = 0;
  for (let i = 0; i < 20; i++) {
    const draw = sample(worlds[1], { seed, intervention: { A: 1 } });
    assert.equal(draw.outcome.A, 1); assert.ok(draw.outcome.B === 0 || draw.outcome.B === 1); seed = draw.nextSeed;
  }
  assert.deepEqual(sample(worlds[0], options).outcome, { A: 1, B: 1 });
  assert.equal(sample(worlds[0], options).nextSeed, sample(worlds[0], { seed: options.seed }).nextSeed);
  assert.equal(JSON.stringify(worlds), original);
  assert.throws(() => sample(worlds[0], { seed: -1 }), errorCode('INVALID_SEED'));
  assert.throws(() => sample(worlds[0], { seed: 1, condition: { A: 1 } }), errorCode('INVALID_OPTIONS'));
});
