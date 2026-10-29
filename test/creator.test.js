import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, buildProposal, checkDraft, draftFromProposal } from '../src/creator.js';
import { distribution } from '../src/engine.js';
import { verifyAuthoredProposal } from '../src/model.js';

// Numerical expectations were independently derived before this adapter existed.
const CLAMPS = { A0: { A: 0 }, A1: { A: 1 }, B0: { B: 0 }, B1: { B: 1 } };
const ALL = [{}, ...Object.values(CLAMPS), { A: 0, B: 0 }, { A: 0, B: 1 }, { A: 1, B: 0 }, { A: 1, B: 1 }];
const keys = ['00', '01', '10', '11'];
const fraction = text => { const [numerator, denominator = '1'] = text.split('/'); return { numerator, denominator }; };
function draft({ rootOn = 4, childOff = 0, childOn = 8, clamp = 'A1' } = {}) {
  return { ...createDraft(), title: 'Independent creator reference pair', clamp, worlds: [
    { id: 'forward', label: 'Forward', order: 'AB', rootOn, childOff, childOn },
    { id: 'reverse', label: 'Reverse', order: 'BA', rootOn, childOff, childOn },
  ] };
}
function assertDistribution(world, intervention, expected) {
  const result = distribution(world, { observed: ['A', 'B'], intervention });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.observed, ['A', 'B']);
  assert.deepEqual(result.evidence, fraction('1'));
  assert.deepEqual(result.outcomes.map(row => row.key), keys);
  for (const row of result.outcomes) {
    assert.deepEqual(row.values, { A: Number(row.key[0]), B: Number(row.key[1]) });
    assert.deepEqual(row.probability, fraction(expected[row.key] ?? '0'), row.key + ' under ' + JSON.stringify(intervention));
  }
}
function refused(value) {
  const result = checkDraft(value);
  assert.equal(result.accepted, false);
  assert.equal(typeof result.error?.code, 'string'); assert.ok(result.error.code);
  assert.equal(typeof result.error?.message, 'string'); assert.ok(result.error.message);
  return result;
}
function descriptiveError(action, code) {
  assert.throws(action, error => {
    assert.ok(error instanceof Error);
    assert.equal(typeof error.code, 'string'); assert.ok(error.code); assert.ok(error.message);
    if (code) assert.equal(error.code, code);
    return true;
  });
}
function rawPair(deterministicRoot = false) {
  const root = deterministicRoot ? [0, 0] : [0, 1];
  return { schema: 'equivia.author.v1', title: 'Existing one-bit authored pair', worlds: [
    { schema: 'equivia.scm.v1', id: 'original-forward', label: 'Original forward', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 1, table: [...root] },
      { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] },
    ] },
    { schema: 'equivia.scm.v1', id: 'original-reverse', label: 'Original reverse', observed: ['A', 'B'], variables: [
      { id: 'B', parents: [], noiseBits: 1, table: [...root] },
      { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] },
    ] },
  ], experiment: { intervention: { A: 1 } } };
}
function roundtrip(original) {
  const before = structuredClone(original);
  assert.equal(verifyAuthoredProposal(original, { variableIds: ['A', 'B'] }).accepted, true);
  const reopened = draftFromProposal(JSON.stringify(original));
  assert.deepEqual(original, before);
  assert.equal(reopened.title, original.title);
  assert.equal(reopened.clamp, 'A1');
  assert.deepEqual(reopened.worlds.map(({ id, label }) => ({ id, label })), original.worlds.map(({ id, label }) => ({ id, label })));
  const rebuilt = buildProposal(reopened);
  assert.equal(checkDraft(reopened).accepted, true);
  assert.deepEqual(rebuilt.experiment, original.experiment);
  for (let index = 0; index < 2; index++) {
    for (const intervention of ALL) assert.deepEqual(
      distribution(rebuilt.worlds[index], { observed: ['A', 'B'], intervention }),
      distribution(original.worlds[index], { observed: ['A', 'B'], intervention }),
      'World ' + index + ' changed under ' + JSON.stringify(intervention),
    );
  }
  return { reopened, rebuilt };
}

