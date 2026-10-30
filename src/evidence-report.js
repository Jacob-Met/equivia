import { validateWorld, posterior, fractionToNumber } from './engine.js';

const fail = message => { throw new Error('Cannot export evidence report: ' + message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => typeof value === 'string' ? value : fail(name + ' must be text.');
function dense(value, name) {
  if (!Array.isArray(value)) fail(name + ' must be an array.');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail(name + ' cannot contain missing entries.');
  return value;
}
function projectWorld(world) {
  if (!record(world)) fail('Each candidate must be an object.');
  const copy = {
    schema: world.schema,
    id: text(world.id, 'Candidate ID'),
    label: typeof world.label === 'string' && world.label.trim() ? world.label : text(world.id, 'Candidate ID'),
    observed: dense(world.observed, 'Observed variables').map(id => text(id, 'Variable ID')),
    variables: dense(world.variables, 'Variables').map(variable => {
      if (!record(variable)) fail('Each variable must be an object.');
      return {
        id: text(variable.id, 'Variable ID'),
        parents: dense(variable.parents, 'Parents').map(id => text(id, 'Parent ID')),
        noiseBits: variable.noiseBits,
        table: dense(variable.table, 'Rule table').map(value => {
          if (value !== 0 && value !== 1) fail('Rule tables must contain binary values.');
          return value;
        }),
      };
    }),
  };
  if (copy.schema !== 'equivia.scm.v1') fail('Unsupported candidate schema.');
  const result = validateWorld(copy);
  if (!result || result.valid !== true) fail('Invalid candidate model.');
  return copy;
}
function bits(value, allowed, name, requireAll) {
  if (!record(value)) fail(name + ' must be an object.');
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key))) fail(name + ' contains an unknown variable.');
  if (requireAll && (keys.length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key)))) fail(name + ' must record every observed variable.');
  const result = {};
  for (const key of keys) {
    if (value[key] !== 0 && value[key] !== 1) fail(name + ' must contain binary values.');
    Object.defineProperty(result, key, { value: value[key], enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function exactFraction(value) {
  if (!record(value) || typeof value.numerator !== 'string' || typeof value.denominator !== 'string'
    || !/^\d+$/.test(value.numerator) || !/^[1-9]\d*$/.test(value.denominator)) fail('Invalid posterior fraction.');
  return { numerator: value.numerator, denominator: value.denominator };
}

/** Project public evidence explicitly. No replay state or hidden selection is read. */
export function createEvidenceReport(input) {
  if (!record(input)) fail('Expected public experiment data.');
  const title = text(input.title, 'Title');
  const explanation = text(input.explanation, 'Explanation');
  if (!title.trim() || title.length > 120) fail('Title must contain between one and 120 characters.');
  if (explanation.length > 1600) fail('Explanation exceeds 1600 characters.');
  if (!Array.isArray(input.worlds) || input.worlds.length !== 2) fail('Exactly two candidate models are required.');
  const worlds = dense(input.worlds, 'Candidates').map(projectWorld);
  if (worlds.length !== 2) fail('Exactly two candidate models are required.');
  if (new Set(worlds.map(world => world.id)).size !== worlds.length) fail('Candidate IDs must be unique.');
  const observed = worlds[0].observed;
  if (observed.length !== 2 || !observed.includes('A') || !observed.includes('B')
    || worlds.some(world => world.observed.length !== 2 || observed.some(id => !world.observed.includes(id)))) {
    fail('Candidates must share the supported observed lamps A and B.');
  }
  if (input.budget !== 6) fail('The supported intervention budget is six.');
  if (!Array.isArray(input.history) || input.history.length > 64) fail('History must contain at most 64 trials.');
  const sourceHistory = dense(input.history, 'History');
  if (sourceHistory.length > 64) fail('History exceeds the supported 64 trials.');
  let interventions = 0;
  const history = sourceHistory.map((event, index) => {
    if (!record(event) || event.id !== index + 1 || !['observe', 'intervene'].includes(event.kind)) fail('Trial ' + (index + 1) + ' has an unsupported identity or kind.');
    const intervention = bits(event.intervention, observed, 'Intervention', false);
    const count = Object.keys(intervention).length;
    if (event.kind === 'observe' && (count !== 0 || event.prediction !== null)) fail('Watch trial ' + (index + 1) + ' cannot contain a clamp or prediction.');
    if (event.kind === 'intervene') {
      if (count !== 1 || typeof event.prediction !== 'number' || !Number.isFinite(event.prediction)
        || event.prediction < 0 || event.prediction > 1) fail('Intervention ' + (index + 1) + ' requires one clamp and a probability between zero and one.');
      interventions++;
    }
    return {
      id: event.id,
      kind: event.kind,
      intervention,
      outcome: bits(event.outcome, observed, 'Outcome', true),
      prediction: event.kind === 'observe' ? null : event.prediction,
    };
  });
  if (interventions > input.budget) fail('Recorded interventions exceed the budget.');
  const result = posterior(worlds, history);
  if (!result || !['ok', 'zero_evidence'].includes(result.status)) fail('Posterior calculation did not produce a supported result.');
  const weights = result.status === 'ok' ? worlds.map(world => {
    const matches = result.hypotheses.filter(row => row.worldId === world.id);
    if (matches.length !== 1) fail('Posterior candidates do not match the public models.');
    const probability = exactFraction(matches[0].probability);
    const approximate = fractionToNumber(probability);
    if (!Number.isFinite(approximate) || approximate < 0 || approximate > 1) fail('Invalid posterior probability.');
    return { worldId: world.id, probability, approximate };
  }) : [];
  return {
    schema: 'equivia.evidence-report.v1', title, explanation, budget: input.budget,
    interventions, worlds, history, evidence: exactFraction(result.evidence), status: result.status, weights,
  };
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const predictionPercentage = prediction => {
  const raw = prediction * 100;
  const rounded = Number(raw.toPrecision(15));
  return String(prediction < 1 && rounded === 100 ? raw : rounded) + '%';
};
const posteriorPercentage = row => {
  const { numerator, denominator } = row.probability;
  if (BigInt(numerator) === 0n) return '0%';
  if (BigInt(numerator) === BigInt(denominator)) return '100%';
  if (row.approximate < 0.001) return '<0.1%';
  if (row.approximate > 0.999) return '>99.9%';
  return (row.approximate * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
};
const fraction = value => escape(value.numerator) + '/' + escape(value.denominator);
const lamps = value => Object.entries(value).map(([key, bit]) => escape(key) + ' = ' + (bit ? 'ON (1)' : 'OFF (0)')).join('; ');

const style = ':root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#21393b;background:#f3f1e9}*{box-sizing:border-box}body{margin:0}main{max-width:920px;margin:auto;padding:40px 24px 64px}header{border-top:7px solid #5e7763;padding-top:20px}h1{font-family:Georgia,serif;font-size:clamp(1.8rem,5vw,2.8rem);line-height:1.12;overflow-wrap:anywhere}h2{margin-top:36px}h3{margin:0 0 12px;overflow-wrap:anywhere}h4{margin-bottom:8px;overflow-wrap:anywhere}p,dd,li{line-height:1.6}small{display:block;margin-top:5px;font-weight:400;color:#536159}section{margin-top:24px}.eyebrow{font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#3f5a47}.notice{border-left:4px solid #5e7763;padding:12px 16px;background:#e6ebe0}.warning{border-color:#a65a0b;background:#fff3df}table{border-collapse:collapse;width:100%;table-layout:fixed;background:#fffef9}th,td{padding:14px;text-align:left;border-bottom:1px solid #cdd2c5;vertical-align:top;overflow-wrap:anywhere}thead th{background:#e6ebe0}ol{padding-left:24px}li{padding-left:8px;margin:12px 0}article{background:#fffef9;padding:14px;border:1px solid #d4d8cb;border-radius:8px}dl{margin:0;display:grid;grid-template-columns:minmax(110px,1fr) 3fr;gap:6px 16px}dt{font-weight:650}dd{margin:0;overflow-wrap:anywhere}.candidate{margin:16px 0}.rule,code{overflow-wrap:anywhere}.explanation{white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:40px;padding-top:16px;border-top:1px solid #cdd2c5;color:#536159}@media(max-width:520px){main{padding:24px 16px}dl{display:block}dd{margin-bottom:10px}article{padding:12px}th,td{padding:10px}}@media print{body,main{background:white;color:black}main{max-width:none;padding:0;font-size:10pt}h1{font-size:24pt}h2{margin-top:20px}h2,h3,h4{break-after:avoid}h3{font-size:11pt;margin-bottom:5px}tr,li{break-inside:avoid}thead{display:table-header-group}li{margin:8px 0}article{border-radius:0;padding:8px}p,dd,li{line-height:1.35}dl{gap:3px 10px}.rule{font-size:10pt}.candidate{break-inside:auto}footer{font-size:10pt}}';

/** Render validated public input directly; never accept an unchecked report payload. */
export function renderEvidenceReport(input) {
  const report = createEvidenceReport(input), noEvidence = report.history.length === 0;
  const weights = new Map(report.weights.map(row => [row.worldId, row]));
  const comparison = report.worlds.map(world => {
    const row = weights.get(world.id);
    return '<tr><th scope="row">' + escape(world.label) + '<small>' + escape(world.id) + '</small></th><td>'
      + (row ? '≈ ' + escape(posteriorPercentage(row)) + '<small>Exact: ' + fraction(row.probability) + '</small>' : 'Undefined') + '</td></tr>';
  }).join('');
  const trials = report.history.map(event => {
    const clamped = Object.keys(event.intervention)[0], other = clamped === 'A' ? 'B' : 'A';
    return '<li><article data-trial-id="' + event.id + '"><h3>Trial ' + event.id + ' · ' + (event.kind === 'observe' ? 'Watch' : 'Intervene')
      + '</h3><dl><dt>Action</dt><dd>' + (event.kind === 'observe' ? 'Watch without changing either lamp.' : 'Clamp ' + lamps(event.intervention) + '.')
      + '</dd><dt>Observed outcome</dt><dd>' + lamps(event.outcome) + '</dd>'
      + (event.kind === 'intervene' ? '<dt>Recorded prediction</dt><dd>' + predictionPercentage(event.prediction) + ' chance that the other lamp, ' + other + ', would be ON.</dd>' : '')
      + '</dl></article></li>';
  }).join('');
  const rules = report.worlds.map(world => '<article class="candidate"><h3>' + escape(world.label)
    + '</h3><p>Model schema: <code>equivia.scm.v1</code>. Candidate ID: <code>' + escape(world.id) + '</code>. Observed variables: ' + world.observed.map(escape).join(', ') + '.</p>'
    + world.variables.map(variable => '<h4>Variable ' + escape(variable.id) + '</h4><p>Parents (in order): '
      + (variable.parents.length ? variable.parents.map(escape).join(', ') : 'none') + '. Noise bits: ' + escape(variable.noiseBits)
      + '.</p><p class="rule">Rule table (index: value): ' + variable.table.map((value, index) => index + ': ' + value).join(' · ') + '</p>').join('')
    + '</article>').join('');
  const notice = report.status === 'zero_evidence'
    ? '<p class="notice warning">None of these candidate models can explain the complete recorded evidence. Posterior weights are undefined; no candidate is identified as the winner.</p>'
    : noEvidence
      ? '<p class="notice">No trials have been recorded. These are the uniform starting weights, not evidence of support for any candidate.</p>'
      : '<p class="notice">Weights use equal starting weights over the public candidates and the complete recorded history. They measure relative support within this candidate set, not proof that any candidate is true.</p>';
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
    + escape(report.title) + ' — EQUIVIA evidence report</title><style>' + style + '</style></head><body><main><header><p class="eyebrow">EQUIVIA · Evidence report</p><h1>'
    + escape(report.title) + '</h1><p>' + report.history.length + ' recorded trial' + (report.history.length === 1 ? '' : 's') + ' · '
    + report.interventions + ' of ' + report.budget + ' intervention trials used · ' + report.worlds.length
    + ' public candidate models</p><p>This report captures the recorded public evidence and candidate rules at export. The stored hidden selection and replay seeds are omitted. Recorded evidence and your own text may still identify or suggest a candidate.</p></header>'
    + '<section aria-labelledby="weights"><h2 id="weights">' + (noEvidence ? 'Starting candidate weights' : 'Candidate weights after the recorded evidence')
    + '</h2>' + notice + '<table><thead><tr><th scope="col">Public candidate</th><th scope="col">'
    + (noEvidence ? 'Starting weight' : 'Posterior weight') + '</th></tr></thead><tbody>' + comparison
    + '</tbody></table><p>Exact probability of the recorded evidence under the candidate mixture: ' + fraction(report.evidence)
    + '. Displayed weight percentages are approximate.</p></section><section aria-labelledby="trials"><h2 id="trials">Recorded trials, in order</h2>'
    + (trials ? '<ol>' + trials + '</ol>' : '<p>No recorded trials.</p>')
    + '</section><section aria-labelledby="explanation"><h2 id="explanation">Current explanation at export</h2>'
    + (report.explanation ? '<p class="explanation">' + escape(report.explanation) + '</p>' : '<p>No explanation recorded.</p>')
    + '<p>This is the current explanation; it does not establish what the learner believed before any earlier trial.</p></section>'
    + '<section aria-labelledby="rules"><h2 id="rules">Complete public candidate rules</h2><p>These are the public binary structural models used for the weights above. Read the listed parent bits from left to right, then append the variable\u2019s local noise bits to form the binary table index. Local noise bits are independent and uniformly distributed; a clamp replaces that variable\u2019s rule. Table positions retain their original index order.</p>'
    + rules + '</section><footer><p>This standalone report is a readable evidence snapshot, not a session replay file. The stored hidden selection and replay seeds are omitted. Unrecorded trials and alternatives outside the listed candidate models are not evaluated.</p></footer></main></body></html>\n';
}
