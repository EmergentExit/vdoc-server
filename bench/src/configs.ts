/**
 * The experiment's system configurations (实验设计 "对比系统" and 实验三).
 * `env` is applied on top of the repository's .env. A configuration that still
 * needs code this repository does not have says so in `missing` and is refused.
 */
export interface SystemConfig {
  id: string;
  group: 'G1' | 'G2' | 'G3';
  description: string;
  env: Record<string, string>;
  /** Built by the harness rather than by the server's own registry (see s2-aligned.ts). */
  variant?: 's2-aligned';
  missing?: string;
}

const S3 = { VDOC_SERVER_MODEL: 'boson-worker' };

export const CONFIGS: readonly SystemConfig[] = [
  { id: 'S3', group: 'G1', description: 'Actor-Worker default: Haiku 5.5, thinking off, prefetch on', env: S3 },
  { id: 'S3-noprefetch', group: 'G1', description: 'S3 without prefetch (Pi reads the document and planning context itself)', env: { ...S3, VDOC_SERVER_WORKER_PREFETCH: 'false' } },
  { id: 'S3-think-low', group: 'G1', description: 'S3 with low thinking', env: { ...S3, VDOC_SERVER_WORKER_THINKING: 'low' } },
  { id: 'S3-think-medium', group: 'G1', description: 'S3 with medium thinking', env: { ...S3, VDOC_SERVER_WORKER_THINKING: 'medium' } },
  { id: 'S3-think-high', group: 'G1', description: 'S3 with high thinking', env: { ...S3, VDOC_SERVER_WORKER_THINKING: 'high' } },
  { id: 'S3-sonnet', group: 'G1', description: 'S3 with Sonnet 5.5 (thinking "off" becomes between_tools)', env: { ...S3, VDOC_SERVER_WORKER_MODEL: 'claude-sonnet-5-5' } },
  { id: 'S3-nobatch', group: 'G1', description: 'S3 without the batch-edits rule', env: S3, missing: 'a switch for the batch rule in delegated-model.ts' },
  { id: 'S3-olddelegation', group: 'G1', description: 'Higgs delegates through run_worker_agent (74228068)', env: S3, missing: 'a run against a checkout of 74228068' },
  { id: 'S2', group: 'G2', description: 'Single-agent cascade on Haiku 5.5, aligned with S3: worker editing rules, thinking off, caching on', env: { VDOC_SERVER_MODEL: 'cascade-claude:claude-haiku-5-5' }, variant: 's2-aligned' },
  { id: 'S2-unaligned', group: 'G2', description: 'The cascade exactly as the server builds it (its own rules, adaptive thinking at low effort)', env: { VDOC_SERVER_MODEL: 'cascade-claude:claude-haiku-5-5' } },
  { id: 'R1', group: 'G3', description: 'Boson realtime calls the document tools itself (motivation only)', env: { VDOC_SERVER_MODEL: 'boson' } },
  { id: 'R2', group: 'G3', description: 'OpenAI realtime calls the document tools itself (motivation only)', env: { VDOC_SERVER_MODEL: 'openai' } },
  { id: 'fake', group: 'G1', description: 'Scripted fake model: checks the harness, never results', env: { VDOC_SERVER_MODEL: 'fake' } },
];

export function configById(id: string): SystemConfig {
  const config = CONFIGS.find(c => c.id === id);
  if (!config) throw new Error(`Unknown configuration ${id}. Known: ${CONFIGS.map(c => c.id).join(', ')}`);
  return config;
}
