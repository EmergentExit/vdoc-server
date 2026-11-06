import { canonicalValue, charAttrs, chars, marksFromChars, type Block, type CharAttrs, type Doc } from './neutral';

/**
 * Converts between the benchmark's neutral blocks and vdoc's Tiptap JSON.
 *
 * Decisions that are ours, not the benchmark's (see bench/README.md):
 * - Font size: vdoc stores whole CSS pixels and its tool schema takes a unitless
 *   integer, so `font_size_pt: n` maps to `fontSize: "npx"` one to one.
 * - Bold is the explicit `bold` mark. A heading's inherited bold look is not
 *   semantic bold (README §2 rule 5); vdoc's `boldOff` override reads as not bold.
 * - Underline is the explicit `underline` mark; a link's underline is ignored.
 */
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; marks?: Json[]; text?: string };

function textContent(block: Block): Json[] {
  const text = chars(block.text), attrs = charAttrs(block), runs: Json[] = [];
  for (let i = 0; i < text.length;) {
    let j = i + 1;
    while (j < text.length && sameAttrs(attrs[i]!, attrs[j]!)) j++;
    const piece = text.slice(i, j).join('');
    const marks = tiptapMarks(attrs[i]!);
    // A newline is vdoc's hard break inside one block.
    piece.split('\n').forEach((part, k) => {
      if (k) runs.push({ type: 'hardBreak' });
      if (part) runs.push({ type: 'text', text: part, ...(marks.length ? { marks } : {}) });
    });
    i = j;
  }
  return runs;
}

const sameAttrs = (a: CharAttrs, b: CharAttrs) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function tiptapMarks(attrs: CharAttrs): Json[] {
  const marks: Json[] = [];
  if (attrs.bold) marks.push({ type: 'bold' });
  if (attrs.italic) marks.push({ type: 'italic' });
  if (attrs.underline) marks.push({ type: 'underline' });
  if (attrs.highlight) marks.push({ type: 'highlight', attrs: { color: attrs.highlight } });
  if (attrs.color || attrs.font_size_pt) marks.push({ type: 'textStyle', attrs: { color: attrs.color ?? null, fontFamily: null, fontSize: attrs.font_size_pt ? `${attrs.font_size_pt}px` : null } });
  return marks;
}

const paragraph = (block: Block): Json => ({ type: 'paragraph', attrs: { blockId: block.id }, content: textContent(block) });

/** Neutral blocks to a Tiptap document whose block IDs are the benchmark's logical IDs. */
export function toTiptap(doc: Doc): Json {
  const content: Json[] = [];
  for (let i = 0; i < doc.length; i++) {
    const block = doc[i]!;
    if (block.type === 'heading') content.push({ type: 'heading', attrs: { level: block.level ?? 1, blockId: block.id }, content: textContent(block) });
    else if (block.type === 'paragraph') content.push(paragraph(block));
    else if (block.type === 'list_item') {
      const items: Block[] = [block];
      while (doc[i + 1]?.type === 'list_item' && doc[i + 1]!.list_id === block.list_id) items.push(doc[++i]!);
      const ordered = block.list_kind !== 'bullet';
      content.push({ type: ordered ? 'orderedList' : 'bulletList', attrs: ordered ? { start: block.item_number ?? 1 } : {},
        content: items.map(item => ({ type: 'listItem', content: [paragraph(item)] })) });
    } else if (block.type === 'table') {
      content.push({ type: 'table', attrs: { blockId: block.id }, content: (block.rows ?? []).map((row, r) => ({ type: 'tableRow',
        content: row.map(cell => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [{ type: 'paragraph', content: cell ? [{ type: 'text', text: cell }] : [] }] })) })) });
    } else throw new Error(`Unsupported neutral block type ${block.type}`);
  }
  // Tiptap needs at least one block; an empty document is one empty paragraph (removed again on export).
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

