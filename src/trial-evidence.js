import { EquiviaError, LIMITS, posterior } from './engine.js';

/**
 * Explain one recorded trial within the supplied public candidate set.
 * Uses the laboratory's uniform prior and independent-trial exact engine.
 * No selected hidden world, replay seed, prediction or later evidence enters
 * the selected trial's weights. Later records are nevertheless validated.
 */
export function explainTrial(worlds, publicHistory, index) {
  if (!Array.isArray(publicHistory) || publicHistory.length > LIMITS.history) {
    throw new EquiviaError('INVALID_HISTORY', `History must contain at most ${LIMITS.history} independent trials.`);
  }
  for (let i = 0; i < publicHistory.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(publicHistory, i)) {
      throw new EquiviaError('INVALID_HISTORY', 'History must contain a recorded trial at every index.');
    }
  }
  if (!Number.isInteger(index) || index < 0 || index >= publicHistory.length) {
    throw new EquiviaError('INVALID_INDEX', 'Select an existing recorded trial by its zero-based index.');
  }

  // Validate the entire bounded history, including records after the selection.
  // This also preserves engine validation of worlds and observed-only outcomes.
  posterior(worlds, publicHistory);
  const before = posterior(worlds, publicHistory.slice(0, index));
  const after = posterior(worlds, publicHistory.slice(0, index + 1));
  const selected = publicHistory[index];
  const event = {
    intervention: { ...selected.intervention },
    outcome: { ...selected.outcome },
  };
  const hypotheses = worlds.map((world, i) => ({
    worldId: world.id,
    // A singleton's evidence is P(recorded outcome | do(recorded action), world).
    // Unlike its normalized posterior, it retains informative exact zeros.
    likelihood: posterior([world], [event]).evidence,
    beforeWeight: before.status === 'ok' ? before.hypotheses[i].probability : null,
    afterWeight: after.status === 'ok' ? after.hypotheses[i].probability : null,
  }));
  return { status: after.status, index, before, after, hypotheses, event };
}
