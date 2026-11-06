import { ATTRIBUTES, canonicalValue, charAttrs, chars, type Block, type CharAttrs, type Doc, type ReferenceChange, type Task } from './neutral';

/**
 * Scores one run's final document against the benchmark (README §3.1–3.2, §11).
 *
 * Block identity comes from vdoc's stable block IDs, which the host seeds with
 * the benchmark's logical IDs. Blocks that were not in the initial document are
 * matched to the answer's new blocks by type and text, then in order. A block
 * the model deleted and re-created is therefore a different block (§2.1);
 * `content_equal` reports the identity-free comparison alongside.
 */
export interface StepScore { step_id: string; pass: boolean | null; failures: string[] }
export interface Score {
  /** null until a writing task's quality has been graded. */
  task_success: boolean | null;
  content_equal: boolean | null;
  steps: StepScore[];
  /** Passed steps / steps that could be decided automatically. */
  partial_completion: number | null;
  collateral_edit: boolean;
  collateral: string[];
  spec_errors: string[];
  writing?: WritingChecks;
}
export interface WritingChecks {
  generated_text: string[];
  length: { unit: string; value: number; min: number; max: number; pass: boolean }[];
  structure: { pass: boolean | null; note: string }[];
  /** Literal presence only: equivalent wording is allowed, so the grader decides. */
  facts_literal: Record<string, boolean>;
  needs_quality_grading: true;
}

// ---------------------------------------------------------------- alignment

/** LCS alignment of two code-point arrays: index in `a` → index in `b`. */
export function align(a: readonly string[], b: readonly string[]): Map<number, number> {
  const n = a.length, m = b.length, table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const map = new Map<number, number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { map.set(i++, j++); }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++; else j++;
  }
  return map;
}

// ---------------------------------------------------------------- replay

/**
 * Replays the reference changes on the initial texts, giving every character an
 * identity. This turns a style range stated "in the text of its own moment"
 * (README §2 rule 4) into positions in the final answer, and tells which
 * initial characters an authorised replace removed.
 */
interface Replay {
  /** Character identities per block in the final reference state. */
  final: Map<string, string[]>;
  /** Final-state positions each style change covers, keyed by the change. */
  styleTargets: Map<ReferenceChange, { blockId: string; positions: number[] }>;
  /** Each replace's occurrences: what the final text must read there, with up to 3 characters of context either side. */
  replaceTargets: Map<ReferenceChange, { blockId: string; windows: Window[]; found: boolean }>;
}
/** Text the result must contain; anchored when it reaches the block's start or end. */
interface Window { text: string; atStart: boolean; atEnd: boolean }
function windowIn(text: string, window: Window): boolean {
  if (window.atStart && window.atEnd) return text === window.text;
  if (window.atStart) return text.startsWith(window.text);
  if (window.atEnd) return text.endsWith(window.text);
  return text.includes(window.text);
}

