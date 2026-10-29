import { distribution, compareWorlds, fractionToNumber, lampWorlds } from '/src/engine.js';
import { createSession, receiveSession, serializeSession, observe, experiment, trialsRemaining,
  beliefState, learnerRequest, EXPERIMENTS, MAX_NOTEBOOK_BYTES } from '/src/session.js';
import { verifyAuthoredProposal } from '/src/model.js';
import { forecast } from '/src/forecast.js';

const $ = id => document.getElementById(id);
const STORE = 'equivia.notebook.v1';
const RECOVERY_LIMIT = 8;
const recoveryKey = slot => `${STORE}.recovery.${slot}`;
let preservedUnreadable = null, storageReadFailed = false, replacementUnverified = false;
let session, config, revision = 0, busy = false, modelBusy = false, authoredProposal = null;
const selected = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const target = () => selected('target');
const other = () => target() === 'A' ? 'B' : 'A';
const action = () => ({ [target()]: Number(selected('value')) });
const currentExperiment = () => EXPERIMENTS.find(item => JSON.stringify(item.intervention) === JSON.stringify(action()));
function predictionValue() {
  const raw = $('prediction-percent').value.trim(), value = Number(raw);
  return raw !== '' && Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : undefined;
}
const frac = value => value.denominator === '1' ? value.numerator : `${value.numerator}/${value.denominator}`;
const percent = value => {
  if (value.numerator === '0') return '0%';
  if (value.numerator === value.denominator) return '100%';
  const display = fractionToNumber(value) * 100;
  if (display < 0.1) return '<0.1%';
  if (display > 99.9) return '>99.9%';
  return `${display.toFixed(1).replace(/\.0$/, '')}%`;
};
const outcomeLabel = values => `A ${values.A ? 'on' : 'off'} · B ${values.B ? 'on' : 'off'}`;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function setDisclosure(buttonId, panelId, expanded) {
  $(panelId).hidden = !expanded;
  $(buttonId).setAttribute('aria-expanded', String(expanded));
}
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function persist() {
  // A fresh in-memory lesson must never replace an unreadable prior notebook.
  // Download the current lesson or explicitly preserve the original first.
  if (storageReadFailed || replacementUnverified || preservedUnreadable !== null) {
    $('save-status').textContent = 'Automatic saving paused · save your investigation to a file';
    return;
  }
  try { localStorage.setItem(STORE, serializeSession(session)); $('save-status').textContent = 'Notebook kept on this device'; }
  catch { $('save-status').textContent = 'Save a notebook file to keep this investigation'; }
}
function changed() { revision++; $('guide-advice').hidden = true; persist(); }
function download(text, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = element('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function downloadRecovery(text, name) {
  // JSON escapes lone UTF-16 surrogates instead of silently replacing them in a Blob.
  const copy = { schema: 'equivia.saved-notebook-recovery.v1', storageKey: STORE, storedText: text };
  download(JSON.stringify(copy, null, 2) + '\n', name);
  status('Recovery copy prepared. It contains saved text for repair and is not an ordinary notebook file.');
}
function recoveryCopies() {
  const copies = [];
  for (let slot = 1; slot <= RECOVERY_LIMIT; slot++) {
    const value = localStorage.getItem(recoveryKey(slot));
    if (value !== null) copies.push({ slot, value });
  }
  return copies;
}
function renderRecovery() {
  const panel = $('notebook-recovery'), archive = $('recovery-archive');
  archive.replaceChildren();
  let copies = [];
  try { copies = recoveryCopies(); } catch { /* Storage can be disabled. The current file export stays available. */ }
  const active = preservedUnreadable !== null;
  panel.hidden = !active && !storageReadFailed && !copies.length;
  $('unreadable-explanation').hidden = !active && !storageReadFailed;
  $('recovery-format').hidden = !active && !copies.length;
  $('recovery-format').textContent = 'Recovery files contain saved text for repair; they are not ordinary notebook files. '
    + (active ? 'The original recovery file contains the text first read when this page opened. ' : '')
    + 'Browser recovery copies remain in this browser and can be lost if its storage is cleared.';
  $('download-unreadable').hidden = !active;
  $('replace-unreadable').hidden = !active;
  $('replace-unreadable').disabled = replacementUnverified;
  if (storageReadFailed) {
    $('recovery-title').textContent = 'Saved notebook could not be read';
    $('unreadable-explanation').textContent = 'Automatic saving is paused to protect any notebook already stored in this browser. You can work on a temporary investigation and use Save notebook to keep it as a file. Reload to try reading the saved notebook again.';
  } else if (replacementUnverified) {
    $('recovery-title').textContent = 'Replacement could not be verified';
    $('unreadable-explanation').textContent = 'A separate browser recovery copy was verified before the replacement attempt. The current saved notebook could not be verified, so automatic saving remains paused. Use Save notebook to keep this investigation as a file, then reload to inspect what is stored.';
  } else {
    $('recovery-title').textContent = active ? 'Saved notebook needs recovery' : 'Browser recovery copies';
    $('unreadable-explanation').textContent = 'The text read when this page opened could not be reopened as a notebook. Automatic saving is paused. You can work on a temporary investigation. Replacing the saved notebook first requires a separate browser recovery copy to be saved and verified.';
  }
  for (const { slot, value } of copies) {
    const button = element('button', `Download browser recovery copy ${slot}`, 'outline');
    button.addEventListener('click', () => downloadRecovery(value, `equivia-browser-recovery-${slot}.json`));
    archive.append(button);
  }
  archive.hidden = !copies.length;
}
function focusRecoveryOutcome() {
  ($('notebook-recovery').hidden ? $('save-notebook') : $('recovery-title')).focus();
}
function replaceStoredNotebook() {
  if (preservedUnreadable === null || storageReadFailed || replacementUnverified) return;
  const original = preservedUnreadable;
  let replacementAttempted = false;
  try {
    if (localStorage.getItem(STORE) !== original) throw Error('The stored original changed in another window. Reload before replacing it.');
    const next = serializeSession(session);
    receiveSession(next); // The replacement must pass the complete executable replay validator.
    const copies = recoveryCopies();
    let slot = copies.find(item => item.value === original)?.slot;
    if (!slot) {
      for (let index = 1; index <= RECOVERY_LIMIT; index++) {
        if (!copies.some(item => item.slot === index)) { slot = index; break; }
      }
    }
    if (!slot) throw Error('All eight original-copy slots are occupied. Download earlier originals before using a fresh browser profile. Nothing was replaced.');
    const key = recoveryKey(slot);
    if (localStorage.getItem(key) === null) localStorage.setItem(key, original);
    if (localStorage.getItem(key) !== original) throw Error('The original recovery copy could not be independently read back.');
    if (localStorage.getItem(STORE) !== original) throw Error('The stored original changed while preserving the copy. Reload and inspect it.');
    replacementAttempted = true;
    localStorage.setItem(STORE, next);
    if (localStorage.getItem(STORE) !== next) throw Error('The saved notebook did not match the attempted replacement.');
    preservedUnreadable = null;
    renderRecovery();
    focusRecoveryOutcome();
    $('save-status').textContent = 'Notebook kept on this device · recovery copy verified';
    status('Current investigation saved after a separate browser recovery copy was verified.');
  } catch (error) {
    if (replacementAttempted) replacementUnverified = true;
    renderRecovery();
    if (replacementAttempted) focusRecoveryOutcome();
    $('save-status').textContent = 'Automatic saving paused · save your investigation to a file';
    status(replacementAttempted
      ? `Replacement could not be verified. Automatic saving remains paused. ${error.message}`
      : `Saved notebook not replaced: ${error.message}`, true);
  }
}
function freshSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
function clearPrediction() { $('prediction-percent').value = ''; }
function availability() {
  const remaining = trialsRemaining(session), prediction = predictionValue();
  const ready = !busy && !session.revealed && prediction !== undefined;
  $('run-one').disabled = !ready || remaining < 1;
  $('run-three').disabled = !ready || remaining < 3;
  $('observe').disabled = busy || session.revealed || session.history.length + 8 > 64 - remaining;
  $('debrief').disabled = busy || session.revealed || !session.history.some(event => event.kind === 'intervene');
  $('ask-guide').disabled = modelBusy || !config?.configured;
  $('propose-worlds').disabled = modelBusy || !config?.configured;
  document.querySelectorAll('[name="target"],[name="value"],#prediction-percent').forEach(input => { input.disabled = busy || session.revealed || remaining === 0; });
  $('run-hint').textContent = session.revealed ? 'Investigation complete. Start a new one to explore again.' : remaining === 0 ? 'Your experiment budget is used. Review the evidence, then finish.' : prediction === undefined ? 'Choose a prediction to begin.' : 'Each trial spends one experiment token.';
  $('prediction-question').textContent = `How often will ${other()} be on?`;
  $('budget').replaceChildren(element('span', `${remaining} / ${session.budget} trials left`));
  const dots = element('span', undefined, 'budget-dots');
  for (let i = 0; i < session.budget; i++) dots.append(element('span', undefined, `budget-dot${i >= remaining ? ' used' : ''}`));
  dots.setAttribute('aria-hidden', 'true'); $('budget').append(dots);
}
function renderObservations() {
  const observations = session.history.filter(event => event.kind === 'observe');
  const counts = { '00': 0, '01': 0, '10': 0, '11': 0 };
  observations.forEach(event => counts[`${event.outcome.A}${event.outcome.B}`]++);
  $('observation-summary').replaceChildren();
  for (const [key, label] of [['00', 'both off'], ['11', 'both on'], ['01', 'A off / B on'], ['10', 'A on / B off']]) {
    if ((key === '01' || key === '10') && !counts[key]) continue;
    const item = element('div', undefined, 'count-pair'); item.append(element('strong', counts[key]), element('span', label)); $('observation-summary').append(item);
  }
  const base = distribution(session.worlds[0], { observed: ['A', 'B'] });
  const terms = base.outcomes.filter(row => row.probability.numerator !== '0').map(row => `${outcomeLabel(row.values)}: ${frac(row.probability)}`);
  document.querySelector('.observation-note').textContent = `Exactly the same predicted distribution in both worlds (${terms.join('; ')}). More watching cannot separate this pair.`;
}
function renderLamps() {
  const latest = session.history.at(-1);
  if (!latest) return;
  for (const id of ['A', 'B']) {
    const on = latest.outcome[id] === 1, clamped = Object.hasOwn(latest.intervention, id);
    $(`lamp-${id}`).classList.toggle('lit', on); $(`lamp-${id}`).classList.toggle('clamped', clamped);
    $(`state-${id}`).textContent = on ? 'ON' : 'OFF';
    $(`clamp-${id}`).textContent = clamped ? `HELD ${on ? 'ON' : 'OFF'} BY YOUR CLAMP` : 'FOLLOWING ITS OWN RULE';
    $(`lamp-${id}`).querySelector('svg').setAttribute('aria-label', `Lamp ${id}: ${on ? 'on' : 'off'}${clamped ? ', clamped by the experiment' : ''}`);
  }
}
function renderHypotheses() {
  const beliefs = beliefState(session);
  $('hypothesis-list').replaceChildren();
  if (beliefs.status !== 'ok') { $('hypothesis-list').append(element('p', 'The evidence is impossible under all candidates. Inspect the notebook before continuing.')); return; }
  for (const world of session.worlds) {
    const probability = beliefs.hypotheses.find(item => item.worldId === world.id).probability;
    const card = element('div', undefined, `hypothesis${probability.numerator === '0' ? ' excluded' : ''}`);
    const heading = element('div', undefined, 'hypothesis-heading'); heading.append(element('h3', world.label || world.id), element('span', percent(probability), 'weight'));
    const graph = element('div', undefined, 'graph');
    const bFromA = world.variables.find(v => v.id === 'B')?.parents.includes('A');
    const aFromB = world.variables.find(v => v.id === 'A')?.parents.includes('B');
    graph.append(element('span', 'A', 'variable'), element('span', bFromA ? '⟶' : aFromB ? '⟵' : '···', 'arrow'), element('span', 'B', 'variable'));
    graph.setAttribute('aria-label', bFromA ? 'A is an input to B in this model' : aFromB ? 'B is an input to A in this model' : 'No direct input link between observed lamps in this model');
    const track = element('div', undefined, 'weight-track'), fill = element('span'); fill.style.width = `${fractionToNumber(probability) * 100}%`; track.append(fill);
    const exact = element('p', probability.numerator === '0' ? 'Excluded by the recorded evidence, within this model set.' : `Exact conditional weight ${frac(probability)}. ${probability.numerator === probability.denominator ? 'The other declared candidate is excluded.' : 'Still a possible explanation.'}`);
    card.append(heading, graph, track, exact); $('hypothesis-list').append(card);
  }
}
function renderComparison(intervention = action(), destination = $('prediction-comparison'), calculated) {
  destination.replaceChildren();
  const comparison = calculated ?? compareWorlds(session.worlds, { intervention, observed: ['A', 'B'] });
  for (const d of comparison.distributions) {
    const row = element('div', undefined, 'comparison-row'); row.append(element('strong', session.worlds.find(w => w.id === d.worldId)?.label || d.worldId));
    for (const outcome of d.outcomes.filter(item => item.probability.numerator !== '0')) row.append(element('div', `${outcomeLabel(outcome.values)} · ${percent(outcome.probability)} (${frac(outcome.probability)})`));
    destination.append(row);
  }
  destination.append(element('p', comparison.separates ? 'This experiment predicts different distributions. A shared possible outcome can still leave both explanations open.' : Object.keys(intervention).length ? 'This experiment predicts the same distribution in both worlds. It cannot distinguish this pair.' : 'Passive observation predicts the same distribution in both worlds. Watching alone cannot distinguish this pair.'));
}
function renderJournal() {
  const trials = session.history.filter(event => event.kind === 'intervene'); $('journal-entries').replaceChildren();
  if (!trials.length) $('journal-entries').append(element('p', 'Your observations agree with both explanations. The next entry is yours to create.', 'empty-journal'));
  trials.forEach((event, index) => {
    const [lamp, value] = Object.entries(event.intervention)[0];
    const row = element('div', undefined, 'journal-entry'); const text = element('div');
    text.append(element('h3', `Held ${lamp} ${value ? 'on' : 'off'}`), element('p', `Predicted ${event.prediction * 100}% chance of ${lamp === 'A' ? 'B' : 'A'} being on.`));
    row.append(element('span', String(index + 1).padStart(2, '0'), 'entry-number'), text, element('span', outcomeLabel(event.outcome), 'entry-outcome'));
    $('journal-entries').append(row);
  });
}
function renderDebrief() {
  $('debrief-content').hidden = !session.revealed;
  if (!session.revealed) return;
  const world = session.worlds.find(item => item.id === session.activeWorldId), beliefs = beliefState(session);
  const weight = beliefs.hypotheses.find(item => item.worldId === world.id).probability;
  $('debrief-content').replaceChildren(element('h3', `The hidden mechanism: ${world.label || world.id}`));
  $('debrief-content').append(element('p', `Your recorded evidence assigned this candidate ${percent(weight)} of the conditional weight. Revealing the authored answer is different from proving it from the experiments.`));
  const open = beliefs.hypotheses.filter(item => item.probability.numerator !== '0').length;
  $('debrief-content').append(element('p', open > 1 ? 'Both candidates still had a possible path to your results. The experiment changed what you could learn, but this finite record did not eliminate the alternative.' : 'One candidate assigned zero probability to an observed result. That excludes it within these declared worlds and assumptions. It does not rule out every mechanism that could exist outside this lesson.'));
  $('debrief-content').append(element('p', 'The structural world stayed fixed throughout. Each trial drew fresh random inputs. Passive observation had the same distribution in both worlds; clamping replaced one equation and let the remaining mechanism respond.'));
}
function renderAssumptions() {
  const rules = world => JSON.stringify(world.variables.map(({ id, parents, noiseBits, table }) => ({ id, parents, noiseBits, table })));
  const baseline = lampWorlds().map(rules).sort();
  const current = session.worlds.map(rules).sort();
  const matchingLamps = current.every((value, index) => value === baseline[index]);
  document.querySelector('.brief p').textContent = matchingLamps
    ? 'These two lights always agree. Does A drive B, or does B drive A?'
    : 'Two candidate mechanisms share the same observations. Which intervention can tell them apart?';
  document.querySelector('.method p').textContent = matchingLamps
    ? 'These are authored binary worlds. A root lamp is a fair random bit; the other follows its parent. The hidden structural world stays fixed, while every trial draws fresh noise. A clamp sets one variable without changing the other’s rule.'
    : 'These authored binary worlds use the displayed truth tables and independent uniform noise bits. Their structural mechanism stays fixed; every trial draws fresh noise. A clamp replaces the chosen equation. The exact rules determine whether the lamps agree and how often each outcome occurs.';
}
function render() {
  renderAssumptions();
  renderObservations(); renderLamps(); renderHypotheses(); renderJournal(); renderDebrief(); availability();
  if (!$('prediction-comparison').hidden) renderComparison();
  $('world-source').textContent = JSON.stringify(session.worlds, null, 2);
  document.querySelector('.introduction .eyebrow').textContent = `INVESTIGATION · ${session.title.toUpperCase()}`;
}
const publicHistory = state => state.history.map(({ intervention, outcome }) => ({ intervention, outcome }));
function renderForecastReflection(recent, reflection) {
  const { before, after, intervention, estimate } = reflection;
  const [clampedLamp, clampedValue] = Object.entries(intervention)[0];
  const lamp = before.observedVariable;
  const successes = recent.filter(event => event.outcome[lamp] === 1).length;
  const panel = element('section', undefined, 'forecast-reflection');
  panel.id = 'forecast-reflection';
  panel.setAttribute('aria-labelledby', 'forecast-title');
  const heading = element('h3', 'Reflect on this run'); heading.id = 'forecast-title';
  panel.append(heading, element('p',
    before.trials + ' trial' + (before.trials === 1 ? '' : 's') + ' · held ' + clampedLamp + ' ' +
    (clampedValue ? 'on' : 'off') + ' · ' + lamp + ' was on in ' + successes + ' of ' + before.trials + '.',
    'forecast-context'));
  panel.append(element('p', 'Chance of ' + lamp + ' being on in one trial with this clamp:', 'forecast-question'));
  const comparisons = element('dl', undefined, 'forecast-comparison');
  const metric = (label, value, id, exact) => {
    const item = element('div', undefined, 'forecast-metric');
    item.append(element('dt', label));
    const number = element('dd'); number.id = id;
    number.append(element('strong', value));
    if (exact) number.append(element('span', '(' + frac(exact) + ')', 'forecast-exact'));
    item.append(number); comparisons.append(item);
  };
  metric('Your estimate before', estimate + '%', 'forecast-estimate');
  metric('Models before this run', percent(before.singleTrialProbability), 'forecast-before', before.singleTrialProbability);
  metric('Updated for a next trial', percent(after.singleTrialProbability), 'forecast-after', after.singleTrialProbability);
  panel.append(comparisons, element('p',
    'The updated value uses all results from this run. It describes a hypothetical next trial with the same clamp, not the trials already recorded.',
    'forecast-note'));
  if (before.trials > 1) {
    const counts = element('div', undefined, 'forecast-counts');
    counts.id = 'forecast-counts';
    const title = element('h4', 'Before-run prediction for the whole ' + before.trials + '-trial count');
    const list = element('ol', undefined, 'forecast-count-list');
    for (const entry of before.counts) {
      const item = element('li', undefined, 'forecast-count' + (entry.count === successes ? ' observed-count' : ''));
      item.dataset.count = String(entry.count);
      item.append(element('span', entry.count + ' of ' + before.trials + ' on', 'forecast-count-label'),
        element('strong', percent(entry.probability)),
        element('span', '(' + frac(entry.probability) + ')', 'forecast-exact'));
      if (entry.count === successes) item.append(element('span', 'Observed', 'forecast-observed'));
      list.append(item);
    }
    counts.append(title, list, element('p',
      'One hidden world governs the whole run. These probabilities combine each candidate’s count prediction using the evidence available before this click.',
      'forecast-note'));
    panel.append(counts);
  }
  panel.append(element('p',
    'A short run need not match a probability estimate. This comparison is a prompt to revise your reasoning, not a score or proof of a mechanism.',
    'forecast-note'));
  return panel;
}

function showResult(previousLength, reflection) {
  const recent = session.history.slice(previousLength), beliefs = beliefState(session);
  const container = $('experiment-result'); container.hidden = false; container.replaceChildren(renderForecastReflection(recent, reflection));
  const chips = element('div', undefined, 'result-pairs'); recent.forEach(event => chips.append(element('span', outcomeLabel(event.outcome), 'result-chip'))); container.append(chips);
  const viable = beliefs.hypotheses.filter(item => item.probability.numerator !== '0');
  container.append(element('strong', viable.length === 2 ? 'Both explanations are still possible.' : 'One explanation no longer fits this result.'));
  container.append(element('div', viable.length === 2 ? 'The updated weights show how each candidate accounts for the evidence. A result both can produce does not by itself identify the mechanism.' : 'The excluded candidate gave at least one recorded outcome zero probability. This conclusion is specific to the candidate worlds and their assumptions.'));
  const last = recent.at(-1);
  for (const world of session.worlds) {
    const d = distribution(world, { intervention: last.intervention, observed: ['A', 'B'] });
    const probability = d.outcomes.find(row => row.values.A === last.outcome.A && row.values.B === last.outcome.B).probability;
    container.append(element('div', `Last result under ${world.label || world.id}: ${frac(probability)} probability.`, 'small'));
  }
}
async function run(count) {
  if (busy) return;
  const prediction = predictionValue(); if (prediction === undefined) return;
  busy = true; availability(); const before = session.history.length;
  try {
    const intervention = action(), estimate = String(Number($('prediction-percent').value.trim()));
    const initialForecast = forecast(session.worlds, publicHistory(session), intervention, count);
    const next = experiment(session, { intervention, prediction: Number(prediction), count });
    const updatedForecast = forecast(next.worlds, publicHistory(next), intervention, 1);
    const reflection = { before: initialForecast, after: updatedForecast, intervention, estimate };
    session = next; changed(); render(); showResult(before, reflection);
    status(`${count} experimental trial${count === 1 ? '' : 's'} recorded. ${trialsRemaining(session)} remaining.`);
  } catch (error) { status(error.message, true); }
  finally { busy = false; availability(); }
}
function openSession(next, message) {
  session = next; revision++; clearPrediction(); $('experiment-result').hidden = true; $('guide-advice').hidden = true;
  $('learner-explanation').value = session.explanation; persist(); render(); status(message);
}
async function requestModel(kind, body) {
  const response = await fetch(`/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(50000) });
  const value = await response.json();
  if (!response.ok || !value.ok) throw new Error(value.error?.message || 'The proposal did not pass the required checks. Your investigation is unchanged.');
  return value;
}
async function guide() {
  if (modelBusy || !config?.configured) return;
  const captured = revision; modelBusy = true; availability(); $('ask-guide').textContent = 'Considering your explanation…';
  try {
    const result = await requestModel('coach', learnerRequest(session));
    if (captured !== revision) return status('Your investigation changed while the guide was responding. Ask again with the current evidence.');
    const advice = result.advice, box = $('guide-advice'); box.replaceChildren(); box.hidden = false;
    box.append(element('h3', 'A possible reading'), element('p', advice.interpretation.label));
    if (advice.interpretation.quote) box.append(element('blockquote', advice.interpretation.quote));
    box.append(element('p', advice.interpretation.reviewPrompt || 'Does this match what you meant?'), element('p', advice.question));
    const tryIt = element('button', `Consider: ${advice.experiment.label || advice.experiment.id}`, 'text-button');
    tryIt.addEventListener('click', () => {
      const [id, value] = Object.entries(advice.experiment.intervention)[0];
      if (!['A', 'B'].includes(id) || ![0, 1].includes(value)) return;
      document.querySelector(`[name="target"][value="${id}"]`).checked = true;
      document.querySelector(`[name="value"][value="${value}"]`).checked = true;
      clearPrediction(); availability(); renderComparison(advice.experiment.intervention); setDisclosure('show-predictions', 'prediction-comparison', true);
      status('Suggested experiment selected. Make your own prediction before spending a trial.');
    });
    const reject = element('button', 'That is not what I meant', 'text-button');
    reject.addEventListener('click', () => { box.hidden = true; $('learner-explanation').focus(); status('Interpretation rejected. Revise your explanation or continue experimenting.'); });
    box.append(tryIt, element('br'), reject);
    const calculations = element('details', undefined, 'guide-facts');
    calculations.append(element('summary', 'Calculations used'));
    for (const fact of advice.facts) {
      const section = element('section');
      const clamp = Object.entries(fact.intervention).map(([id, value]) => `${id} held ${value ? 'on' : 'off'}`).join(', ');
      section.append(element('h4', clamp || 'Without a clamp'));
      const comparison = element('div');
      renderComparison(fact.intervention, comparison, fact.comparison);
      section.append(comparison); calculations.append(section);
    }
    box.append(calculations);
    status(`A reviewable question is ready from ${result.metadata?.model || config.model}. Your experiment record is unchanged.`);
  } catch (error) { status(error.name === 'TimeoutError' ? 'The guide took too long. Your investigation is unchanged.' : error.message, true); }
  finally { modelBusy = false; $('ask-guide').textContent = 'Question my reasoning ↗'; availability(); }
}
function displayAuthorProposal(result) {
  const checked = verifyAuthoredProposal(result.proposal ?? result, { variableIds: ['A', 'B'] });
  if (!checked.accepted) throw new Error(checked.error?.message || 'The world pair did not pass the exact checks.');
  authoredProposal = checked.proposal;
  const box = $('author-result'); box.hidden = false; box.replaceChildren(element('h3', authoredProposal.title));
  box.append(element('p', 'Exact check passed: the observable distributions match, and the proposed intervention separates them. This is a bounded mathematical result for the supplied rules.'));
  const source = element('details'); source.append(element('summary', 'Inspect the proposed executable worlds'), element('pre', JSON.stringify(authoredProposal, null, 2))); box.append(source);
  const adopt = element('button', 'Open as a new investigation', 'primary');
  adopt.addEventListener('click', () => {
    openSession(createSession({ worlds: authoredProposal.worlds, title: authoredProposal.title, seed: freshSeed() }), 'The checked world pair is open. Its actual mechanism remains hidden until you choose to reveal it.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  const save = element('button', 'Save this world pair', 'text-button');
  save.addEventListener('click', () => download(JSON.stringify(authoredProposal, null, 2) + '\n', 'equivia-world-pair.json'));
  box.append(adopt, save);
}

document.querySelectorAll('[name="target"],[name="value"]').forEach(input => input.addEventListener('change', () => { clearPrediction(); availability(); if (!$('prediction-comparison').hidden) renderComparison(); }));
$('prediction-percent').addEventListener('input', availability);
$('run-one').addEventListener('click', () => run(1)); $('run-three').addEventListener('click', () => run(3));
$('observe').addEventListener('click', () => {
  try { session = observe(session); changed(); render(); status('Eight more passive observations recorded. They have the same likelihood under both candidates.'); }
  catch (error) { status(error.message, true); }
});
$('show-predictions').addEventListener('click', () => { setDisclosure('show-predictions', 'prediction-comparison', $('prediction-comparison').hidden); if (!$('prediction-comparison').hidden) renderComparison(); });
$('inspect-worlds').addEventListener('click', () => { setDisclosure('inspect-worlds', 'world-source', $('world-source').hidden); });
$('learner-explanation').addEventListener('input', event => { session.explanation = event.target.value; changed(); });
$('ask-guide').addEventListener('click', guide);
$('debrief').addEventListener('click', () => { session.revealed = true; changed(); render(); status('The authored mechanism is revealed. Your notebook preserves what the evidence established before the reveal.'); });
$('new-investigation').addEventListener('click', () => openSession(createSession({ seed: freshSeed() }), 'A fresh matching-lamps investigation is ready. Make a prediction before trying a clamp.'));
$('save-notebook').addEventListener('click', () => {
  try { download(serializeSession(session), 'equivia-notebook.json'); status('Notebook saved with its worlds, predictions, ordered evidence and replay state.'); }
  catch (error) { status(error.message, true); }
});
$('download-unreadable').addEventListener('click', () => {
  if (preservedUnreadable !== null) downloadRecovery(preservedUnreadable, 'equivia-original-recovery.json');
});
$('replace-unreadable').addEventListener('click', replaceStoredNotebook);
$('open-notebook').addEventListener('click', () => $('notebook-file').click());
$('notebook-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const captured = revision;
  try {
    if (file.size > MAX_NOTEBOOK_BYTES) throw new Error('This notebook is too large.');
    const next = receiveSession(await file.text());
    if (captured !== revision) return status('The current investigation changed while opening the file. Open it again when ready.');
    openSession(next, 'Notebook reopened. Every recorded result was checked against its executable replay.');
  } catch (error) { status(`Could not open that notebook: ${error.message}`, true); }
});
$('propose-worlds').addEventListener('click', async () => {
  const brief = $('world-brief').value.trim(); if (!brief) return status('Describe the kind of mechanisms you want to explore.', true);
  if (modelBusy || !config?.configured) return;
  modelBusy = true; availability(); $('propose-worlds').textContent = 'Constructing and checking worlds…';
  try {
    const result = await requestModel('author', { brief, variableIds: ['A', 'B'] });
    displayAuthorProposal(result); status('A world pair passed exact checks. Inspect its rules before opening a new investigation.');
  } catch (error) { status(error.name === 'TimeoutError' ? 'World authoring took too long. Your current investigation is unchanged.' : error.message, true); }
  finally { modelBusy = false; $('propose-worlds').textContent = 'Propose a world pair ↗'; availability(); }
});
$('import-worlds').addEventListener('click', () => $('world-file').click());
$('world-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > MAX_NOTEBOOK_BYTES) throw new Error('This world file is too large.');
    displayAuthorProposal(JSON.parse(await file.text())); status('Imported world pair passed exact checks. Review it before opening.');
  } catch (error) { status(error.message, true); }
});

let storedOriginal = null, storageReadable = false;
try {
  storedOriginal = localStorage.getItem(STORE);
  storageReadable = true;
  session = storedOriginal !== null ? receiveSession(storedOriginal) : createSession();
  $('learner-explanation').value = session.explanation;
  status(storedOriginal !== null ? 'Your investigation is ready to continue.' : 'Both worlds fit everything you have observed. Choose a clamp, make a prediction, and try an experiment.');
} catch {
  storageReadFailed = !storageReadable;
  preservedUnreadable = storageReadable && storedOriginal !== null ? storedOriginal : null;
  session = createSession();
  status(preservedUnreadable !== null
    ? 'The saved notebook could not be reopened. Its original text is preserved; this new lesson will not overwrite it.'
    : 'The saved notebook could not be read. Automatic saving is paused; save this investigation as a file.', true);
}
render(); renderRecovery(); persist();
try {
  const response = await fetch('/api/config'); if (!response.ok) throw new Error('Unavailable');
  config = (await response.json()).model;
  $('model-status').textContent = config.configured ? `Optional guidance · ${config.model} on Nebius. Only the declared candidates, recorded evidence and your explanation are sent.` : 'Model guidance is not configured here. The complete laboratory and notebook work locally.';
} catch { $('model-status').textContent = 'Model guidance is unavailable in this session. Your laboratory works locally.'; }
availability();
