import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, experiment, observe, receiveSession, serializeSession, beliefState,
  trialsRemaining, learnerRequest } from '../src/session.js';

test('prediction is explicit, supports probabilistic estimates and charges only committed trials', () => {
  const initial = createSession({ seed: 37 });
  const before = serializeSession(initial);
  for (const prediction of [undefined, null, NaN, Infinity, -0.01, 1.01, '0.75']) {
    assert.throws(() => experiment(initial, { intervention: { A: 1 }, prediction }));
    assert.equal(serializeSession(initial), before);
  }
  const next = experiment(initial, { intervention: { A: 1 }, prediction: .75, count: 1 });
  assert.equal(next.history.at(-1).prediction, .75);
  assert.equal(trialsRemaining(next), 5);
  assert.equal(trialsRemaining(initial), 6);
  assert.equal(next.history.length, initial.history.length + 1);
});

test('observation leaves hypothesis weights unchanged; six-trial budget cannot overrun', () => {
  let current = createSession({ seed: 9 });
  const originalBeliefs = beliefState(current).hypotheses;
  current = observe(current, 8);
  assert.deepEqual(beliefState(current).hypotheses, originalBeliefs);
  current = experiment(current, { intervention: { A: 1 }, prediction: .75, count: 3 });
  current = experiment(current, { intervention: { B: 1 }, prediction: .63, count: 3 });
  assert.equal(trialsRemaining(current), 0);
  const before = serializeSession(current);
  assert.throws(() => experiment(current, { intervention: { A: 1 }, prediction: .75 }));
  assert.equal(serializeSession(current), before);
});

test('portable notebook replays outcomes, predictions, posterior and next random result exactly', () => {
  let original = createSession({ seed: 0xf00dcafe });
  original = experiment(original, { intervention: { A: 0 }, prediction: 5 / 6, count: 2 });
  original.explanation = 'One agreeing result does not settle the direction.';
  const reopened = receiveSession(serializeSession(original));
  assert.deepEqual(reopened, original);
  assert.deepEqual(beliefState(reopened), beliefState(original));
  const next = value => experiment(value, { intervention: { B: 1 }, prediction: .25 });
  assert.deepEqual(next(reopened), next(original));
});

test('damaged evidence, seed, budget and observation clamps cannot pass replay admission', () => {
  const original = createSession({ seed: 173 });
  const before = serializeSession(original);
  for (const mutate of [
    value => { value.history[0].outcome.A = 1 - value.history[0].outcome.A; },
    value => { value.history[0].beforeSeed++; },
    value => { value.history[0].afterSeed++; },
    value => { value.history[0].intervention = { A: 1 }; },
    value => { value.seed++; },
    value => { value.budget = 7; },
    value => { value.activeWorldId = 'missing'; },
  ]) {
    const damaged = JSON.parse(before); mutate(damaged);
    assert.throws(() => receiveSession(JSON.stringify(damaged)));
    assert.equal(serializeSession(original), before);
  }
});

test('learner context carries public hypotheses and observations without hidden-world selection or seeds', () => {
  const original = createSession({ seed: 51 });
  original.explanation = 'I want to separate intervention from observation.';
  const request = learnerRequest(original);
  assert.deepEqual(Object.keys(request).sort(), ['currentHypotheses', 'experiments', 'explanation', 'history', 'worlds']);
  assert.equal(request.explanation, original.explanation);
  request.history[0].outcome.A = 9;
  assert.notEqual(original.history[0].outcome.A, 9);
  for (const event of request.history) assert.deepEqual(Object.keys(event).sort(), ['intervention', 'outcome']);
});

test('revealing a completed investigation blocks further trial collection', () => {
  const current = createSession({ seed: 18 }); current.revealed = true;
  assert.throws(() => observe(current));
  assert.throws(() => experiment(current, { intervention: { A: 1 }, prediction: .75 }));
});
