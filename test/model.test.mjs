import test from 'node:test';
import assert from 'node:assert/strict';
import { lampWorlds } from '../src/engine.js';
import {
  buildLearnerContext, makeLearnerRequest, validateLearnerResponse, renderLearnerAdvice,
  makeAuthorRequest, validateAuthorResponse, verifyAuthoredProposal,
} from '../src/model.js';

const input = () => ({ worlds: lampWorlds(), experiments: [{ id: 'force-A-on', label: 'Force A on', intervention: { A: 1 } },
  { id: 'force-B-off', intervention: { B: 0 } }], history: [{ intervention: {}, outcome: { A: 1, B: 1 } }],
  explanation: 'They turn on together, so I think A must cause B.', currentHypotheses: ['A-causes-B'] });
const coach = () => ({ schema: 'equivia.coach.v1', interpretation: 'correlation_direction',
  learnerQuote: 'I think A must cause B', question: 'predict_before_clamp', experimentId: 'force-A-on',
  factIds: ['observational', 'experiment:force-A-on'] });

// A separate, genuinely different authored fixture. It does not replace the
// owner's noiseless first lesson: private noise makes both clamp outcomes possible.
const noisyAuthor = () => ({ schema: 'equivia.author.v1', title: 'Noisy two-way puzzle', worlds: [
  { schema: 'equivia.scm.v1', id: 'noisy-forward', observed: ['A', 'B'], variables: [
    { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'B', parents: ['A'], noiseBits: 2, table: [0, 0, 0, 1, 1, 1, 1, 0] },
  ] },
  { schema: 'equivia.scm.v1', id: 'noisy-reverse', observed: ['A', 'B'], variables: [
    { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
    { id: 'A', parents: ['B'], noiseBits: 2, table: [0, 0, 0, 1, 1, 1, 1, 0] },
  ] },
], experiment: { intervention: { A: 1 } } });

test('learner context computes exact facts from public candidates without a hidden-world identity', () => {
  const data = input(), context = buildLearnerContext(data);
  assert.equal(context.facts[0].comparison.equivalent, true);
  assert.equal(context.facts[1].comparison.separates, true);
  const before = JSON.stringify(data);
  const request = makeLearnerRequest(context, { model: 'configured/model' });
  assert.equal(request.model, 'configured/model');
  const sent = JSON.parse(request.messages[1].content);
  assert.equal(sent.explanation, data.explanation);
  assert.deepEqual(sent.history, data.history);
  assert.deepEqual(sent.currentHypotheses, data.currentHypotheses);
  assert.equal(Object.hasOwn(sent, 'hiddenWorldId'), false);
  assert.equal(JSON.stringify(data), before);
  assert.throws(() => buildLearnerContext({ ...data, hiddenWorldId: 'A-causes-B' }));
  assert.throws(() => { context.facts[0].comparison.equivalent = false; }, TypeError);
});

test('forged or deserialized contexts cannot smuggle asserted numerical facts into a request', () => {
  const context = buildLearnerContext(input());
  const forged = JSON.parse(JSON.stringify(context));
  forged.facts[0].comparison.equivalent = false;
  assert.throws(() => makeLearnerRequest(forged, { model: 'configured/model' }));
  assert.throws(() => buildLearnerContext({ ...input(), facts: forged.facts }));
});

test('coach interpretation is reviewable, quotes actual explanation, and links the exact experiment calculation', () => {
  const context = buildLearnerContext(input());
  const proposal = validateLearnerResponse(JSON.stringify(coach()), context);
  const advice = renderLearnerAdvice(proposal, context);
  assert.equal(advice.rejectable, true);
  assert.match(advice.interpretation.reviewPrompt, /reject/);
  assert.equal(advice.interpretation.quote, 'I think A must cause B');
  assert.match(advice.question, /A = 1/);
  assert.equal(advice.facts[1], context.facts[1]);
  assert.equal(advice.experiment.id, 'force-A-on');
});

test('invented quotes, unknown facts, unpermitted interventions and extra assertions are rejected', () => {
  const context = buildLearnerContext(input());
  for (const mutate of [
    (value) => { value.learnerQuote = 'I have already proved the hidden world'; },
    (value) => { value.factIds = ['invented']; },
    (value) => { value.factIds = ['observational']; },
    (value) => { value.experimentId = 'force-C'; },
    (value) => { value.hiddenWorldId = 'A-causes-B'; },
    (value) => { value.assertion = 'A definitely causes B'; },
    (value) => { value.interpretation = 'certainly_wrong'; },
  ]) { const value = coach(); mutate(value); assert.throws(() => validateLearnerResponse(value, context)); }
  assert.throws(() => validateLearnerResponse('```json\n{}\n```', context));
});

test('empty explanation allows no fabricated quotation', () => {
  const context = buildLearnerContext({ ...input(), explanation: '' });
  assert.doesNotThrow(() => validateLearnerResponse({ ...coach(), learnerQuote: '' }, context));
  assert.throws(() => validateLearnerResponse(coach(), context));
});

test('history must use permitted variables/actions and cannot contradict an enforced clamp', () => {
  for (const history of [
    [{ intervention: { A: 1 }, outcome: { A: 0, B: 1 } }],
    [{ intervention: { A: 0 }, outcome: { A: 0, B: 1 } }],
    [{ intervention: {}, outcome: { hidden: 1 } }],
    [{ intervention: {}, outcome: {}, actualWorld: 'A-causes-B' }],
  ]) assert.throws(() => buildLearnerContext({ ...input(), history }));
});

test('zero-evidence history is rejected distinctly without a reset or an invented prior', () => {
  const data = { ...input(), history: [{ intervention: {}, outcome: { A: 1, B: 0 } }] };
  const before = JSON.stringify(data);
  assert.throws(() => buildLearnerContext(data), (error) => error.code === 'IMPOSSIBLE_EVIDENCE');
  assert.equal(JSON.stringify(data), before);
});

test('author request describes real table generation and requires an explicit configured model', () => {
  const request = makeAuthorRequest({ brief: 'A noisy follow-on puzzle', variableIds: ['A', 'B'] }, { model: 'configured/model' });
  assert.match(request.messages[0].content, /topological order/);
  assert.match(request.messages[0].content, /independently enumerate/);
  assert.deepEqual(JSON.parse(request.messages[1].content).variableIds, ['A', 'B']);
  assert.throws(() => makeAuthorRequest({ brief: 'A puzzle', variableIds: ['A', 'B'] }));
});

test('new noisy authored pair is accepted only after exact equivalence and separation checks', () => {
  const proposal = noisyAuthor(), original = JSON.stringify(proposal);
  const result = verifyAuthoredProposal(JSON.stringify(proposal), { variableIds: ['A', 'B'] });
  assert.equal(result.accepted, true);
  assert.equal(result.proof.observational.equivalent, true);
  assert.equal(result.proof.interventional.separates, true);
  const observation = result.proof.observational.distributions[0];
  assert.deepEqual(observation.outcomes.find((row) => row.key === '00').probability, { numerator: '3', denominator: '8' });
  const worlds = result.proof.interventional.distributions;
  assert.deepEqual(worlds[0].outcomes.find((row) => row.key === '11').probability, { numerator: '3', denominator: '4' });
  assert.deepEqual(worlds[1].outcomes.find((row) => row.key === '11').probability, { numerator: '1', denominator: '2' });
  assert.equal(JSON.stringify(proposal), original);
});

test('an equivalent pair with an uninformative clamp is rejected rather than accepted by its title', () => {
  const proposal = noisyAuthor();
  proposal.title = 'This intervention definitely separates the models';
  proposal.experiment.intervention = { A: 1, B: 1 };
  const result = verifyAuthoredProposal(proposal, { variableIds: ['A', 'B'] });
  assert.equal(result.accepted, false);
  assert.equal(result.error.code, 'NOT_SEPARATED');
});

test('non-equivalent observational distributions and invalid SCM references are rejected', () => {
  const unequal = noisyAuthor();
  unequal.worlds[1].variables[0].table = [1, 1];
  assert.equal(verifyAuthoredProposal(unequal, { variableIds: ['A', 'B'] }).error.code, 'NOT_OBSERVATIONALLY_EQUIVALENT');
  const broken = noisyAuthor();
  broken.worlds[0].variables[1].parents = ['C'];
  assert.equal(verifyAuthoredProposal(broken, { variableIds: ['A', 'B'] }).accepted, false);
  const hidden = noisyAuthor(); hidden.actualWorldId = 'noisy-forward';
  assert.throws(() => validateAuthorResponse(hidden, { variableIds: ['A', 'B'] }));
});

test('unsafe JSON accessors and prototype payloads cannot execute or enter either contract', () => {
  let invoked = false;
  const response = { get schema() { invoked = true; return 'equivia.author.v1'; } };
  assert.throws(() => validateAuthorResponse(response, { variableIds: ['A', 'B'] }));
  assert.equal(invoked, false);
  const bad = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => validateAuthorResponse(bad, { variableIds: ['A', 'B'] }));
  assert.equal({}.polluted, undefined);
});