function replay(task: Task, initial: Doc): Replay {
  const state = new Map<string, { ids: string[]; text: string[] }>();
  for (const block of initial) state.set(block.id, { ids: chars(block.text).map((_, i) => `i:${block.id}:${i}`), text: chars(block.text) });
  let fresh = 0;
  const styles: [ReferenceChange, string, string[]][] = [];
  const replaces: [ReferenceChange, string, { left: string | undefined; right: string | undefined; ids: string[] }[], boolean][] = [];
  for (const step of task.steps) for (const change of step.reference_changes ?? []) {
    if (change.kind === 'insert') state.set(change.block.id, { ids: chars(change.block.text).map((_, i) => `n:${change.block.id}:${i}`), text: chars(change.block.text) });
    if (change.kind === 'replace') {
      const block = state.get(change.block_id); if (!block) { replaces.push([change, change.block_id, [], false]); continue; }
      const old = chars(change.old), occurrences: { left: string | undefined; right: string | undefined; ids: string[] }[] = [];
      for (let i = 0; i + old.length <= block.text.length;) {
        if (old.length && old.every((c, k) => block.text[i + k] === c)) {
          const ids = chars(change.new).map(() => `r:${fresh++}`);
          occurrences.push({ left: block.ids[i - 1], right: block.ids[i + old.length], ids });
          block.ids.splice(i, old.length, ...ids); block.text.splice(i, old.length, ...chars(change.new));
          i += ids.length;
          if (!change.all) break;
        } else i++;
      }
      replaces.push([change, change.block_id, occurrences, occurrences.length > 0]);
    }
    if (change.kind === 'style') {
      const block = state.get(change.block_id);
      styles.push([change, change.block_id, block ? change.ranges.flatMap(([s, e]) => block.ids.slice(s, e)) : []]);
    }
  }
  const final = new Map([...state].map(([id, block]) => [id, block.ids]));
  const position = (blockId: string, ids: string[]) => { const order = final.get(blockId) ?? []; return ids.map(id => order.indexOf(id)).filter(i => i >= 0); };
  // A local window, not the whole block, so two replaces in one block are judged separately (README §3.1).
  const windows = (blockId: string, occurrences: { left: string | undefined; right: string | undefined; ids: string[] }[]) => {
    const { ids, text } = state.get(blockId)!;
    return occurrences.map((o): Window => {
      const inside = position(blockId, o.ids);
      const start = inside.length ? inside[0]! : o.left !== undefined ? ids.indexOf(o.left) + 1 : 0;
      const end = inside.length ? inside.at(-1)! + 1 : o.right !== undefined && ids.includes(o.right) ? ids.indexOf(o.right) : start;
      return { text: text.slice(Math.max(0, start - 3), end + 3).join(''), atStart: start - 3 <= 0, atEnd: end + 3 >= text.length };
    });
  };
  return {
    final,
    styleTargets: new Map(styles.map(([change, blockId, ids]) => [change, { blockId, positions: position(blockId, ids) }])),
    replaceTargets: new Map(replaces.map(([change, blockId, occurrences, found]) => [change, { blockId, windows: found ? windows(blockId, occurrences) : [], found }])),
  };
}

// ---------------------------------------------------------------- identity

/** Maps actual new-block IDs to the answer's new-block IDs. */
function mapNewBlocks(actual: Doc, expected: Doc, initialIds: ReadonlySet<string>): Map<string, string> {
  const actualNew = actual.filter(b => !initialIds.has(b.id)), expectedNew = expected.filter(b => !initialIds.has(b.id));
  const map = new Map<string, string>(), used = new Set<string>();
  for (const want of expectedNew) {
    const hit = actualNew.find(b => !used.has(b.id) && b.type === want.type && b.text === want.text && JSON.stringify(b.rows) === JSON.stringify(want.rows));
    if (hit) { map.set(hit.id, want.id); used.add(hit.id); }
  }
  const leftActual = actualNew.filter(b => !used.has(b.id)), leftExpected = expectedNew.filter(b => ![...map.values()].includes(b.id));
  leftExpected.forEach((want, i) => { const b = leftActual[i]; if (b) map.set(b.id, want.id); });
  return map;
}

/** Lists compare by grouping, not by their internal IDs (README §2 rule 7). */
function listGroups(doc: Doc): Map<string, string> {
  const names = new Map<string, string>(), out = new Map<string, string>();
  for (const block of doc) if (block.list_id !== undefined) {
    if (!names.has(block.list_id)) names.set(block.list_id, `L${names.size}`);
    out.set(block.id, names.get(block.list_id)!);
  }
  return out;
}

const STRUCTURE = ['type', 'level', 'list_kind', 'item_number', 'list_depth'] as const;
const structureOf = (block: Block) => Object.fromEntries(STRUCTURE.map(key => [key, block[key] ?? null]));

/** Two documents are the same in every compared property (README §2 rules 5–8); with `withIds`, block identity counts too. */
export function sameDocument(a: Doc, b: Doc, withIds = true): boolean { return canonical(a, id => id, withIds) === canonical(b, id => id, withIds); }

