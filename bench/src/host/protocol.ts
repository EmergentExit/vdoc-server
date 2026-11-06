import type { Doc } from '../neutral';

/** Messages between the main thread and the vdoc host worker. */
export type HostRequest = { id: number } & (
  | { op: 'catalog' }
  | { op: 'load'; doc: Doc; docId: string }
  | { op: 'call'; name: string; args: unknown; context: { callId: string; turnId: string; epoch: number } }
  | { op: 'abort'; callId: string }
  | { op: 'export' }
  | { op: 'dispose' }
);
export type HostResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export interface ToolEntry { name: string; description: string; parameters: Record<string, unknown> }
export interface Exported {
  json: { type: string; content?: unknown[] };
  revision: number;
  sessionId: string;
  records: { id: string; label: string; source: string; time: number; revision: number; turnId?: string }[];
}