function inlineText(node: Json): { text: string; attrs: CharAttrs[] } {
  let text = ''; const attrs: CharAttrs[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'hardBreak') { text += '\n'; attrs.push({}); continue; }
    if (child.type !== 'text' || !child.text) { const inner = inlineText(child); text += inner.text; attrs.push(...inner.attrs); continue; }
    const record = neutralAttrs(child.marks ?? []);
    text += child.text;
    for (const _ of chars(child.text)) attrs.push({ ...record });
  }
  return { text, attrs };
}

function neutralAttrs(marks: Json[]): CharAttrs {
  const out: CharAttrs = {};
  const set = <K extends keyof CharAttrs>(key: K, value: unknown) => { const v = canonicalValue(key, value as never); if (v !== undefined) out[key] = v; };
  for (const mark of marks) {
    if (mark.type === 'bold' || mark.type === 'italic' || mark.type === 'underline') set(mark.type, true);
    else if (mark.type === 'highlight') set('highlight', mark.attrs?.color ?? '#FFFF00');
    else if (mark.type === 'textStyle') {
      set('color', mark.attrs?.color);
      const size = mark.attrs?.fontSize;
      if (typeof size === 'string' && size.endsWith('px')) set('font_size_pt', Number.parseFloat(size));
    }
  }
  return out;
}

function textBlock(node: Json, type: string, extra: Partial<Block> = {}): Block {
  const { text, attrs } = inlineText(node);
  return { id: String(node.attrs?.blockId ?? ''), type, text, marks: marksFromChars(attrs), ...extra };
}

/** vdoc's Tiptap JSON to neutral blocks. Lists flatten to list_item blocks that keep their depth. */
export function fromTiptap(json: Json): Doc {
  const out: Doc = [];
  const visitList = (list: Json, depth: number) => {
    const kind = list.type === 'orderedList' ? 'ordered' : list.type === 'bulletList' ? 'bullet' : 'task';
    const start = Number(list.attrs?.start ?? 1);
    (list.content ?? []).forEach((item, index) => {
      let first = true;
      for (const child of item.content ?? []) {
        if (child.type === 'orderedList' || child.type === 'bulletList' || child.type === 'taskList') { visitList(child, depth + 1); continue; }
        // A list item's extra paragraphs stay separate blocks of that item.
        out.push(textBlock(child, first ? 'list_item' : 'list_item_continuation', {
          list_id: String(list.attrs?.blockId ?? ''), list_kind: kind, item_number: kind === 'ordered' ? start + index : index + 1,
          ...(depth ? { list_depth: depth } : {}) }));
        first = false;
      }
    });
  };
  for (const node of json.content ?? []) {
    if (node.type === 'heading') out.push(textBlock(node, 'heading', { level: Number(node.attrs?.level ?? 1) }));
    else if (node.type === 'paragraph') out.push(textBlock(node, 'paragraph'));
    else if (node.type === 'orderedList' || node.type === 'bulletList' || node.type === 'taskList') visitList(node, 0);
    else if (node.type === 'table') out.push({ id: String(node.attrs?.blockId ?? ''), type: 'table', text: '', marks: [],
      rows: (node.content ?? []).map(row => (row.content ?? []).map(cell => (cell.content ?? []).map(p => inlineText(p).text).join('\n'))) });
    else out.push(textBlock(node, node.type));
  }
  return out;
}

/**
 * Removes empty paragraphs that were not in the initial document: vdoc adds a
 * trailing empty paragraph after a final list or table, and an empty document
 * holds one placeholder paragraph. Returns how many were removed so a strict
 * analysis can still count them (README §2 rule 2).
 */
export function dropHostPlaceholders(doc: Doc, initialIds: ReadonlySet<string>): { doc: Doc; removed: number } {
  const kept = doc.filter(block => !(block.type === 'paragraph' && block.text === '' && !initialIds.has(block.id)));
  return { doc: kept, removed: doc.length - kept.length };
}
