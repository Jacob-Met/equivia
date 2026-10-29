import { lampWorlds, validateWorld, compareWorlds, sample, posterior } from './engine.js';

export const SESSION_SCHEMA = 'equivia.session.v1';
export const MAX_NOTEBOOK_BYTES = 262144;
export const EXPERIMENT_BUDGET = 6;
export const EXPERIMENTS = Object.freeze([
  { id: 'hold-A-on', label: 'Hold A on', intervention: { A: 1 } },
  { id: 'hold-A-off', label: 'Hold A off', intervention: { A: 0 } },
  { id: 'hold-B-on', label: 'Hold B on', intervention: { B: 1 } },
  { id: 'hold-B-off', label: 'Hold B off', intervention: { B: 0 } },
]);
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value, lo, hi) => Number.isInteger(value) && value >= lo && value <= hi;
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const exactOutcome = (a, b) => ['A', 'B'].every(key => a?.[key] === b?.[key])
  && Object.keys(a ?? {}).length === 2 && Object.keys(b ?? {}).length === 2;
function validatePair(worlds) {
  if (!Array.isArray(worlds) || worlds.length !== 2) throw new Error('This laboratory uses exactly two candidate worlds.');
  worlds.forEach(validateWorld);
  if (worlds[0].id === worlds[1].id) throw new Error('Candidate worlds need distinct identities.');
  if (worlds.some(world => !Array.isArray(world.observed) || world.observed.length !== 2 || !['A', 'B'].every(id => world.observed.includes(id)))) {
    throw new Error('The lamp laboratory needs observed variables A and B.');
  }
  if (!compareWorlds(worlds, { observed: ['A', 'B'] }).equivalent) throw new Error('These candidate worlds do not share the same observational distribution.');
}
function experimentFor(intervention) {
  if (!intervention || typeof intervention !== 'object' || Array.isArray(intervention)) return undefined;
  const entries = Object.entries(intervention);
  if (entries.length !== 1) return undefined;
  return EXPERIMENTS.find(item => Object.entries(item.intervention)[0][0] === entries[0][0]
    && Object.entries(item.intervention)[0][1] === entries[0][1]);
}
export function trialsRemaining(session) {
  return session.budget - session.history.filter(event => event.kind === 'intervene').length;
}
export function beliefState(session) {
  return posterior(session.worlds, session.history.map(event => ({ intervention: event.intervention, outcome: event.outcome })));
}
export function createSession({ seed = 0x31c0caff, worlds = lampWorlds(), title = 'The matching lamps', activeWorldId } = {}) {
  if (!integer(seed, 0, 0xffffffff)) throw new Error('Investigation seed must be an unsigned 32-bit integer.');
  validatePair(worlds);
  const active = activeWorldId ?? worlds[seed % worlds.length].id;
  if (!worlds.some(world => world.id === active)) throw new Error('Unknown active world.');
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('Investigation title is invalid.');
  const session = { schema: SESSION_SCHEMA, title: title.trim(), worlds: clone(worlds), activeWorldId: active,
    initialSeed: seed, seed, budget: EXPERIMENT_BUDGET, history: [], explanation: '', revealed: false };
  return observe(session, 12);
}
export function observe(session, count = 8) {
  if (session.revealed) throw new Error('This investigation is complete. Start a new one to collect fresh observations.');
  if (!integer(count, 1, 12)) throw new Error('Observe from one to twelve trials at a time.');
  if (session.history.length + count > 64 - trialsRemaining(session)) throw new Error('The notebook is full. Start a new investigation to collect more observations.');
  const next = clone(session), world = next.worlds.find(item => item.id === next.activeWorldId);
  for (let i = 0; i < count; i++) {
    const result = sample(world, { seed: next.seed, intervention: {}, observed: ['A', 'B'] });
    next.history.push({ id: next.history.length + 1, kind: 'observe', intervention: {}, outcome: result.outcome,
      prediction: null, beforeSeed: next.seed, afterSeed: result.nextSeed });
    next.seed = result.nextSeed;
  }
  return next;
}
export function experiment(session, { intervention, prediction, count = 1 }) {
  if (session.revealed) throw new Error('This investigation is complete. Start a new one to run a fresh experiment.');
  const chosen = experimentFor(intervention);
  if (!chosen) throw new Error('Choose one supported lamp clamp.');
  if (!probability(prediction)) throw new Error('Make a probability estimate from 0% through 100% before running the experiment.');
  if (!integer(count, 1, 3) || count > trialsRemaining(session)) throw new Error('There are not enough experimental trials remaining.');
  if (session.history.length + count > 64) throw new Error('The notebook is full.');
  const next = clone(session), world = next.worlds.find(item => item.id === next.activeWorldId);
  for (let i = 0; i < count; i++) {
    const result = sample(world, { seed: next.seed, intervention: chosen.intervention, observed: ['A', 'B'] });
    next.history.push({ id: next.history.length + 1, kind: 'intervene', intervention: { ...chosen.intervention },
      outcome: result.outcome, prediction, beforeSeed: next.seed, afterSeed: result.nextSeed });
    next.seed = result.nextSeed;
  }
  return next;
}
export function receiveSession(raw) {
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > MAX_NOTEBOOK_BYTES) throw new Error('This notebook is too large.');
    raw = JSON.parse(raw);
  }
  if (!raw || raw.schema !== SESSION_SCHEMA || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 120
    || !integer(raw.initialSeed, 0, 0xffffffff) || !integer(raw.seed, 0, 0xffffffff)
    || raw.budget !== EXPERIMENT_BUDGET || !Array.isArray(raw.history) || raw.history.length > 64
    || typeof raw.explanation !== 'string' || raw.explanation.length > 1600 || typeof raw.revealed !== 'boolean') throw new Error('This is not a supported EQUIVIA notebook.');
  validatePair(raw.worlds);
  const world = raw.worlds.find(item => item.id === raw.activeWorldId);
  if (!world) throw new Error('The notebook names an unknown hidden world.');
  let seed = raw.initialSeed, experiments = 0;
  for (const [index, event] of raw.history.entries()) {
    if (!event || event.id !== index + 1 || event.beforeSeed !== seed || !['observe', 'intervene'].includes(event.kind)) throw new Error('The notebook history is not a continuous replay.');
    if (event.kind === 'observe') {
      if (Object.keys(event.intervention ?? { invalid: 1 }).length || event.prediction !== null) throw new Error('An observation cannot silently apply a clamp.');
    } else {
      if (!experimentFor(event.intervention) || !probability(event.prediction)) throw new Error('The notebook has an unsupported experiment.');
      experiments++;
    }
    const result = sample(world, { seed, intervention: event.intervention, observed: ['A', 'B'] });
    if (event.afterSeed !== result.nextSeed || !exactOutcome(event.outcome, result.outcome)) throw new Error('A recorded result does not match the executable world and its replay seed.');
    seed = result.nextSeed;
  }
  if (seed !== raw.seed || experiments > raw.budget) throw new Error('The notebook state or trial budget is inconsistent.');
  if (raw.history.length + raw.budget - experiments > 64) throw new Error('The notebook has insufficient space for its remaining experiments.');
  return clone({ schema: SESSION_SCHEMA, title: raw.title.trim(), worlds: raw.worlds, activeWorldId: raw.activeWorldId,
    initialSeed: raw.initialSeed, seed, budget: raw.budget, history: raw.history, explanation: raw.explanation, revealed: raw.revealed });
}
export function serializeSession(session) {
  const text = JSON.stringify(receiveSession(session), null, 2) + '\n';
  if (new TextEncoder().encode(text).length > MAX_NOTEBOOK_BYTES) throw new Error('This notebook exceeds the portable size limit.');
  return text;
}
/** Deliberately exclude the selected hidden-world identity and random seed. */
export function learnerRequest(session) {
  return {
    worlds: clone(session.worlds), experiments: clone(EXPERIMENTS),
    history: session.history.map(event => ({ intervention: { ...event.intervention }, outcome: { ...event.outcome } })),
    explanation: session.explanation, currentHypotheses: session.worlds.map(world => world.id),
  };
}
