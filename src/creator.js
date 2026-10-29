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

export const WORKSHEET_SCHEMA = 'equivia.worksheet.v1';
export const WORKSHEET_MAX_BYTES = 65536;
// Match the authored-pair identity domain; worksheet names may still be unfinished.
const WORKSHEET_ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const plainRecord = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function worksheetFields(value, fields, label) {
  if (!plainRecord(value) || Reflect.ownKeys(value).length !== fields.length ||
      fields.some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !Object.hasOwn(descriptor, 'value');
      })) {
    fail('INVALID_WORKSHEET', 'The ' + label + ' has missing or unsupported fields.');
  }
}
function worksheetText(value) {
  if (typeof value !== 'string' || value.length > 100 || /[\r\n]/.test(value)) {
    fail('INVALID_WORKSHEET', 'Worksheet titles and names must be single-line text of at most 100 characters.');
  }
  return value;
}
function worksheetValues(value) {
  worksheetFields(value, ['title', 'worlds', 'clamp'], 'worksheet');
  const title = worksheetText(value.title), entries = value.worlds;
  if (!Array.isArray(entries) || entries.length !== 2 || Reflect.ownKeys(entries).length !== 3 ||
      ['0', '1'].some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(entries, key);
        return !descriptor || !Object.hasOwn(descriptor, 'value');
      })) {
    fail('INVALID_WORKSHEET', 'A worksheet needs exactly two candidate worlds.');
  }
  if (!CLAMPS.some(item => item.key === value.clamp)) {
    fail('INVALID_WORKSHEET', 'Choose one supported single-lamp intervention.');
  }
  const worlds = Array.from(entries, world => {
    worksheetFields(world, ['id', 'label', 'order', 'rootOn', 'childOff', 'childOn'], 'worksheet world');
    if (typeof world.id !== 'string' || !WORKSHEET_ID.test(world.id)) {
      fail('INVALID_WORKSHEET', 'A world identifier must start with a letter and contain at most 40 letters, digits, hyphens or underscores.');
    }
    const label = worksheetText(world.label);
    if (!['AB', 'BA'].includes(world.order)) {
      fail('INVALID_WORKSHEET', 'Choose A then B or B then A for each world.');
    }
    for (const key of ['rootOn', 'childOff', 'childOn']) {
      if (!Number.isInteger(world[key]) || world[key] < 0 || world[key] > 8) {
        fail('INVALID_WORKSHEET', 'Each chance must be a whole number of eighths from 0 through 8.');
      }
    }
    return { id: world.id, label, order: world.order,
      rootOn: world.rootOn, childOff: world.childOff, childOn: world.childOn };
  });
  if (worlds[0].id === worlds[1].id) fail('INVALID_WORKSHEET', 'The two worlds need distinct identifiers.');
  return { title, worlds, clamp: value.clamp };
}

/** Preserve current editable values without claiming scientific acceptance. */
export function serializeWorksheet(draft) {
  return JSON.stringify({ schema: WORKSHEET_SCHEMA, ...worksheetValues(draft) }, null, 2) + '\n';
}

/** Read only the worksheet format; never trust or restore a saved check result. */
export function draftFromWorksheet(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > WORKSHEET_MAX_BYTES) {
      fail('WORKSHEET_TOO_LARGE', 'This worksheet draft exceeds the 65,536-byte file limit.');
    }
    try { value = JSON.parse(raw); }
    catch { fail('INVALID_WORKSHEET', 'This file is not valid JSON.'); }
  }
  const marker = plainRecord(value) && Object.getOwnPropertyDescriptor(value, 'schema');
  if (!marker || !Object.hasOwn(marker, 'value') || marker.value !== WORKSHEET_SCHEMA) {
    fail('UNSUPPORTED_WORKSHEET_FILE', marker && marker.value === 'equivia.author.v1'
      ? 'This is a world-pair file. Use Open an authored world pair.'
      : 'This is not a supported worksheet draft. Choose a worksheet draft saved by EQUIVIA.');
  }
  worksheetFields(value, ['schema', 'title', 'worlds', 'clamp'], 'worksheet file');
  return worksheetValues({ title: value.title, worlds: value.worlds, clamp: value.clamp });
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
