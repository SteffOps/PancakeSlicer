import { requestPreset } from '../components/PresetCombo';
import { normalizeConfigValue } from '../config-values';
import { documentGeneration } from '../state/history';
import { getState, setOption, toast } from '../state/store';
import { stagedFromSettings } from '../staged';
import { importAssembly } from './assembly-import';
import type { SampleWorkflow } from './workflow-list';

export const workflowPieceUrl = (name: string) => `/api/handy-models/5axis/${encodeURIComponent(name)}`;

export async function loadWorkflow(flow: SampleWorkflow) {
  const generation = documentGeneration();
  const printer = () => getState().records.printers.find((r) => !r.archived && (r.name === flow.printer || r.nozzles.some((n) => n.variant === flow.printer)));
  const target = printer();
  if (target?.id !== getState().printer) await requestPreset('machine', 0, target?.id ?? flow.printer);
  if (generation !== documentGeneration() || !printer() || printer()!.id !== getState().printer) return;
  for (const [key, value] of Object.entries(flow.process)) setOption('process', key, normalizeConfigValue(key, value));
  try {
    const files = await Promise.all(flow.parts.map(async ({ file }) => {
      const r = await fetch(workflowPieceUrl(file), { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${file}: ${r.status} ${r.statusText}`);
      return new File([await r.blob()], file);
    }));
    if (generation !== documentGeneration()) return;
    await importAssembly(files, flow.label, flow.parts.map((p) => { const { staged, rest } = stagedFromSettings(p.settings); return { name: p.name, staged, settings: rest }; }));
  } catch (e) {
    toast('couldnt_load_2', { label: flow.label, detail: e instanceof Error ? e.message : String(e) });
  }
}
