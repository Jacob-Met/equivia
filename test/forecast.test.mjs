import test from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../src/forecast.js';

function world(id, root, child, noisy = false) {
  return {
    schema: 'equivia.scm.v1', id, label: id, observed: ['A', 'B'],
    variables: [
      { id: root, parents: [], noiseBits: 1, table: [0, 1] },
      { id: child, parents: [root], noiseBits: noisy ? 2 : 0,
        table: noisy ? [0, 0, 0, 1, 1, 1, 1, 0] : [0, 1] }
    ]
  };
}
function lamps() {
  return [world('forward', 'A', 'B'), world('reverse', 'B', 'A')];
}
function noisyWorlds() {
  return [world('forward', 'A', 'B', true), world('reverse', 'B', 'A', true)];
}
function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
function fraction(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  const g = gcd(n, d);
  return [n / g, d / g];
}
function add(a, b) {
  return fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
}
function multiply(a, b) {
  return fraction(a[0] * b[0], a[1] * b[1]);
}
function complement(a) { return fraction(a[1] - a[0], a[1]); }
function exact(n, d = 1) {
  const [numerator, denominator] = fraction(n, d);
  return { numerator: String(numerator), denominator: String(denominator) };
}
function encoded(f) { return exact(f[0], f[1]); }

// Independent oracle: enumerate complete binary sequences within each fixed
// world, then mix. No binomial formula and no calls to engine/forecast helpers.
function enumerate(weights, probabilities, trials) {
  const totals = Array.from({ length: trials + 1 }, () => fraction(0));
  for (let w = 0; w < weights.length; w++) {
    for (let mask = 0; mask < 2 ** trials; mask++) {
      let mass = weights[w];
      let successes = 0;
      for (let i = 0; i < trials; i++) {
        const success = (mask & (1 << i)) !== 0;
        if (success) successes++;
        mass = multiply(mass, success ? probabilities[w] : complement(probabilities[w]));
      }
      totals[successes] = add(totals[successes], mass);
    }
  }
  return totals.map((p, count) => ({ count, probability: encoded(p) }));
}
function check(result, observedVariable, trials, single, counts) {
  assert.equal(result.observedVariable, observedVariable);
  assert.equal(result.trials, trials);
  assert.deepEqual(result.singleTrialProbability, single);
  assert.deepEqual(result.counts, counts);
}
function handCounts(numerators, denominator) {
  return numerators.map((n, count) => ({ count, probability: exact(n, denominator) }));
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
const half = () => [fraction(1, 2), fraction(1, 2)];
const success = () => ({ intervention: { A: 1 }, outcome: { A: 1, B: 1 } });
const failure = () => ({ intervention: { A: 1 }, outcome: { A: 1, B: 0 } });

test('one hidden world is retained across every trial in a batch', () => {
  const worlds = lamps();
  for (const n of [1, 2, 3]) {
    check(forecast(worlds, [], { A: 1 }, n), 'B', n, exact(3, 4),
      enumerate(half(), [fraction(1), fraction(1, 2)], n));
  }
  const result = forecast(worlds, [], { A: 1 }, 3);
  assert.deepEqual(result.counts, handCounts([1, 3, 3, 9], 16));
  assert.deepEqual(result.counts[3].probability, exact(9, 16));
  assert.notDeepEqual(result.counts[3].probability, exact(27, 64));
});

test('authored noisy-copy worlds distinguish intervention from observation', () => {
  const worlds = noisyWorlds();
  for (const n of [1, 2, 3]) {
    check(forecast(worlds, [], { A: 1 }, n), 'B', n, exact(5, 8),
      enumerate(half(), [fraction(3, 4), fraction(1, 2)], n));
  }
  assert.deepEqual(forecast(worlds, [], { A: 1 }, 2).counts,
    handCounts([5, 14, 13], 32));
  assert.deepEqual(forecast(worlds, [], { A: 1 }, 3).counts,
    handCounts([9, 33, 51, 35], 128));
});

test('an explicit zero clamp reverses the noisy-copy count distribution', () => {
  const worlds = noisyWorlds();
  const on = forecast(worlds, [], { A: 1 }, 3);
  const off = forecast(worlds, [], { A: 0 }, 3);
  check(off, 'B', 3, exact(3, 8), handCounts([35, 51, 33, 9], 128));
  assert.deepEqual(off.counts.map(x => x.probability),
    on.counts.map(x => x.probability).reverse());
  assert.deepEqual(off.counts,
    enumerate(half(), [fraction(1, 4), fraction(1, 2)], 3));
});

test('clamping B forecasts A instead, with symmetric authored expectations', () => {
  const worlds = noisyWorlds();
  check(forecast(worlds, [], { B: 1 }, 3), 'A', 3, exact(5, 8),
    handCounts([9, 33, 51, 35], 128));
  check(forecast(worlds, [], { B: 0 }, 3), 'A', 3, exact(3, 8),
    handCounts([35, 51, 33, 9], 128));
});

test('observationally identical worlds retain equal posterior weights', () => {
  const history = [
    { intervention: {}, outcome: { A: 0, B: 0 } },
    { intervention: {}, outcome: { A: 0, B: 1 } },
    { intervention: {}, outcome: { A: 1, B: 0 } },
    { intervention: {}, outcome: { A: 1, B: 1 } },
    { intervention: {}, outcome: { A: 1, B: 1 } }
  ];
  assert.deepEqual(forecast(noisyWorlds(), history, { A: 1 }, 3),
    forecast(noisyWorlds(), [], { A: 1 }, 3));
});

test('interventional history supplies unequal posterior weights to the mixture', () => {
  const worlds = noisyWorlds();
  const afterSuccess = forecast(worlds, [success()], { A: 1 }, 3);
  check(afterSuccess, 'B', 3, exact(13, 20),
    enumerate([fraction(3, 5), fraction(2, 5)], [fraction(3, 4), fraction(1, 2)], 3));
  assert.deepEqual(afterSuccess.counts, handCounts([19, 75, 129, 97], 320));
  check(forecast(worlds, [failure()], { A: 1 }, 3), 'B', 3, exact(7, 12),
    enumerate([fraction(1, 3), fraction(2, 3)], [fraction(3, 4), fraction(1, 2)], 3));
  assert.deepEqual(forecast(worlds, [success(), success()], { A: 1 }, 1)
    .singleTrialProbability, exact(35, 52));
  assert.deepEqual(forecast(worlds, [success()], { A: 0 }, 1)
    .singleTrialProbability, exact(7, 20));
});

test('deterministic-world elimination and unequal weights are not discarded', () => {
  const worlds = lamps();
  assert.deepEqual(forecast(worlds, [success()], { A: 1 }, 1)
    .singleTrialProbability, exact(5, 6));
  check(forecast(worlds, [failure()], { A: 1 }, 3), 'B', 3, exact(1, 2),
    handCounts([1, 3, 3, 1], 8));
});

test('world ordering and arbitrary IDs do not change a conditioned forecast', () => {
  const worlds = noisyWorlds();
  const history = [success(), success(), failure()];
  const expected = forecast(worlds, history, { A: 1 }, 3);
  assert.deepEqual(forecast([...worlds].reverse(), history, { A: 1 }, 3), expected);
  const renamed = worlds.map((w, i) => ({ ...w, id: ['zeta', 'alpha'][i] }));
  assert.deepEqual(forecast(renamed.reverse(), history, { A: 1 }, 3), expected);
  // Likelihoods are 9/64 and 1/8, hence posterior weights 9/17 and 8/17.
  check(expected, 'B', 3, exact(43, 68),
    enumerate([fraction(9, 17), fraction(8, 17)], [fraction(3, 4), fraction(1, 2)], 3));
});

test('zero likelihood under every world is refused; empty history is valid', () => {
  assert.doesNotThrow(() => forecast(lamps(), [], { A: 1 }, 1));
  const impossible = [{ intervention: {}, outcome: { A: 0, B: 1 } }];
  assert.throws(() => forecast(lamps(), impossible, { A: 1 }, 3));
});

test('forecast is pure and before-run results do not become revised results', () => {
  const worlds = deepFreeze(noisyWorlds());
  const history = deepFreeze([]);
  const clamp = deepFreeze({ A: 1 });
  const original = JSON.stringify({ worlds, history, clamp });
  const before = forecast(worlds, history, clamp, 3);
  const savedBefore = JSON.stringify(before);
  const afterHistory = deepFreeze([success()]);
  const after = forecast(worlds, afterHistory, clamp, 1);
  assert.deepEqual(before.singleTrialProbability, exact(5, 8));
  assert.deepEqual(after.singleTrialProbability, exact(13, 20));
  assert.equal(JSON.stringify(before), savedBefore);
  assert.equal(JSON.stringify({ worlds, history, clamp }), original);
  assert.deepEqual(forecast(worlds, history, clamp, 3), before);
  // Only candidate worlds and public records are supplied: no active world,
  // hidden seed, user estimate, or generated outcomes are needed by this API.
  assert.deepEqual(Object.keys(afterHistory[0]).sort(), ['intervention', 'outcome']);
});

test('invalid batch sizes and clamps are refused without requiring error wording', () => {
  for (const count of [0, 4, -1, 1.5, NaN, Infinity, '2', null]) {
    assert.throws(() => forecast(lamps(), [], { A: 1 }, count));
  }
  for (const clamp of [null, [], {}, { A: 2 }, { A: -1 }, { A: '1' },
    { A: true }, { C: 1 }, { A: 1, B: 0 }]) {
    assert.throws(() => forecast(lamps(), [], clamp, 1));
  }
});

test('mixing p=0 and p=1 worlds retains only the two batch extremes', () => {
  const worlds = [0, 1].map(bit => ({
    schema: 'equivia.scm.v1',
    id: `constant-B-${bit}`,
    label: `B is ${bit}`,
    observed: ['A', 'B'],
    variables: [
      { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
      { id: 'B', parents: [], noiseBits: 0, table: [bit] }
    ]
  }));
  const result = forecast(worlds, [], { A: 1 }, 2);
  check(result, 'B', 2, exact(1, 2), handCounts([1, 0, 1], 2));
  assert.deepEqual(result.counts, enumerate(half(), [fraction(0), fraction(1)], 2));
  assert.notDeepEqual(result.counts, handCounts([1, 2, 1], 4));
});