function canonical(doc: Doc, rename: (id: string) => string, withIds: boolean) {
  const groups = listGroups(doc);
  return JSON.stringify(doc.map(block => ({ ...(withIds ? { id: rename(block.id) } : {}), ...structureOf(block), list: groups.get(block.id) ?? null,
    text: block.text, attrs: charAttrs(block).map(a => Object.fromEntries(Object.entries(a).sort())), rows: block.rows ?? null })));
}

// ---------------------------------------------------------------- steps

function attrAt(attrs: readonly CharAttrs[], i: number, attribute: keyof CharAttrs) { return attrs[i]?.[attribute]; }

function checkChange(change: ReferenceChange, ctx: Context): string[] {
  const { actualById, expectedById, rep } = ctx;
  switch (change.kind) {
    case 'style': {
      const target = rep.styleTargets.get(change)!, actual = actualById.get(target.blockId), expected = expectedById.get(target.blockId);
      if (!actual) return [`${target.blockId}: block missing`];
      const want = canonicalValue(change.attribute, change.value);
      const map = align(chars(expected?.text ?? ''), chars(actual.text)), attrs = charAttrs(actual);
      const bad = target.positions.filter(p => { const a = map.get(p); return a === undefined || attrAt(attrs, a, change.attribute) !== want; });
      return bad.length ? [`${target.blockId}: ${change.attribute} not ${String(change.value)} at ${bad.length}/${target.positions.length} chars`] : [];
    }
    case 'replace': {
      const target = rep.replaceTargets.get(change)!, actual = actualById.get(target.blockId), expected = expectedById.get(target.blockId);
      if (!target.found) return [`${target.blockId}: reference text "${change.old}" not found (spec)`];
      if (!actual || !expected) return [`${target.blockId}: block missing`];
      const missing = target.windows.filter(window => !windowIn(actual.text, window));
      return missing.length ? [`${target.blockId}: "${change.old}" → "${change.new}" not done (${missing.length}/${target.windows.length})`] : [];
    }
    case 'delete': return change.block_ids.filter(id => actualById.has(id)).map(id => `${id}: still present`);
    case 'order': {
      const kept = change.block_ids.filter(id => expectedById.has(id));
      const missing = kept.filter(id => !actualById.has(id));
      if (missing.length) return [`order: ${missing.join(', ')} missing`];
      const positions = kept.map(id => ctx.actualIndex.get(id)!);
      return positions.every((p, i) => i === 0 || p > positions[i - 1]!) ? [] : [`order: got ${[...kept].sort((a, b) => ctx.actualIndex.get(a)! - ctx.actualIndex.get(b)!).join(',')}`];
    }
    case 'insert': {
      const id = change.block.id, actual = actualById.get(id), expected = expectedById.get(id);
      if (!actual || !expected) return [`insert ${id}: no matching new block`];
      const failures: string[] = [];
      if (actual.type !== expected.type || actual.text !== expected.text || (actual.level ?? null) !== (expected.level ?? null) || JSON.stringify(actual.rows) !== JSON.stringify(expected.rows))
        failures.push(`insert ${id}: content differs (${actual.type} "${actual.text.slice(0, 30)}")`);
      // New blocks already carry the answer's IDs, so the predecessors compare directly.
      const before = (doc: Doc, index: Map<string, number>) => { const i = index.get(id)!; return i > 0 ? doc[i - 1]!.id : null; };
      if (before(ctx.actual, ctx.actualIndex) !== before(ctx.expected, ctx.expectedIndex)) failures.push(`insert ${id}: wrong position`);
      return failures;
    }
    case 'structure': {
      const actual = actualById.get(change.block_id); if (!actual) return [`${change.block_id}: block missing`];
      const failures: string[] = [];
      if (actual.type !== change.type) failures.push(`${change.block_id}: type ${actual.type}, want ${change.type}`);
      for (const [key, value] of Object.entries(change.attributes)) {
        if (key === 'list_id') {
          // Every block the answer puts in this list must share one list in the result.
          const members = ctx.expected.filter(b => b.list_id === value).map(b => b.id);
          const groups = new Set(members.map(m => ctx.actualGroups.get(m) ?? `none:${m}`));
          if (groups.size !== 1 || !ctx.actualGroups.has(change.block_id)) failures.push(`${change.block_id}: not in one list with ${members.join(',')}`);
        } else if ((actual as unknown as Record<string, unknown>)[key] !== value) failures.push(`${change.block_id}: ${key}=${String((actual as unknown as Record<string, unknown>)[key])}, want ${String(value)}`);
      }
      return failures;
    }
    case 'generated_heading_style': {
      const heading = ctx.actual.find(b => b.type === 'heading' && b.text === change.heading_text);
      if (!heading) return [`heading "${change.heading_text}" missing`];
      const want = canonicalValue(change.attribute, change.value);
      return charAttrs(heading).every(a => a[change.attribute] === want) ? [] : [`heading "${change.heading_text}": ${change.attribute} not ${String(change.value)}`];
    }
    case 'fixed_footer': {
      const last = [...ctx.actual].reverse().find(b => b.type === 'paragraph');
      return last?.text === change.text ? [] : [`last paragraph is "${last?.text.slice(-30) ?? ''}", want "${change.text}"`];
    }
  }
}

