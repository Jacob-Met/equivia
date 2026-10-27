/** Independent, hand-derived EQUIVIA probability tables. No engine imports. */
export const WORLDS = ['a-causes-b', 'b-causes-a', 'common-cause'];
export const OBSERVATIONAL = Object.freeze({ '00': 0.5, '01': 0, '10': 0, '11': 0.5 });

// Keys are visible A then B. The latent common cause is deliberately absent.
// A clamp replaces the selected structural equation; conditioning does not.
const interventionTables = {
  'a-causes-b': {
    'A=0': { '00': 1 }, 'A=1': { '11': 1 },
    'B=0': { '00': 0.5, '10': 0.5 }, 'B=1': { '01': 0.5, '11': 0.5 },
  },
  'b-causes-a': {
    'A=0': { '00': 0.5, '01': 0.5 }, 'A=1': { '10': 0.5, '11': 0.5 },
    'B=0': { '00': 1 }, 'B=1': { '11': 1 },
  },
  'common-cause': {
    'A=0': { '00': 0.5, '01': 0.5 }, 'A=1': { '10': 0.5, '11': 0.5 },
    'B=0': { '00': 0.5, '10': 0.5 }, 'B=1': { '01': 0.5, '11': 0.5 },
  },
};

export function expectedDistribution(worldId, intervention = {}) {
  if (!WORLDS.includes(worldId)) throw new Error('Unknown independent oracle world.');
  const keys = Object.keys(intervention).sort();
  if (keys.some(k => !['A', 'B'].includes(k) || ![0, 1].includes(intervention[k]))) throw new Error('Invalid oracle intervention.');
  const result = { '00': 0, '01': 0, '10': 0, '11': 0 };
  if (!keys.length) return { ...OBSERVATIONAL };
  if (keys.length === 2) return { ...result, [`${intervention.A}${intervention.B}`]: 1 };
  return { ...result, ...interventionTables[worldId][`${keys[0]}=${intervention[keys[0]]}`] };
}

export function expectedConditioning(evidence = {}) {
  const allowed = Object.entries(OBSERVATIONAL).filter(([key, p]) => p > 0
    && Object.entries(evidence).every(([name, value]) => key[name === 'A' ? 0 : 1] === String(value)));
  const probability = allowed.reduce((sum, [, p]) => sum + p, 0);
  if (probability === 0) return { impossible: true, probability: 0, distribution: null };
  return { impossible: false, probability,
    distribution: Object.fromEntries(Object.keys(OBSERVATIONAL).map(key => [key, (allowed.find(([k]) => k === key)?.[1] ?? 0) / probability])) };
}

/** Hand-derived two-world formula for repeated 11 observations after clamp A=1. */
export function repeatedMatchingPosterior(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 50) throw new Error('Bounded oracle count required.');
  const forward = 2 ** count / (2 ** count + 1);
  return { 'a-causes-b': forward, 'b-causes-a': 1 / (2 ** count + 1) };
}

export const COUNTEREXAMPLES = Object.freeze({
  oneMatchingClamp: { prior: [0.5, 0.5], intervention: { A: 1 }, observation: { A: 1, B: 1 }, posterior: [2 / 3, 1 / 3] },
  oneSeparatingClamp: { prior: [0.5, 0.5], intervention: { A: 1 }, observation: { A: 1, B: 0 }, posterior: [0, 1] },
  impossibleUnderClamp: { intervention: { A: 1 }, observation: { A: 0, B: 0 } },
  commonCauseStepOne: { prior: [1 / 3, 1 / 3, 1 / 3], intervention: { A: 1 }, observation: { A: 1, B: 0 }, posterior: [0, 0.5, 0.5] },
  commonCauseStepTwo: { prior: [0, 0.5, 0.5], intervention: { B: 1 }, observation: { A: 0, B: 1 }, posterior: [0, 0, 1] },
  expectedInformationBitsForOneClamp: 0.31127812445913283,
  posteriorPredictiveBeforeFirstClamp: { '10': 0.25, '11': 0.75 },
});
