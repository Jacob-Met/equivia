import { distribution, validateWorld } from './engine.js';

/** Compare selection of natural runs with replacing one lamp's equation.
 * Both results describe this supplied world, never the session's hidden choice
 * or its posterior. `watched.evidence` is the natural selection's exact support.
 * Zero support deliberately preserves zero_evidence and an empty outcome list.
 */
export function compareObservation(world, clamp) {
  if (clamp === null || typeof clamp !== 'object' || Array.isArray(clamp)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(clamp))) {
    throw new TypeError('Choose exactly one observed lamp and a numeric binary value.');
  }
  const entries = Object.entries(clamp);
  if (entries.length !== 1 || !['A', 'B'].includes(entries[0][0])
      || ![0, 1].includes(entries[0][1])) {
    throw new TypeError('Choose exactly one observed lamp and a numeric binary value.');
  }
  const { observed } = validateWorld(world);
  if (!['A', 'B'].every(id => observed.includes(id))) {
    throw new TypeError('The comparison needs observed lamps A and B.');
  }
  const [selectedVariable, selectedValue] = entries[0];
  const observedVariable = selectedVariable === 'A' ? 'B' : 'A';
  const selection = { [selectedVariable]: selectedValue };
  return {
    worldId: world.id, selectedVariable, selectedValue, observedVariable,
    watched: distribution(world, { condition: selection, observed: [observedVariable] }),
    held: distribution(world, { intervention: selection, observed: [observedVariable] }),
  };
}