test('noiseless opposite directions share observations but separate under A1', () => {
  const input = draft(), result = checkDraft(input);
  assert.equal(result.accepted, true); assert.equal(result.checked.accepted, true);
  assert.deepEqual(result.proposal, buildProposal(input));
  assert.equal(result.proposal.schema, 'equivia.author.v1');
  assert.deepEqual(result.proposal.experiment.intervention, { A: 1 });
  for (const world of result.proposal.worlds) assertDistribution(world, {}, { '00': '1/2', '11': '1/2' });
  assertDistribution(result.proposal.worlds[0], { A: 1 }, { '11': '1' });
  assertDistribution(result.proposal.worlds[1], { A: 1 }, { '10': '1/2', '11': '1/2' });
});

test('noisy pair matches independent exact observation and all four clamp tables', () => {
  const input = draft({ childOff: 2, childOn: 6 }), result = checkDraft(input);
  assert.equal(result.accepted, true);
  for (const world of result.proposal.worlds) assertDistribution(world, {}, { '00': '3/8', '01': '1/8', '10': '1/8', '11': '3/8' });
  const expected = {
    A0: [{ '00': '3/4', '01': '1/4' }, { '00': '1/2', '01': '1/2' }],
    A1: [{ '10': '1/4', '11': '3/4' }, { '10': '1/2', '11': '1/2' }],
    B0: [{ '00': '1/2', '10': '1/2' }, { '00': '3/4', '10': '1/4' }],
    B1: [{ '01': '1/2', '11': '1/2' }, { '01': '1/4', '11': '3/4' }],
  };
  for (const [key, intervention] of Object.entries(CLAMPS)) {
    for (let index = 0; index < 2; index++) assertDistribution(result.proposal.worlds[index], intervention, expected[key][index]);
    const selected = checkDraft({ ...input, clamp: key });
    assert.equal(selected.accepted, true, key);
    assert.equal(selected.checked.accepted, true);
    assert.deepEqual(selected.proposal.experiment.intervention, intervention);
  }
  assert.deepEqual(result.clamps.map(item => item.key).sort(), Object.keys(CLAMPS).sort());
  for (const item of result.clamps) { assert.deepEqual(item.intervention, CLAMPS[item.key]); assert.equal(item.comparison.separates, true); }
});

test('different root frequencies fail observational equality', () => {
  const input = draft(); input.worlds[1].rootOn = 2;
  const result = refused(input);
  assert.equal(result.checked.accepted, false); assert.equal(result.observational.equivalent, false); assert.equal(result.clamps.length, 4);
  assertDistribution(result.proposal.worlds[0], {}, { '00': '1/2', '11': '1/2' });
  assertDistribution(result.proposal.worlds[1], {}, { '00': '3/4', '11': '1/4' });
});

test('correlation versus anticorrelation fails observational equality', () => {
  const input = draft(); input.worlds[1].childOff = 8; input.worlds[1].childOn = 0;
  const result = refused(input);
  assert.equal(result.checked.accepted, false);
  assertDistribution(result.proposal.worlds[0], {}, { '00': '1/2', '11': '1/2' });
  assertDistribution(result.proposal.worlds[1], {}, { '01': '1/2', '10': '1/2' });
});

test('equal same-order mechanisms have no separating supported clamp', () => {
  const input = draft(); input.worlds[1].order = 'AB';
  for (const clamp of Object.keys(CLAMPS)) {
    const result = refused({ ...input, clamp });
    assert.equal(result.observational.equivalent, true);
    for (const item of result.clamps) assert.equal(item.comparison.separates, false);
    for (const intervention of ALL) assert.deepEqual(
      distribution(result.proposal.worlds[0], { observed: ['A', 'B'], intervention }),
      distribution(result.proposal.worlds[1], { observed: ['A', 'B'], intervention }),
    );
  }
});