interface Context {
  actual: Doc; expected: Doc; rep: Replay;
  actualById: Map<string, Block>; expectedById: Map<string, Block>;
  actualIndex: Map<string, number>; expectedIndex: Map<string, number>;
  actualGroups: Map<string, string>;
}

// ---------------------------------------------------------------- collateral

/**
 * Changes outside what the answer authorises (README §3.1): a property the
 * answer keeps as it was is not allowed to differ. Missing an authorised change
 * is not collateral.
 */
function collateral(initial: Doc, expected: Doc, actualRenamed: Doc, rep: Replay, protectedIds: (id: string) => boolean, newBlocksAllowed: (block: Block, index: number) => boolean): string[] {
  const found: string[] = [];
  const exp = new Map(expected.map(b => [b.id, b])), act = new Map(actualRenamed.map(b => [b.id, b]));
  const groups = { i: listGroups(initial), e: listGroups(expected), a: listGroups(actualRenamed) };
  const initialIds = new Set(initial.map(b => b.id));
  for (const block of initial) {
    if (!protectedIds(block.id)) continue;
    const e = exp.get(block.id), a = act.get(block.id);
    if (e && !a) { found.push(`${block.id}: deleted`); continue; }
    if (!e || !a) continue;
    for (const key of STRUCTURE) if ((block[key] ?? null) === (e[key] ?? null) && (a[key] ?? null) !== (block[key] ?? null)) found.push(`${block.id}: ${key} changed to ${String(a[key])}`);
    if (JSON.stringify(block.rows) === JSON.stringify(e.rows) && JSON.stringify(a.rows) !== JSON.stringify(block.rows)) found.push(`${block.id}: table changed`);
    // Characters: initial → answer by replay identity, answer → actual by alignment.
    const ids = rep.final.get(block.id) ?? [], toExpected = new Map(ids.map((id, p) => [id, p]));
    const expectedChars = chars(e.text), actualChars = chars(a.text), toActual = align(expectedChars, actualChars);
    const ia = charAttrs(block), ea = charAttrs(e), aa = charAttrs(a);
    let removed = 0, styled = 0;
    chars(block.text).forEach((_, i) => {
      const p = toExpected.get(`i:${block.id}:${i}`);
      if (p === undefined) return;            // an authorised replace removed it
      const q = toActual.get(p);
      if (q === undefined) { removed++; return; }
      if (ATTRIBUTES.some(attr => ia[i]![attr] === ea[p]![attr] && aa[q]![attr] !== ia[i]![attr])) styled++;
    });
    // An actual character the answer does not have must sit where the answer changed text too:
    // next to a replaced character, or in a gap an authorised replace opened.
    const initialIndex = (p: number) => { const id = ids[p]; return id?.startsWith('i:') ? Number(id.slice(id.lastIndexOf(':') + 1)) : undefined; };
    const matched = [...toActual].sort((x, y) => x[1] - y[1]);
    let inserted = 0;
    actualChars.forEach((_, q) => {
      if (matched.some(([, j]) => j === q)) return;
      const left = matched.filter(([, j]) => j < q).at(-1)?.[0] ?? -1, right = matched.find(([, j]) => j > q)?.[0] ?? ids.length;
      const between = Array.from({ length: right - left - 1 }, (_, k) => left + 1 + k);
      const li = left >= 0 ? initialIndex(left) : -1, ri = right < ids.length ? initialIndex(right) : chars(block.text).length;
      const authorised = between.length > 0 || li === undefined || ri === undefined || ri - li > 1;
      if (!authorised) inserted++;
    });
    if (removed) found.push(`${block.id}: ${removed} protected chars removed`);
    if (inserted) found.push(`${block.id}: ${inserted} chars inserted outside the authorised change`);
    if (styled) found.push(`${block.id}: style changed on ${styled} protected chars`);
  }
  // List membership between original blocks.
  const listed = initial.filter(b => protectedIds(b.id) && exp.has(b.id) && act.has(b.id));
  for (let x = 0; x < listed.length; x++) for (let y = x + 1; y < listed.length; y++) {
    const [p, q] = [listed[x]!.id, listed[y]!.id];
    const same = (g: Map<string, string>) => g.has(p) && g.get(p) === g.get(q);
    if (same(groups.i) === same(groups.e) && same(groups.a) !== same(groups.i)) found.push(`${p}/${q}: list membership changed`);
  }
  // Relative order of original blocks the answer keeps in place.
  const index = (doc: Doc) => new Map(doc.map((b, i) => [b.id, i]));
  const ii = index(initial), ei = index(expected), ai = index(actualRenamed);
  const kept = initial.filter(b => ei.has(b.id) && ai.has(b.id)).map(b => b.id);
  const moved = new Set<string>();
  for (let x = 0; x < kept.length; x++) for (let y = x + 1; y < kept.length; y++) {
    const [p, q] = [kept[x]!, kept[y]!];
    const before = (m: Map<string, number>) => m.get(p)! < m.get(q)!;
    if (before(ii) === before(ei) && before(ai) !== before(ii) && (protectedIds(p) || protectedIds(q))) { moved.add(p); moved.add(q); }
  }
  if (moved.size) found.push(`order changed: ${[...moved].join(', ')}`);
  actualRenamed.forEach((block, i) => { if (!initialIds.has(block.id) && !exp.has(block.id) && !newBlocksAllowed(block, i)) found.push(`unauthorised new ${block.type} "${block.text.slice(0, 30)}"`); });
  return found;
}

