import test from 'node:test';
import assert from 'node:assert/strict';
import { lampWorlds } from '../src/engine.js';
import { explainTrial } from '../src/trial-evidence.js';
const f = (n, d = 1) => ({ numerator: String(n), denominator: String(d) });
const hit = () => ({ intervention: { A: 1 }, outcome: { A: 1, B: 1 } });
const miss = () => ({ intervention: { A: 1 }, outcome: { A: 1, B: 0 } });
const passive = () => ({ intervention: {}, outcome: { A: 0, B: 0 } });
const rows = result => result.hypotheses.map(({ likelihood, beforeWeight, afterWeight }) => [likelihood, beforeWeight, afterWeight]);

test('first matching clamp is evidence, not certainty; repeat uses earlier posterior', () => {
  const worlds = lampWorlds(), history = [hit(), hit()];
  const first = explainTrial(worlds, history, 0), second = explainTrial(worlds, history, 1);
  assert.equal(first.status, 'ok');
  assert.deepEqual(rows(first), [[f(1), f(1, 2), f(2, 3)], [f(1, 2), f(1, 2), f(1, 3)]]);
  assert.deepEqual(rows(second), [[f(1), f(2, 3), f(4, 5)], [f(1, 2), f(1, 3), f(1, 5)]]);
  assert.deepEqual(first.hypotheses.map(row => row.worldId), ['A-causes-B', 'B-causes-A']);
  assert.deepEqual(first.event, hit());
});

test('a possible opposite result excludes one candidate exactly, preserving zero', () => {
  const result = explainTrial(lampWorlds(), [hit(), miss()], 1);
  assert.deepEqual(rows(result), [[f(0), f(2, 3), f(0)], [f(1, 2), f(1, 3), f(1)]]);
});

test('passive gaps count in original indexes and cannot reset learned weights', () => {
  const history = [passive(), hit(), passive(), hit()];
  assert.deepEqual(rows(explainTrial(lampWorlds(), history, 3)), [[f(1), f(2, 3), f(4, 5)], [f(1, 2), f(1, 3), f(1, 5)]]);
  assert.deepEqual(rows(explainTrial(lampWorlds(), history, 2)), [[f(1, 2), f(2, 3), f(2, 3)], [f(1, 2), f(1, 3), f(1, 3)]]);
});

test('earlier selection is unchanged by later contrary evidence', () => {
  assert.deepEqual(explainTrial(lampWorlds(), [hit()], 0), explainTrial(lampWorlds(), [hit(), miss()], 0));
});

test('unfamiliar noisy worlds use exact outcome likelihoods, not lamp labels', () => {
  const world = (id, table) => ({ schema: 'equivia.scm.v1', id, observed: ['X'], variables: [{ id: 'X', parents: [], noiseBits: 2, table }] });
  const worlds = [world('quarter', [0, 0, 0, 1]), world('threequarters', [0, 1, 1, 1])];
  const event = { intervention: {}, outcome: { X: 1 } };
  assert.deepEqual(rows(explainTrial(worlds, [event, event], 1)), [[f(1, 4), f(1, 4), f(1, 10)], [f(3, 4), f(3, 4), f(9, 10)]]);
});

test('impossible current result has undefined after weights, not asserted zero probabilities', () => {
  const impossible = { intervention: { A: 1 }, outcome: { A: 0, B: 0 } };
  const result = explainTrial(lampWorlds(), [impossible], 0);
  assert.equal(result.status, 'zero_evidence');
  assert.deepEqual(rows(result), [[f(0), f(1, 2), null], [f(0), f(1, 2), null]]);
  const later = explainTrial(lampWorlds(), [impossible, hit()], 1);
  assert.equal(later.status, 'zero_evidence');
  assert.deepEqual(rows(later), [[f(1), null, null], [f(1, 2), null, null]]);
});

test('invalid selection and malformed evidence are rejected', () => {
  for (const index of [-1, 1, 0.5, NaN, '0', null, undefined]) assert.throws(() => explainTrial(lampWorlds(), [hit()], index));
  for (const history of [null, {}, [], [null], [{}], [{ outcome: { A: 2 } }], [{ intervention: { unknown: 1 }, outcome: {} }]]) assert.throws(() => explainTrial(lampWorlds(), history, 0));
  assert.throws(() => explainTrial(lampWorlds(), Array.from({ length: 65 }, hit), 0));
});

test('explaining never mutates worlds or public history; results do not alias event inputs', () => {
  const worlds = lampWorlds(), history = [hit(), passive()], snapshot = JSON.stringify({ worlds, history });
  const result = explainTrial(worlds, history, 0);
  assert.equal(JSON.stringify({ worlds, history }), snapshot);
  result.event.intervention.A = 0;
  result.event.outcome.B = 0;
  assert.equal(JSON.stringify({ worlds, history }), snapshot);
});

test('full supplied history validates even after selected prefix; sparse input fails', () => {
  assert.throws(() => explainTrial(lampWorlds(), [hit(), { outcome: { A: 2 } }], 0));
  const sparse = [hit()]; sparse.length = 2;
  assert.throws(() => explainTrial(lampWorlds(), sparse, 0));
});

test('event details disclose only intervention and observation', () => {
  const enriched = { ...hit(), beforeSeed: 123, afterSeed: 456, activeWorldId: 'A-causes-B', prediction: 0.8 };
  assert.deepEqual(explainTrial(lampWorlds(), [enriched], 0).event, hit());
});
