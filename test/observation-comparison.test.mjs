import test from 'node:test';
import assert from 'node:assert/strict';
import { lampWorlds } from '../src/engine.js';
import { compareObservation } from '../src/observation-comparison.js';

const exact = (n, d = 1) => ({ numerator: String(n), denominator: String(d) });
const chance = (result, bit) => result.outcomes.find(outcome => Object.values(outcome.values)[0] === bit).probability;
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('watching both directions selects matching lamps; holding only changes descendants', () => {
  for (const world of lampWorlds()) {
    const root = world.variables[0].id;
    for (const selected of ['A', 'B']) for (const value of [0, 1]) {
      const result = compareObservation(world, { [selected]: value });
      assert.equal(result.worldId, world.id);
      assert.equal(result.selectedVariable, selected);
      assert.equal(result.selectedValue, value);
      assert.equal(result.observedVariable, selected === 'A' ? 'B' : 'A');
      assert.equal(result.watched.status, 'ok');
      assert.deepEqual(result.watched.evidence, exact(1, 2));
      assert.deepEqual(chance(result.watched, value), exact(1));
      assert.deepEqual(chance(result.watched, 1 - value), exact(0));
      assert.deepEqual(chance(result.held, value), selected === root ? exact(1) : exact(1, 2));
      assert.deepEqual(chance(result.held, 1 - value), selected === root ? exact(0) : exact(1, 2));
      assert.deepEqual(result.held.evidence, exact(1));
    }
  }
});

test('hidden common cause gives selection certainty but no clamp effect on the other lamp', () => {
  const world = { schema: 'equivia.scm.v1', id: 'common-cause', observed: ['A', 'B'], variables: [
    { id: 'U', parents: [], noiseBits: 2, table: [0, 0, 0, 1] },
    { id: 'A', parents: ['U'], noiseBits: 0, table: [0, 1] },
    { id: 'B', parents: ['U'], noiseBits: 0, table: [0, 1] },
  ] };
  for (const selected of ['A', 'B']) for (const value of [0, 1]) {
    const result = compareObservation(world, { [selected]: value });
    assert.deepEqual(result.watched.evidence, value ? exact(1, 4) : exact(3, 4));
    assert.deepEqual(chance(result.watched, value), exact(1));
    assert.deepEqual(chance(result.held, 1), exact(1, 4));
    assert.deepEqual(chance(result.held, 0), exact(3, 4));
  }
});

test('an impossible natural selection stays undefined while a clamp remains meaningful', () => {
  const world = { schema: 'equivia.scm.v1', id: 'always-off', observed: ['A', 'B'], variables: [
    { id: 'A', parents: [], noiseBits: 0, table: [0] },
    { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
  ] };
  const result = compareObservation(world, { A: 1 });
  assert.deepEqual(result.watched, { status: 'zero_evidence', observed: ['B'], outcomes: [], evidence: exact(0) });
  assert.equal(result.held.status, 'ok');
  assert.deepEqual(chance(result.held, 1), exact(1));
  assert.deepEqual(chance(result.held, 0), exact(0));
});

test('comparison accepts frozen inputs and returns no aliases into their definitions', () => {
  const world = freeze(lampWorlds()[0]), clamp = freeze({ A: 1 });
  const before = JSON.stringify({ world, clamp });
  const result = compareObservation(world, clamp);
  result.watched.observed[0] = 'changed';
  result.held.outcomes[0].values.B = 99;
  assert.equal(JSON.stringify({ world, clamp }), before);
  assert.deepEqual(chance(compareObservation(world, clamp).held, 1), exact(1));
});

test('invalid or hidden selections cannot silently become observation or intervention', () => {
  const world = lampWorlds()[0];
  for (const clamp of [undefined, null, [], {}, { A: 1, B: 0 }, { A: true }, { A: '1' }, { A: 2 }, { U: 1 }, new Date()]) {
    assert.throws(() => compareObservation(world, clamp), TypeError);
  }
  assert.throws(() => compareObservation({ ...world, observed: ['A'] }, { A: 1 }), TypeError);
});
