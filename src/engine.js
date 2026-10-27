/** Exact, bounded binary structural causal models for teaching experiments. */
export const LIMITS = Object.freeze({ variables: 12, totalNoiseBits: 12, localNoiseBits: 4, tableInputBits: 12, worlds: 8, history: 64, priorDigits: 4096 });
export class EquiviaError extends Error {
  constructor(code, message) { super(message); this.name = 'EquiviaError'; this.code = code; }
}
const fail = (code, message) => { throw new EquiviaError(code, message); };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = id => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id);
const abs = n => n < 0n ? -n : n;
function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; }
function rational(n, d = 1n) {
  if (d === 0n) fail('INVALID_FRACTION', 'A fraction denominator cannot be zero.');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d); return { n: n / g, d: d / g };
}
const ZERO = { n: 0n, d: 1n }, ONE = { n: 1n, d: 1n };
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a, b) => rational(a.n * b.n, a.d * b.d);
const div = (a, b) => rational(a.n * b.d, a.d * b.n);
const same = (a, b) => a.n * b.d === b.n * a.d;
const external = value => ({ numerator: value.n.toString(), denominator: value.d.toString() });
function parseFraction(value, code = 'INVALID_FRACTION', maxDigits = 65536) {
  if (!plain(value)) fail(code, 'A fraction must contain decimal-string numerator and denominator.');
  const { numerator, denominator } = value;
  for (const text of [numerator, denominator]) if (typeof text !== 'string' || text.length > maxDigits || !/^(0|[1-9][0-9]*)$/.test(text)) fail(code, `Fraction terms must be nonnegative decimal strings of at most ${maxDigits} digits.`);
  if (denominator === '0') fail(code, 'A fraction denominator must be positive.');
  return rational(BigInt(numerator), BigInt(denominator));
}

/** Approximate display conversion only; no scientific calculation uses Number. */
export function fractionToNumber(value) {
  const f = parseFraction(value), ns = f.n.toString(), ds = f.d.toString();
  if (!f.n) return 0;
  const nh = ns.slice(0, 16), dh = ds.slice(0, 16);
  return Number(nh) / Number(dh) * 10 ** ((ns.length - nh.length) - (ds.length - dh.length));
}

function names(list, all, label) {
  if (!Array.isArray(list) || list.length > LIMITS.variables) fail('INVALID_OBSERVED', `${label} must be an array of at most ${LIMITS.variables} variable IDs.`);
  const seen = new Set();
  for (const id of list) {
    if (!all.has(id)) fail('UNKNOWN_VARIABLE', `${label} refers to unknown variable ${String(id)}.`);
    if (seen.has(id)) fail('INVALID_OBSERVED', `${label} contains duplicate variable ${id}.`);
    seen.add(id);
  }
  return [...list];
}

