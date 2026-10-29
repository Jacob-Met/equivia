import { createDraft, checkDraft, draftFromProposal, serializeWorksheet,
  draftFromWorksheet, WORKSHEET_MAX_BYTES } from '/src/creator.js';
import { fractionToNumber } from '/src/engine.js';

const $ = id => document.getElementById(id);
let draft = createDraft(), revision = 0, fileIntent = 0;
let checkedRevision = -1, checkedFingerprint = null;
let previousWorksheet = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function announce(message, { file = false } = {}) {
  $('creator-status').textContent = message;
  $('worksheet-feedback').textContent = file ? message : '';
  $('worksheet-feedback').hidden = !file;
}
function clampLabel(key) { return 'Hold ' + key[0] + (key[1] === '1' ? ' on' : ' off'); }
function fraction(value) {
  return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator;
}
function probability(value) {
  return fraction(value) + ' · ' + (100 * fractionToNumber(value)).toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
}
function readControls() {
  return {
    title: $('pair-title').value,
    worlds: draft.worlds.map((world, index) => ({
      id: world.id, label: $('world-' + index + '-label').value,
      order: $('world-' + index + '-order').value,
      rootOn: Number($('world-' + index + '-root').value),
      childOff: Number($('world-' + index + '-off').value),
      childOn: Number($('world-' + index + '-on').value),
    })),
    clamp: $('check-clamp').value,
  };
}
function updateRuleLabels() {
  for (let index = 0; index < 2; index++) {
    const [first, second] = $('world-' + index + '-order').value;
    $('world-' + index + '-root-label').textContent = 'Chance that ' + first + ' is on';
    $('world-' + index + '-off-label').textContent = 'Chance that ' + second + ' is on when ' + first + ' is off';
    $('world-' + index + '-on-label').textContent = 'Chance that ' + second + ' is on when ' + first + ' is on';
    $('world-' + index + '-rule-note').textContent = 'Set ' + first + ' first, then use its state to set ' + second +
      "'s chance. Equal conditional chances mean " + first + ' has no effect on ' + second + '.';
  }
}
function fillControls() {
  $('pair-title').value = draft.title;
  for (let index = 0; index < 2; index++) {
    const world = draft.worlds[index], prefix = 'world-' + index + '-';
    $(prefix + 'label').value = world.label;
    $(prefix + 'order').value = world.order;
    $(prefix + 'root').value = String(world.rootOn);
    $(prefix + 'off').value = String(world.childOff);
    $(prefix + 'on').value = String(world.childOn);
  }
  $('check-clamp').value = draft.clamp;
  updateRuleLabels();
}
function markDirty(message = 'Draft changed. Check this pair again before exporting.', file = false) {
  revision++;
  checkedRevision = -1;
  checkedFingerprint = null;
  $('save-pair').disabled = true;
  $('check-results').hidden = true;
  $('check-results').replaceChildren();
  updateRuleLabels();
  announce(message, { file });
}
function distributionTable(caption, comparison, proposal) {
  const wrap = element('div', undefined, 'creator-table-scroll');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption + ' probabilities');
  const table = element('table'); table.append(element('caption', caption));
  const head = element('thead'), heading = element('tr');
  for (const label of ['Outcome · A then B', ...proposal.worlds.map(world => world.label || world.id)]) {
    const cell = element('th', label); cell.scope = 'col'; heading.append(cell);
  }
  head.append(heading); table.append(head);
  const body = element('tbody');
  for (const key of ['00', '01', '10', '11']) {
    const row = element('tr'), label = element('th', key + ' · A ' + (key[0] === '1' ? 'on' : 'off') + ', B ' + (key[1] === '1' ? 'on' : 'off'));
    label.scope = 'row'; row.append(label);
    for (const world of proposal.worlds) {
      const value = comparison.distributions.find(item => item.worldId === world.id).outcomes.find(item => item.key === key).probability;
      row.append(element('td', probability(value)));
    }
    body.append(row);
  }
  table.append(body); wrap.append(table); return wrap;
}
function renderResult(result, current) {
  const box = $('check-results'); box.replaceChildren(); box.hidden = false;
  const summary = element('div', undefined, 'creator-check-summary');
  summary.dataset.accepted = String(result.accepted);
  if (!result.proposal) {
    summary.append(element('h3', 'This draft needs attention'), element('p', result.error.message));
    box.append(summary); return;
  }
  summary.append(element('h3', result.accepted ? 'Ready to export' : 'The pair needs another edit'));
  summary.append(element('p', 'Both worlds use valid executable rules.'));
  const same = result.observational.equivalent === true;
  summary.append(element('p', same
    ? 'Their complete observational distributions match exactly.'
    : 'Their observational distributions differ. Watching can already distinguish these probability distributions, so this pair does not meet the puzzle requirement.'));
  const selected = result.clamps.find(item => item.key === current.clamp);
  summary.append(element('p', selected.comparison.separates
    ? clampLabel(current.clamp) + ' gives different outcome probabilities.'
    : clampLabel(current.clamp) + ' gives the same outcome probabilities. Choose a separating clamp from the intervention menu, or change the rules.'));
  box.append(summary, distributionTable('Ordinary observation', result.observational, result.proposal));
  box.append(distributionTable(clampLabel(current.clamp), selected.comparison, result.proposal));
  box.append(element('p', 'Fractions are exact. Percentages are rounded for display.', 'creator-help'));
  const shared = selected.comparison.distributions[0].outcomes.filter(row =>
    row.probability.numerator !== '0' &&
    selected.comparison.distributions[1].outcomes.find(other => other.key === row.key).probability.numerator !== '0');
  box.append(element('p', shared.length
    ? 'Shared possible outcomes: ' + shared.map(row => row.key).join(', ') + '. A single such result still fits both candidates; different probabilities do not guarantee identification in one trial.'
    : 'These candidates have no shared possible outcome under this clamp. Within the entered rules, a result separates this specified pair.'));
  box.append(element('h3', 'All four single-lamp clamps'));
  const list = element('ul', undefined, 'creator-clamp-list');
  for (const item of result.clamps) {
    list.append(element('li', clampLabel(item.key) + ' — ' + (item.comparison.separates ? 'different distributions' : 'same distribution')));
  }
  box.append(list);
  if (!result.clamps.some(item => item.comparison.separates)) {
    box.append(element('p', 'None of these four single-lamp clamps distinguishes the pair. Different names or rule tables alone do not make an informative puzzle.'));
  }
}
function performCheck() {
  const current = readControls();
  const result = checkDraft(current);
  draft = current;
  renderResult(result, current);
  checkedRevision = result.accepted ? revision : -1;
  checkedFingerprint = result.accepted ? JSON.stringify(current) : null;
  $('save-pair').disabled = !result.accepted;
  announce(result.accepted
    ? 'Check complete: equal observations and a separating selected clamp. The current pair is ready to export.'
    : 'Check complete: this pair cannot be exported yet. ' + (result.error?.message || 'Review the comparisons.'));
  return result;
}
function downloadJSON(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (let index = 0; index < 2; index++) {
  for (const field of ['root', 'off', 'on']) {
    const select = $('world-' + index + '-' + field);
    for (let count = 0; count <= 8; count++) {
      const option = element('option', (count * 12.5) + '% (' + count + '/8)');
      option.value = String(count); select.append(option);
    }
  }
}
fillControls();
for (const input of document.querySelectorAll('.creator-world input,.creator-world select,#pair-title,#check-clamp')) {
  input.addEventListener('input', () => markDirty());
  input.addEventListener('change', () => markDirty());
}
$('check-pair').addEventListener('click', performCheck);
$('save-pair').addEventListener('click', () => {
  const current = readControls();
  if (checkedRevision !== revision || checkedFingerprint !== JSON.stringify(current)) {
    markDirty('The draft changed after its last check. Check it again before exporting.');
    return;
  }
  // Recheck the current controls at the export boundary, never a stale cached proposal.
  const result = checkDraft(current);
  if (!result.accepted) { performCheck(); return; }
  downloadJSON(JSON.stringify(result.proposal, null, 2) + '\n', 'equivia-world-pair.json');
  announce('World pair download requested. Open equivia-world-pair.json through the laboratory creator studio, then explicitly open it as a new investigation.');
});
$('save-worksheet').addEventListener('click', () => {
  try {
    // Ordinary edits live in the controls until the next check or open.
    downloadJSON(serializeWorksheet(readControls()), 'equivia-worksheet-draft.json');
    announce('Worksheet draft download requested. This file keeps your editing values; it is not a checked world pair.', { file: true });
  } catch (error) {
    announce('Could not save this worksheet draft. Your edits are unchanged. ' + error.message, { file: true });
  }
});

$('restore-worksheet').addEventListener('click', () => {
  if (!previousWorksheet) return;
  // Restoring is a newer file intent: pending reads must not replace it.
  fileIntent++;
  draft = previousWorksheet;
  previousWorksheet = null;
  $('restore-worksheet').disabled = true;
  $('restore-worksheet').hidden = true;
  $('worksheet-restore-help').hidden = true;
  fillControls();
  markDirty('Previous worksheet restored. This replaced your current edits and used the recovery copy. Check this pair again before exporting.', true);
  $('pair-title').focus();
});

function attachFileOpener(buttonId, inputId, { read, limit, tooLarge, opened, failed }) {
  $(buttonId).addEventListener('click', () => {
    // A newly opened picker supersedes earlier reads, including when cancelled.
    fileIntent++;
    $(inputId).click();
  });
  $(inputId).addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    const intent = ++fileIntent, capturedRevision = revision;
    try {
      if (file.size > limit) throw new Error(tooLarge);
      const next = read(await file.text());
      if (intent !== fileIntent) return;
      if (capturedRevision !== revision) {
        announce('The draft changed while the file was opening. It has been preserved; open the file again when ready.', { file: true });
        return;
      }
      // Capture the live controls only once this open is ready to replace them.
      // Failed, cancelled and stale reads leave the existing recovery copy alone.
      previousWorksheet = readControls();
      draft = next;
      fillControls();
      $('restore-worksheet').disabled = false;
      $('restore-worksheet').hidden = false;
      $('worksheet-restore-help').hidden = false;
      markDirty(opened + ' Restore previous worksheet can recover the edits this file replaced.', true);
    } catch (error) {
      if (intent !== fileIntent) return;
      announce(capturedRevision !== revision
        ? 'The draft changed while the file was opening and has been preserved.'
        : failed + ' The draft is unchanged. ' + error.message, { file: true });
    }
  });
}

attachFileOpener('open-pair', 'creator-file', {
  read: draftFromProposal, limit: 65536,
  tooLarge: 'This world-pair file exceeds the existing 65,536-byte authoring limit.',
  opened: 'World pair reopened. All original observation and clamp distributions were preserved exactly. Check the current draft before exporting.',
  failed: 'Could not open that pair.',
});
attachFileOpener('open-worksheet', 'worksheet-file', {
  read: draftFromWorksheet, limit: WORKSHEET_MAX_BYTES,
  tooLarge: 'This worksheet draft exceeds the 65,536-byte file limit.',
  opened: 'Worksheet draft opened. Check this pair before exporting a world pair.',
  failed: 'Could not open that worksheet draft.',
});