// ---------------------------------------------------------------- tasks

function contextFor(actual: Doc, expected: Doc, initial: Doc, rep: Replay): { ctx: Context; renamed: Doc } {
  const initialIds = new Set(initial.map(b => b.id));
  const map = mapNewBlocks(actual, expected, initialIds);
  const rename = (id: string) => map.get(id) ?? id;
  const renamed = actual.map(b => ({ ...b, id: rename(b.id) }));
  return {
    renamed,
    ctx: {
      actual: renamed, expected, rep,
      actualById: new Map(renamed.map(b => [b.id, b])), expectedById: new Map(expected.map(b => [b.id, b])),
      actualIndex: new Map(renamed.map((b, i) => [b.id, i])), expectedIndex: new Map(expected.map((b, i) => [b.id, i])),
      actualGroups: listGroups(renamed),
    },
  };
}

export function scoreDeterministic(task: Task, initial: Doc, expected: Doc, actual: Doc): Score {
  const rep = replay(task, initial);
  const spec_errors = [...rep.final].filter(([id, ids]) => { const e = expected.find(b => b.id === id); return e && ids.length !== chars(e.text).length; }).map(([id]) => `${id}: replayed reference text differs from the answer`);
  const { ctx, renamed } = contextFor(actual, expected, initial, rep);
  const steps = task.steps.map(step => { const failures = (step.reference_changes ?? []).flatMap(change => checkChange(change, ctx)); return { step_id: step.step_id, pass: failures.length === 0, failures }; });
  const found = collateral(initial, expected, renamed, rep, () => true, () => false);
  const exact = canonical(renamed, id => id, true) === canonical(expected, id => id, true);
  return {
    task_success: exact && found.length === 0, content_equal: canonical(actual, id => id, false) === canonical(expected, id => id, false),
    steps, partial_completion: steps.filter(s => s.pass).length / steps.length,
    collateral_edit: found.length > 0, collateral: found, spec_errors,
  };
}

