import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** VDocs-Bench's neutral document: an ordered array of blocks (README §2.1). */
export type Attribute = 'bold' | 'italic' | 'underline' | 'highlight' | 'color' | 'font_size_pt';
export type MarkValue = boolean | string | number;
export interface Mark { start: number; end: number; attribute: Attribute; value: MarkValue }
export interface Block {
  id: string;
  type: string;
  text: string;
  marks: Mark[];
  level?: number;
  list_id?: string;
  list_kind?: string;
  item_number?: number;
  /** Depth inside nested lists; only set by the exporter, never by the benchmark. */
  list_depth?: number;
  rows?: string[][];
}
export type Doc = Block[];

export type ReferenceChange =
  | { kind: 'style'; block_id: string; attribute: Attribute; value: MarkValue; ranges: [number, number][] }
  | { kind: 'replace'; block_id: string; old: string; new: string; all: boolean }
  | { kind: 'delete'; block_ids: string[] }
  | { kind: 'order'; block_ids: string[] }
  | { kind: 'insert'; after_id: string; block: Block }
  | { kind: 'structure'; block_id: string; type: string; attributes: Record<string, unknown> }
  | { kind: 'generated_heading_style'; heading_text: string; attribute: Attribute; value: MarkValue }
  | { kind: 'fixed_footer'; type: string; text: string };

export interface Step { step_id: string; reference_changes?: ReferenceChange[]; generation_requirements?: unknown }
export interface Task {
  task_id: string;
  category: string;
  complexity: 'single' | 'multi';
  initial_document_ref: string;
  instruction_text: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  steps: Step[];
  evaluation_mode: 'deterministic' | 'hybrid';
  expected_document_ref: string;
  generation_scope?: GenerationScope;
  hard_constraints?: HardConstraints;
}
export type GenerationScope =
  | { mode: 'replace_text'; block_ids: string[] }
  | { mode: 'insert' | 'append'; after_id: string; new_block_count?: number; new_heading?: string; list_items?: number }
  | { mode: 'create_document' };
export interface HardConstraints {
  length?: { min: number; max: number; unit: 'non_whitespace_unicode' | 'english_words' };
  required_facts?: string[];
  required_structure?: string;
}

export interface Bench {
  root: string;
  version: string;
  tasks: Task[];
  initial(task: Task): Doc;
  /** Exact final document; undefined for writing tasks, whose answer is a specification. */
  expected(task: Task): Doc | undefined;
}

export function loadBench(root: string): Bench {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as { benchmark_version: string };
  const tasks = readFileSync(join(root, 'tasks/main.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Task);
  const read = (ref: string): unknown => JSON.parse(readFileSync(join(root, ref), 'utf8'));
  return {
    root, version: manifest.benchmark_version, tasks,
    initial: task => read(task.initial_document_ref) as Doc,
    expected: task => { const value = read(task.expected_document_ref); return Array.isArray(value) ? value as Doc : undefined; },
  };
}

/** Unicode code points: the benchmark's unit for every text range. */
export const chars = (text: string): string[] => Array.from(text);

export const DEFAULTS: Readonly<Record<Attribute, MarkValue | null>> = { bold: false, italic: false, underline: false, highlight: null, color: '#000000', font_size_pt: 12 };
export const ATTRIBUTES = Object.keys(DEFAULTS) as Attribute[];
export type CharAttrs = Partial<Record<Attribute, MarkValue>>;

/** Canonical attribute value: uppercase colors, numbers as numbers, and undefined for the default. */
export function canonicalValue(attribute: Attribute, value: MarkValue | null | undefined): MarkValue | undefined {
  if (value === null || value === undefined || value === false) return undefined;
  if (attribute === 'color' || attribute === 'highlight') value = String(value).toUpperCase();
  if (attribute === 'font_size_pt') value = Number(value);
  return value === DEFAULTS[attribute] ? undefined : value;
}

/** Expands overlapping mark ranges to one attribute record per code point (README §2 rule 6). */
export function charAttrs(block: Block): CharAttrs[] {
  const out = chars(block.text).map(() => ({} as CharAttrs));
  for (const mark of block.marks) {
    const value = canonicalValue(mark.attribute, mark.value);
    for (let i = Math.max(0, mark.start); i < Math.min(out.length, mark.end); i++) {
      if (value === undefined) delete out[i]![mark.attribute]; else out[i]![mark.attribute] = value;
    }
  }
  return out;
}

/** Merges per-character attributes back into minimal mark ranges. */
export function marksFromChars(attrs: readonly CharAttrs[]): Mark[] {
  const marks: Mark[] = [];
  for (const attribute of ATTRIBUTES) {
    let start = -1;
    for (let i = 0; i <= attrs.length; i++) {
      const value = attrs[i]?.[attribute], previous = i > 0 ? attrs[i - 1]![attribute] : undefined;
      if (start >= 0 && value !== previous) { marks.push({ start, end: i, attribute, value: previous! }); start = -1; }
      if (start < 0 && value !== undefined) start = i;
    }
  }
  return marks;
}
