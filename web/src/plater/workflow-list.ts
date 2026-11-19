import { useEffect, useSyncExternalStore } from 'react';

export interface SampleWorkflow {
  id: string;
  label: string;
  printer: string;
  process: Record<string, string>;
  parts: { file: string; name: string; settings: Record<string, string> }[];
}

let workflows: SampleWorkflow[] = [], requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function request() {
  if (requested) return;
  requested = true;
  void fetch('/api/handy-workflows', { cache: 'no-cache' }).then((r) => r.ok ? r.json() as Promise<SampleWorkflow[]> : [])
    .then((list) => { workflows = Array.isArray(list) ? list : []; listeners.forEach((l) => l()); })
    .catch(() => { requested = false; });
}

export function useWorkflows(enabled: boolean): SampleWorkflow[] {
  useEffect(() => { if (enabled) request(); }, [enabled]);
  const list = useSyncExternalStore(subscribe, () => workflows);
  return enabled ? list : [];
}