// ---------------------------------------------------------------- writing

const nonWhitespace = (text: string) => chars(text.replace(/\s+/gu, '')).length;
const englishWords = (text: string) => (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;

/** Applies a writing task's deterministic reference changes to the initial document: what must hold outside the generated region. */
function protectedAnswer(task: Task, initial: Doc): Doc {
  const doc = initial.map(b => ({ ...b, marks: [...b.marks] }));
  for (const step of task.steps) for (const change of step.reference_changes ?? []) {
    if (change.kind === 'delete') for (const id of change.block_ids) doc.splice(doc.findIndex(b => b.id === id), 1);
    if (change.kind === 'style') { const b = doc.find(x => x.id === change.block_id); if (b) b.marks.push(...change.ranges.map(([start, end]) => ({ start, end, attribute: change.attribute, value: change.value }))); }
    if (change.kind === 'structure') { const b = doc.find(x => x.id === change.block_id); if (b) Object.assign(b, { type: change.type }, change.attributes); }
  }
  return doc;
}

export function scoreWriting(task: Task, initial: Doc, actual: Doc): Score {
  const scope = task.generation_scope!;
  const answer = protectedAnswer(task, initial);
  const rep = replay(task, initial);
  const initialIds = new Set(initial.map(b => b.id));
  // The generated region: the scoped blocks (or what replaced them in place), or the new blocks right after the anchor.
  const inRegion = new Set<string>();
  if (scope.mode === 'create_document') actual.forEach(b => inRegion.add(b.id));
  else if (scope.mode === 'replace_text') {
    actual.forEach((b, i) => {
      if (!scope.block_ids.includes(b.id)) return;
      inRegion.add(b.id);
      for (let j = i + 1; j < actual.length && !initialIds.has(actual[j]!.id); j++) inRegion.add(actual[j]!.id);
      for (let j = i - 1; j >= 0 && !initialIds.has(actual[j]!.id); j--) inRegion.add(actual[j]!.id);
    });
    // The model may have replaced the block outright: new blocks where it used to be.
    for (const id of scope.block_ids) if (!actual.some(b => b.id === id)) {
      const before = initial[initial.findIndex(b => b.id === id) - 1]?.id;
      let j = before ? actual.findIndex(b => b.id === before) + 1 : 0;
      for (; j < actual.length && !initialIds.has(actual[j]!.id); j++) inRegion.add(actual[j]!.id);
    }
  } else {
    let j = actual.findIndex(b => b.id === scope.after_id) + 1;
    for (; j > 0 && j < actual.length && !initialIds.has(actual[j]!.id); j++) inRegion.add(actual[j]!.id);
  }
  const ctx = contextFor(actual, answer, initial, rep).ctx;
  const steps: StepScore[] = [], length: WritingChecks['length'] = [], structure: WritingChecks['structure'] = [];
  const footer = task.steps.flatMap(s => s.reference_changes ?? []).find(c => c.kind === 'fixed_footer');
  const region = actual.filter(b => inRegion.has(b.id));
  const generatedText = (blocks: Doc) => blocks.filter(b => b.type !== 'heading' && b.type !== 'table' && !(footer && b === region.at(-1) && b.text === footer.text)).map(b => b.text);
  for (const step of task.steps) {
    const requirement = step.generation_requirements as { action?: string; length?: { min: number; max: number; unit: 'non_whitespace_unicode' | 'english_words' } } | undefined;
    if (!requirement) {
      const failures = (step.reference_changes ?? []).flatMap(change => checkChange(change, ctx));
      steps.push({ step_id: step.step_id, pass: failures.length === 0, failures });
      continue;
    }
    // A step that names one scoped block ("正式化 p1") is measured on that block alone.
    const named = scope.mode === 'replace_text' ? scope.block_ids.find(id => new RegExp(`\\b${id}\\b`).test(requirement.action ?? '')) : undefined;
    const blocks = named && actual.some(b => b.id === named) ? actual.filter(b => b.id === named) : region;
    const text = generatedText(blocks).join('\n');
    const failures: string[] = [];
    if (requirement.length) {
      const value = requirement.length.unit === 'english_words' ? englishWords(text) : nonWhitespace(text);
      const pass = value >= requirement.length.min && value <= requirement.length.max;
      length.push({ unit: requirement.length.unit, value, min: requirement.length.min, max: requirement.length.max, pass });
      if (!pass) failures.push(`length ${value} not in ${requirement.length.min}–${requirement.length.max}`);
    }
    const shape = structureCheck(task, scope, blocks);
    structure.push(shape);
    if (shape.pass === false) failures.push(`structure: ${shape.note}`);
    // Facts and quality need the grader: a step passes only after grading.
    steps.push({ step_id: step.step_id, pass: failures.length ? false : null, failures });
  }
  const found = collateral(initial, answer, actual, rep, id => !inRegion.has(id) && !(scope.mode === 'replace_text' && scope.block_ids.includes(id)), block => inRegion.has(block.id));
  const decided = steps.filter(s => s.pass !== null);
  const facts = task.hard_constraints?.required_facts ?? [];
  return {
    task_success: found.length || steps.some(s => s.pass === false) ? false : null,
    content_equal: null, steps, partial_completion: decided.length ? decided.filter(s => s.pass).length / decided.length : null,
    collateral_edit: found.length > 0, collateral: found, spec_errors: [],
    writing: { generated_text: generatedText(region), length, structure, needs_quality_grading: true,
      facts_literal: Object.fromEntries(facts.map(fact => [fact, generatedText(region).join('\n').includes(fact)])) },
  };
}

function structureCheck(task: Task, scope: NonNullable<Task['generation_scope']>, blocks: Doc): { pass: boolean | null; note: string } {
  const paragraphs = blocks.filter(b => b.type === 'paragraph');
  if (scope.mode === 'replace_text') return blocks.length === 1 && paragraphs.length === 1 ? { pass: true, note: 'one paragraph' } : { pass: false, note: `${blocks.map(b => b.type).join(',') || 'nothing'} in place of one paragraph` };
  if (scope.mode === 'insert' || scope.mode === 'append') {
    if (scope.new_heading) {
      const [heading, ...items] = blocks;
      const ok = heading?.type === 'heading' && heading.level === 2 && heading.text === scope.new_heading && items.length === scope.list_items
        && items.every(b => b.type === 'list_item' && b.list_kind === 'bullet' && b.list_id === items[0]!.list_id);
      return { pass: ok, note: blocks.map(b => `${b.type}${b.list_kind ? `/${b.list_kind}` : ''}`).join(',') };
    }
    const want = scope.new_block_count ?? 1;
    return blocks.length === want && paragraphs.length === want ? { pass: true, note: `${want} paragraph(s)` } : { pass: false, note: `${blocks.map(b => b.type).join(',') || 'nothing'}, want ${want} paragraph(s)` };
  }
  // create_document: the title is checkable; the rest of the layout is left to the grader.
  const title = /一级标题“([^”]+)”/.exec(task.hard_constraints?.required_structure ?? '')?.[1];
  const first = blocks[0];
  if (title && !(first?.type === 'heading' && first.level === 1 && first.text === title)) return { pass: false, note: `first block is ${first?.type ?? 'nothing'} "${first?.text ?? ''}", want level-1 heading "${title}"` };
  return { pass: null, note: 'title checked; section layout left to the grader' };
}

export function score(task: Task, initial: Doc, expected: Doc | undefined, actual: Doc): Score {
  return task.evaluation_mode === 'deterministic' && expected ? scoreDeterministic(task, initial, expected, actual) : scoreWriting(task, initial, actual);
}