function compile(world) {
  if (!plain(world) || world.schema !== 'equivia.scm.v1' || !validId(world.id)) fail('INVALID_SCHEMA', 'Expected equivia.scm.v1 with a nonempty letter-first ID (at most 64 characters).');
  if (!Array.isArray(world.variables) || world.variables.length < 1 || world.variables.length > LIMITS.variables) fail('LIMIT_EXCEEDED', `A world needs 1–${LIMITS.variables} binary variables.`);
  const byId = new Map(), variables = world.variables;
  let totalNoiseBits = 0;
  for (let i = 0; i < variables.length; i++) {
    const v = variables[i];
    if (!plain(v) || !validId(v.id) || byId.has(v.id)) fail('INVALID_VARIABLE', 'Variable IDs must be unique, letter-first identifiers of at most 64 characters.');
    if (!Array.isArray(v.parents) || v.parents.length >= LIMITS.variables || new Set(v.parents).size !== v.parents.length) fail('INVALID_VARIABLE', `Parents of ${v.id} must be a bounded array of distinct IDs.`);
    if (!Number.isInteger(v.noiseBits) || v.noiseBits < 0 || v.noiseBits > LIMITS.localNoiseBits) fail('LIMIT_EXCEEDED', `Local noiseBits for ${v.id} must be an integer from 0 to ${LIMITS.localNoiseBits}.`);
    if (v.parents.length + v.noiseBits > LIMITS.tableInputBits) fail('LIMIT_EXCEEDED', `Truth table ${v.id} exceeds ${LIMITS.tableInputBits} input bits.`);
    totalNoiseBits += v.noiseBits; byId.set(v.id, i);
  }
  if (totalNoiseBits > LIMITS.totalNoiseBits) fail('LIMIT_EXCEEDED', `A world can use at most ${LIMITS.totalNoiseBits} independent noise bits.`);
  for (const v of variables) for (const p of v.parents) if (!byId.has(p)) fail('UNKNOWN_VARIABLE', `${v.id} references unknown parent ${String(p)}.`);
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('CYCLE', `The structural graph contains a directed cycle through ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id); for (const p of variables[byId.get(id)].parents) visit(p);
    visiting.delete(id); visited.add(id);
  }
  for (const v of variables) visit(v.id);
  let offset = 0;
  const plan = variables.map((v, i) => {
    for (const p of v.parents) if (byId.get(p) >= i) fail('INVALID_ORDER', `Declare parent ${p} before child ${v.id}; this graph is acyclic but is not in topological order.`);
    const expected = 2 ** (v.parents.length + v.noiseBits);
    if (!Array.isArray(v.table) || v.table.length !== expected || Array.from(v.table).some(bit => bit !== 0 && bit !== 1)) fail('INVALID_TABLE', `Truth table ${v.id} needs exactly ${expected} numeric binary cells.`);
    offset += v.noiseBits;
    return { id: v.id, parents: v.parents.map(p => byId.get(p)), noiseBits: v.noiseBits, noiseShift: totalNoiseBits - offset, noiseMask: (1 << v.noiseBits) - 1, table: [...v.table] };
  });
  const observed = names(world.observed, byId, 'world.observed');
  return { id: world.id, byId, plan, observed, totalNoiseBits, assignments: 2 ** totalNoiseBits };
}

/** Validate without mutating the caller's world; returns useful bounded metadata. */
export function validateWorld(world) {
  const c = compile(world);
  return { valid: true, variableCount: c.plan.length, totalNoiseBits: c.totalNoiseBits, noiseAssignments: c.assignments, observed: [...c.observed] };
}

function assignment(value, compiled, label, allowed = null) {
  if (value === undefined) return [];
  if (!plain(value)) fail('INVALID_ASSIGNMENT', `${label} must map variable IDs to numeric 0 or 1.`);
  const entries = Object.entries(value);
  if (entries.length > LIMITS.variables) fail('LIMIT_EXCEEDED', `${label} contains too many assignments.`);
  for (const [id, bit] of entries) {
    if (!compiled.byId.has(id)) fail('UNKNOWN_VARIABLE', `${label} refers to unknown variable ${id}.`);
    if (allowed && !allowed.has(id)) fail('INVALID_HISTORY', `${label} cannot record hidden variable ${id}.`);
    if (bit !== 0 && bit !== 1) fail('INVALID_ASSIGNMENT', `${label}.${id} must be numeric 0 or 1.`);
  }
  return entries.map(([id, bit]) => [compiled.byId.get(id), bit]);
}
function run(compiled, noise, intervention, values) {
  for (let i = 0; i < compiled.plan.length; i++) {
    if (intervention.has(i)) { values[i] = intervention.get(i); continue; }
    const node = compiled.plan[i]; let index = 0;
    for (const parent of node.parents) index = (index << 1) | values[parent];
    index = (index << node.noiseBits) | ((noise >>> node.noiseShift) & node.noiseMask);
    values[i] = node.table[index];
  }
}
const agrees = (values, entries) => entries.every(([i, bit]) => values[i] === bit);
function optionsObject(options) { if (!plain(options)) fail('INVALID_OPTIONS', 'Options must be an object.'); }

function calculate(compiled, options = {}) {
  optionsObject(options);
  const observed = options.observed === undefined ? [...compiled.observed] : names(options.observed, compiled.byId, 'observed');
  const indexes = observed.map(id => compiled.byId.get(id));
  const intervention = new Map(assignment(options.intervention, compiled, 'intervention'));
  const condition = assignment(options.condition, compiled, 'condition');
  const counts = new Array(2 ** observed.length).fill(0), values = new Uint8Array(compiled.plan.length);
  let evidence = 0;
  for (let noise = 0; noise < compiled.assignments; noise++) {
    run(compiled, noise, intervention, values);
    if (!agrees(values, condition)) continue;
    evidence++; let key = 0;
    for (const index of indexes) key = (key << 1) | values[index];
    counts[key]++;
  }
  const evidenceFraction = rational(BigInt(evidence), BigInt(compiled.assignments));
  if (!evidence) return { status: 'zero_evidence', observed, outcomes: [], evidence: external(evidenceFraction) };
  const outcomes = counts.map((count, index) => {
    const key = observed.length ? index.toString(2).padStart(observed.length, '0') : '';
    const values = Object.fromEntries(observed.map((id, i) => [id, Number(key[i])]));
    return { key, values, probability: external(rational(BigInt(count), BigInt(evidence))) };
  });
  return { status: 'ok', observed, outcomes, evidence: external(evidenceFraction) };
}

/** Enumerate every independent uniform noise assignment. do replaces equations. */
export function distribution(world, options = {}) { return calculate(compile(world), options); }

function worldSet(worlds) {
  if (!Array.isArray(worlds) || worlds.length < 1 || worlds.length > LIMITS.worlds) fail('LIMIT_EXCEEDED', `Use 1–${LIMITS.worlds} candidate worlds.`);
  const compiled = Array.from(worlds, compile), ids = new Set();
  const signature = [...compiled[0].observed].sort().join('\0');
  for (const c of compiled) {
    if (ids.has(c.id)) fail('INVALID_WORLD_IDS', `Duplicate world ID ${c.id}.`);
    ids.add(c.id);
    if ([...c.observed].sort().join('\0') !== signature) fail('INCONSISTENT_OBSERVED', 'Candidate worlds must expose the same observed-variable set.');
  }
  return compiled;
}

/** Exact equivalence or separation of the specified observed distributions. */
export function compareWorlds(worlds, options = {}) {
  optionsObject(options);
  const compiled = worldSet(worlds), observed = options.observed ?? compiled[0].observed;
  const distributions = compiled.map(c => ({ worldId: c.id, ...calculate(c, { ...options, observed }) }));
  const pairs = [];
  for (let i = 0; i < distributions.length; i++) for (let j = i + 1; j < distributions.length; j++) {
    const left = distributions[i], right = distributions[j];
    if (left.status !== 'ok' || right.status !== 'ok') {
      pairs.push({ left: left.worldId, right: right.worldId, relation: 'undefined', totalVariation: null, witness: null }); continue;
    }
    let distance = ZERO, witness = null;
    for (let k = 0; k < left.outcomes.length; k++) {
      const a = parseFraction(left.outcomes[k].probability), b = parseFraction(right.outcomes[k].probability);
      distance = add(distance, rational(abs(a.n * b.d - b.n * a.d), a.d * b.d));
      if (!witness && !same(a, b)) witness = { outcome: { ...left.outcomes[k].values }, leftProbability: external(a), rightProbability: external(b) };
    }
    pairs.push({ left: left.worldId, right: right.worldId, relation: witness ? 'separated' : 'equal', totalVariation: external(div(distance, rational(2n))), witness });
  }
  const undefinedDistribution = distributions.some(d => d.status !== 'ok');
  return { status: undefinedDistribution ? 'zero_evidence' : 'ok', observed: [...observed], equivalent: undefinedDistribution ? null : pairs.every(p => p.relation === 'equal'), separates: pairs.some(p => p.relation === 'separated'), pairs, distributions };
}

function likelihood(compiled, intervention, outcome) {
  const actions = new Map(assignment(intervention, compiled, 'intervention'));
  const observed = assignment(outcome, compiled, 'outcome', new Set(compiled.observed));
  const values = new Uint8Array(compiled.plan.length); let matching = 0;
  for (let noise = 0; noise < compiled.assignments; noise++) {
    run(compiled, noise, actions, values); if (agrees(values, observed)) matching++;
  }
  return rational(BigInt(matching), BigInt(compiled.assignments));
}

/** Bayesian weights within this supplied finite hypothesis set, never truth revelation. */
export function posterior(worlds, history = [], options = {}) {
  optionsObject(options);
  const compiled = worldSet(worlds);
  if (!Array.isArray(history) || history.length > LIMITS.history) fail('INVALID_HISTORY', `History must contain at most ${LIMITS.history} independent trials.`);
  let weights;
  if (options.prior === undefined) weights = compiled.map(() => rational(1n, BigInt(compiled.length)));
  else {
    if (!plain(options.prior) || Object.keys(options.prior).length !== compiled.length || compiled.some(c => !own(options.prior, c.id))) fail('INVALID_PRIOR', 'Prior must provide exactly one fraction for every candidate world ID.');
    weights = compiled.map(c => parseFraction(options.prior[c.id], 'INVALID_PRIOR', LIMITS.priorDigits));
    const total = weights.reduce(add, ZERO);
    if (!total.n) fail('INVALID_PRIOR', 'Prior weights cannot all be zero.');
    weights = weights.map(w => div(w, total));
  }
  let firstImpossibleStep = null;
  for (let index = 0; index < history.length; index++) {
    const trial = history[index];
    if (!plain(trial) || !own(trial, 'outcome') || !plain(trial.outcome)) fail('INVALID_HISTORY', `Trial ${index} must contain an observed outcome object.`);
    // Validate every recorded trial even if previous evidence was impossible.
    const chances = compiled.map(c => likelihood(c, trial.intervention, trial.outcome));
    weights = weights.map((w, i) => mul(w, chances[i]));
    if (firstImpossibleStep === null && weights.every(w => !w.n)) firstImpossibleStep = index;
  }
  const evidence = weights.reduce(add, ZERO);
  return {
    status: evidence.n ? 'ok' : 'zero_evidence', trialCount: history.length, firstImpossibleStep,
    evidence: external(evidence),
    hypotheses: compiled.map((c, i) => ({ worldId: c.id, probability: external(evidence.n ? div(weights[i], evidence) : ZERO) }))
  };
}

/** Reproducible draw, independent of action: a uint32 LCG maps seed to noise bits. */
export function sample(world, options = {}) {
  optionsObject(options);
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) fail('INVALID_SEED', 'Provide an integer uint32 seed from 0 to 4294967295.');
  if (options.condition !== undefined) fail('INVALID_OPTIONS', 'sample does not condition or rejection-sample; use distribution for conditional probabilities.');
  const compiled = compile(world), observed = options.observed === undefined ? compiled.observed : names(options.observed, compiled.byId, 'observed');
  const actions = new Map(assignment(options.intervention, compiled, 'intervention'));
  const nextSeed = (Math.imul(options.seed, 1664525) + 1013904223) >>> 0;
  const noise = compiled.totalNoiseBits ? nextSeed >>> (32 - compiled.totalNoiseBits) : 0;
  const values = new Uint8Array(compiled.plan.length); run(compiled, noise, actions, values);
  return { outcome: Object.fromEntries(observed.map(id => [id, values[compiled.byId.get(id)]])), nextSeed };
}

/** Two fair-root lamp mechanisms with identical observational distributions. */
export function lampWorlds() {
  return [
    { schema: 'equivia.scm.v1', id: 'A-causes-B', label: 'A drives B', observed: ['A', 'B'], variables: [
      { id: 'A', parents: [], noiseBits: 1, table: [0, 1] },
      { id: 'B', parents: ['A'], noiseBits: 0, table: [0, 1] }
    ] },
    { schema: 'equivia.scm.v1', id: 'B-causes-A', label: 'B drives A', observed: ['A', 'B'], variables: [
      { id: 'B', parents: [], noiseBits: 1, table: [0, 1] },
      { id: 'A', parents: ['B'], noiseBits: 0, table: [0, 1] }
    ] }
  ];
}
