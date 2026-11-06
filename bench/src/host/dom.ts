import { JSDOM } from 'jsdom';

// The same browser surface vdoc's own tests run in (vitest environment "jsdom").
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const window = dom.window as unknown as Record<string, unknown> & { Range: { prototype: Record<string, unknown> } };
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => window[key] });
}
Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
// jsdom has no layout (vdoc's tests/setup.ts stubs the same two methods).
window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
window.Range.prototype.getClientRects = () => [];
