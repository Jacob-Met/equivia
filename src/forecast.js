import { distribution, posterior } from './engine.js';

// Current-run reflection under the engine's declared uniform-noise model.
// Posterior uses the engine's equal starting world weights and all public history.
// The hidden world remains fixed across trials: mix per-world binomials, rather
// than taking a binomial of the mixture mean. Pseudorandom seeds are not inputs.
// Counts measure other-lamp-on trials, with independent noise within each world.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => record(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));
const bit = value => value === 0 || value === 1;
const fail = message => { throw new TypeError(message); };
function clampVariable(clamp) {
  if (!record(clamp) || Object.keys(clamp).length !== 1) fail('Expected one lamp clamp');
  const variable = Object.keys(clamp)[0];
  if (!['A', 'B'].includes(variable) || !bit(clamp[variable])) fail('Invalid lamp clamp');
  return variable;
}
function fraction(n, d = 1n) {
  if (d <= 0n) fail('Invalid fraction denominator');
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const multiply = (a, b) => fraction(a.n * b.n, a.d * b.d);
const power = (a, exponent) => fraction(a.n ** BigInt(exponent), a.d ** BigInt(exponent));
const zero = () => fraction(0n);
const encode = value => ({ numerator: String(value.n), denominator: String(value.d) });
function probability(value) {
  if (!keys(value, ['numerator', 'denominator']) ||
      typeof value.numerator !== 'string' || typeof value.denominator !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value.numerator) ||
      !/^[1-9][0-9]*$/.test(value.denominator)) fail('Invalid exact probability');
  const result = fraction(BigInt(value.numerator), BigInt(value.denominator));
  if (result.n > result.d) fail('Probability exceeds one');
  return result;
}
function choose(n, k) {
  let result = 1n;
  for (let i = 1; i <= k; i++) result = result * BigInt(n - i + 1) / BigInt(i);
  return fraction(result);
}

export function forecast(worlds, publicHistory, clamp, count) {
  if (!Array.isArray(worlds) || worlds.length === 0) fail('Expected candidate worlds');
  if (!Array.isArray(publicHistory)) fail('Expected public history');
  if (!Number.isInteger(count) || count < 1 || count > 3) fail('Trials must be 1 through 3');
  const clampedVariable = clampVariable(clamp);
  const observedVariable = clampedVariable === 'A' ? 'B' : 'A';
  for (const event of publicHistory) {
    if (!keys(event, ['intervention', 'outcome'])) fail('History must contain only public evidence');
    if (!record(event.intervention)) fail('Invalid history intervention');
    if (Object.keys(event.intervention).length) clampVariable(event.intervention);
    if (!keys(event.outcome, ['A', 'B']) || !bit(event.outcome.A) || !bit(event.outcome.B)) {
      fail('History outcomes must contain both binary lamps');
    }
  }
  const belief = posterior(worlds, publicHistory);
  if (belief.status !== 'ok') fail('Cannot forecast from zero or invalid evidence');
  if (!Array.isArray(belief.hypotheses) || belief.hypotheses.length !== worlds.length) {
    fail('Incomplete posterior');
  }
  const weights = new Map();
  for (const hypothesis of belief.hypotheses) {
    if (weights.has(hypothesis.worldId)) fail('Duplicate posterior world');
    weights.set(hypothesis.worldId, probability(hypothesis.probability));
  }
  const ids = worlds.map(world => world.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !weights.has(id))) {
    fail('Posterior does not match candidate worlds');
  }
  const weightTotal = [...weights.values()].reduce(add, zero());
  if (weightTotal.n !== weightTotal.d) fail('Posterior is not normalized');
  let singleTrial = zero();
  const counts = Array.from({ length: count + 1 }, zero);
  for (const world of worlds) {
    const result = distribution(world, { intervention: clamp, observed: [observedVariable] });
    if (result.status !== 'ok' || !Array.isArray(result.outcomes)) fail('Invalid intervention distribution');
    let p = zero(), total = zero();
    const seen = new Set();
    for (const outcome of result.outcomes) {
      if (!keys(outcome.values, [observedVariable]) || !bit(outcome.values[observedVariable])) {
        fail('Expected a binary other-lamp distribution');
      }
      const value = outcome.values[observedVariable];
      if (seen.has(value)) fail('Duplicate distribution outcome');
      seen.add(value);
      const mass = probability(outcome.probability);
      total = add(total, mass);
      if (value === 1) p = mass;
    }
    if (total.n !== total.d) fail('Intervention distribution is not normalized');
    const weight = weights.get(world.id), q = fraction(p.d - p.n, p.d);
    singleTrial = add(singleTrial, multiply(weight, p));
    for (let k = 0; k <= count; k++) {
      const binomial = multiply(choose(count, k), multiply(power(p, k), power(q, count - k)));
      counts[k] = add(counts[k], multiply(weight, binomial));
    }
  }
  return {
    observedVariable, trials: count,
    singleTrialProbability: encode(singleTrial),
    counts: counts.map((value, k) => ({ count: k, probability: encode(value) }))
  };
}