test('invalid counts are refused individually without rounding or defaults', () => {
  for (const index of [0, 1]) for (const field of ['rootOn', 'childOff', 'childOn']) {
    for (const value of [NaN, Infinity, -Infinity, 2.5, -1, 9, '4', null]) {
      const input = draft(); input.worlds[index][field] = value;
      const before = structuredClone(input);
      refused(input); descriptiveError(() => buildProposal(input));
      assert.deepEqual(input, before);
    }
  }
});

test('one-bit authored rules reopen with all nine intervention distributions intact', () => {
  roundtrip(rawPair());
});

test('naturally unobserved parent rows survive reopening', () => {
  const { rebuilt } = roundtrip(rawPair(true));
  for (const world of rebuilt.worlds) assertDistribution(world, {}, { '00': '1' });
  assertDistribution(rebuilt.worlds[0], { A: 1 }, { '11': '1' });
  assertDistribution(rebuilt.worlds[1], { A: 1 }, { '10': '1' });
  assertDistribution(rebuilt.worlds[0], { B: 1 }, { '01': '1' });
  assertDistribution(rebuilt.worlds[1], { B: 1 }, { '11': '1' });
});

test('a parentless second variable uses the entire table for both parent states', () => {
  const original = { schema: 'equivia.author.v1', title: 'Independent mechanism', worlds: [
    { schema: 'equivia.scm.v1', id: 'independent', label: 'Independent fair B', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 0, table: [0] },
      { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
    ] },
    { schema: 'equivia.scm.v1', id: 'dependent', label: 'B responds to A', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 0, table: [0] },
      { id: 'B', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 1] },
    ] },
  ], experiment: { intervention: { A: 1 } } };
  const { reopened, rebuilt } = roundtrip(original);
  assert.equal(reopened.worlds[0].rootOn, 0);
  assert.equal(reopened.worlds[0].childOff, 4);
  assert.equal(reopened.worlds[0].childOn, 4);
  assert.equal(reopened.worlds[1].childOff, 4);
  assert.equal(reopened.worlds[1].childOn, 8);
  for (const world of rebuilt.worlds) assertDistribution(world, {}, { '00': '1/2', '01': '1/2' });
  assertDistribution(rebuilt.worlds[0], { A: 1 }, { '10': '1/2', '11': '1/2' });
  assertDistribution(rebuilt.worlds[1], { A: 1 }, { '11': '1' });
});

test('reopening refuses an invalid pair without changing its source', () => {
  const original = rawPair(); original.worlds[1].variables[1].table = [1, 0];
  const before = structuredClone(original);
  assert.equal(verifyAuthoredProposal(original, { variableIds: ['A', 'B'] }).accepted, false);
  descriptiveError(() => draftFromProposal(original));
  assert.deepEqual(original, before);
});

test('reopening refuses richer fixed-noise responses even when all clamp marginals fit', () => {
  const original = { schema: 'equivia.author.v1', title: 'Coupling must not be silently projected', worlds: [
    { schema: 'equivia.scm.v1', id: 'xor', label: 'XOR input', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 0, table: [0] },
      { id: 'B', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 0] },
    ] },
    { schema: 'equivia.scm.v1', id: 'monotonic', label: 'One-way input', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 0, table: [0] },
      { id: 'B', parents: ['A'], noiseBits: 1, table: [0, 1, 1, 1] },
    ] },
  ], experiment: { intervention: { A: 1 } } };
  assert.equal(verifyAuthoredProposal(original, { variableIds: ['A', 'B'] }).accepted, true);
  const before = structuredClone(original);
  descriptiveError(() => draftFromProposal(original), 'UNSUPPORTED_WORKSHEET');
  assert.deepEqual(original, before);
});
