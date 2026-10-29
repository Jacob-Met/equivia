/** Manual two-lamp authoring; scientific checks stay in the maintained engine. */
import { compareWorlds, distribution } from './engine.js';
import { validateAuthorResponse, verifyAuthoredProposal } from './model.js';

const IDS = ['A', 'B'];
const CLAMPS = [
  { key: 'A0', intervention: { A: 0 } },
  { key: 'A1', intervention: { A: 1 } },
  { key: 'B0', intervention: { B: 0 } },
  { key: 'B1', intervention: { B: 1 } },
];
const ALL_INTERVENTIONS = [
  {}, { A: 0 }, { A: 1 }, { B: 0 }, { B: 1 },
  { A: 0, B: 0 }, { A: 0, B: 1 }, { A: 1, B: 0 }, { A: 1, B: 1 },
];

export class CreatorError extends Error {
  constructor(code, message) { super(message); this.name = 'CreatorError'; this.code = code; }
}
function fail(code, message) { throw new CreatorError(code, message); }
function eighths(value) {
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    fail('INVALID_DRAFT', 'Each chance must be a whole number of eighths from 0 through 8.');
  }
  return value;
}
const noiseTable = count => Array.from({ length: 8 }, (_, index) => index < eighths(count) ? 1 : 0);

export function createDraft() {
  return {
    title: 'Matching lamps',
    worlds: [
      { id: 'manual-one', label: 'World 1', order: 'AB', rootOn: 4, childOff: 0, childOn: 8 },
      { id: 'manual-two', label: 'World 2', order: 'BA', rootOn: 4, childOff: 0, childOn: 8 },
    ],
    clamp: 'A1',
  };
}

/** Compile independent local probabilities to the existing binary truth tables. */
export function buildProposal(draft) {
  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.worlds) || draft.worlds.length !== 2) {
    fail('INVALID_DRAFT', 'A worksheet needs exactly two candidate worlds.');
  }
  const selected = CLAMPS.find(item => item.key === draft.clamp);
  if (!selected) fail('INVALID_DRAFT', 'Choose one supported single-lamp intervention.');
  const worlds = Array.from(draft.worlds, world => {
    if (!world || !['AB', 'BA'].includes(world.order)) {
      fail('INVALID_DRAFT', 'Choose A then B or B then A for each world.');
    }
    const [first, second] = world.order;
    return {
      schema: 'equivia.scm.v1', id: world.id, label: world.label, observed: [...IDS],
      variables: [
        { id: first, parents: [], noiseBits: 3, table: noiseTable(world.rootOn) },
        { id: second, parents: [first], noiseBits: 3,
          table: [...noiseTable(world.childOff), ...noiseTable(world.childOn)] },
      ],
    };
  });
  return validateAuthorResponse({
    schema: 'equivia.author.v1', title: draft.title, worlds,
    experiment: { intervention: { ...selected.intervention } },
  }, { variableIds: IDS });
}

/** Return useful comparisons even when valid worlds do not form a usable pair. */
export function checkDraft(draft) {
  try {
    const proposal = buildProposal(draft);
    const observational = compareWorlds(proposal.worlds, { observed: IDS, intervention: {} });
    const clamps = CLAMPS.map(({ key, intervention }) => ({
      key, intervention: { ...intervention },
      comparison: compareWorlds(proposal.worlds, { observed: IDS, intervention }),
    }));
    const checked = verifyAuthoredProposal(proposal, { variableIds: IDS });
    return {
      accepted: checked.accepted, proposal, observational, clamps, checked,
      ...(checked.accepted ? {} : { error: checked.error }),
    };
  } catch (error) {
    return { accepted: false, error: {
      code: typeof error.code === 'string' ? error.code : 'INVALID_DRAFT',
      message: error instanceof Error ? error.message : 'The worksheet could not be checked.',
    } };
  }
}

function countEighths(variable, parentValue) {
  const size = 2 ** variable.noiseBits;
  const table = variable.parents.length === 0
    ? variable.table
    : variable.table.slice(parentValue * size, (parentValue + 1) * size);
  const count = table.reduce((sum, bit) => sum + bit, 0) * 8 / size;
  if (!Number.isInteger(count) || count < 0 || count > 8) {
    fail('UNSUPPORTED_WORKSHEET', 'This rule cannot be represented in exact eighths. The draft is unchanged.');
  }
  return count;
}

/** Reopen the existing format without approximating or dropping counterfactual rows. */
export function draftFromProposal(raw) {
  const checked = verifyAuthoredProposal(raw, { variableIds: IDS });
  if (!checked.accepted) fail(checked.error.code, checked.error.message);
  const original = checked.proposal;
  const entries = Object.entries(original.experiment.intervention);
  if (entries.length !== 1) {
    fail('UNSUPPORTED_WORKSHEET', 'This worksheet requires a single-lamp intervention. The draft is unchanged.');
  }
  const draft = {
    title: original.title,
    worlds: original.worlds.map(world => {
      const [root, child] = world.variables;
      if (root.parents.length !== 0 || child.parents.length > 1 ||
          (child.parents.length === 1 && child.parents[0] !== root.id) ||
          root.noiseBits > 3 || child.noiseBits > 3) {
        fail('UNSUPPORTED_WORKSHEET', 'These rules cannot be represented by this two-lamp worksheet. The draft is unchanged.');
      }
      // Counts alone cannot preserve opposite responses to the same private input.
      // The probability controls generate nested threshold sets; refuse a richer
      // truth table rather than silently changing its cross-intervention coupling.
      if (child.parents.length === 1) {
        const size = 2 ** child.noiseBits;
        let rises = false, falls = false;
        for (let noise = 0; noise < size; noise++) {
          const before = child.table[noise], after = child.table[size + noise];
          rises ||= before === 0 && after === 1;
          falls ||= before === 1 && after === 0;
        }
        if (rises && falls) {
          fail('UNSUPPORTED_WORKSHEET', 'This rule uses random-input relationships that these probability controls cannot preserve. Use the original file in the laboratory; the worksheet draft is unchanged.');
        }
      }
      return {
        id: world.id, label: world.label ?? world.id, order: root.id + child.id,
        rootOn: countEighths(root, 0),
        childOff: countEighths(child, 0), childOn: countEighths(child, 1),
      };
    }),
    clamp: entries[0][0] + entries[0][1],
  };
  const rebuilt = buildProposal(draft);
  for (let index = 0; index < original.worlds.length; index++) {
    for (const intervention of ALL_INTERVENTIONS) {
      const before = distribution(original.worlds[index], { observed: IDS, intervention });
      const after = distribution(rebuilt.worlds[index], { observed: IDS, intervention });
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        fail('UNSUPPORTED_WORKSHEET', 'Reopening would change a calculated outcome. The draft is unchanged.');
      }
    }
  }
  const rechecked = verifyAuthoredProposal(rebuilt, { variableIds: IDS });
  if (!rechecked.accepted) {
    fail('UNSUPPORTED_WORKSHEET', 'The reconstructed pair did not preserve its checks. The draft is unchanged.');
  }
  return draft;
}
