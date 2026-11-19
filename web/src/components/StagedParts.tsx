import type { ConfigValue } from '../api/types';
import type { OptionDef } from '../options';
import { STAGED_DEFAULT, STAGED_STYLES, STAGED_TOOLS, isStaged, useAdvancedMode } from '../staged';
import { updateObject, updateVolume, useStore, type StagedPart } from '../state/store';
import { Field, TripleField } from './Field';
import { GroupHead, isGroupOpen, useSettingsGroups } from './SettingsGroup';
import './staged-parts.css';

type Scalar = 'stage' | 'style' | 'hingeAngle' | 'coneHalfAngle' | 'coneRadius' | 'tool' | 'tilt' | 'copies';
const ROWS: Record<Scalar, [key: string, definition: Partial<OptionDef>]> = {
  stage: ['staged_stage', { type: 'int', label: 'Stage', min: 1 }],
  style: ['staged_layer_style', { type: 'enum', label: 'Layer style', enum_values: STAGED_STYLES.map(([v]) => v), enum_labels: STAGED_STYLES.map(([, l]) => l) }],
  hingeAngle: ['staged_hinge_angle', { type: 'float', label: 'End angle', sidetext: '°', min: 0, max: 360 }],
  coneHalfAngle: ['staged_cone_half_angle', { type: 'float', label: 'Cone half-angle', sidetext: '°', min: 0, max: 90 }],
  coneRadius: ['staged_cone_radius', { type: 'float', label: 'Seed radius', sidetext: 'mm', min: 0 }],
  tool: ['staged_tool', { type: 'enum', label: 'Nozzle', enum_values: STAGED_TOOLS.map(([v]) => v), enum_labels: STAGED_TOOLS.map(([, l]) => l) }],
  tilt: ['staged_tool_tilt', { type: 'float', label: 'Tilt angle', sidetext: '°', min: 0, max: 120 }],
  copies: ['staged_copies', { type: 'int', label: 'Copies', min: 1, max: 64 }],
};
const AXIS_LABEL: Record<StagedPart['style'], string> = { flat: 'Build direction', hinge: 'Hinge axis', grow_cone: 'Cone axis' };

function PartRows({ part, set }: { part: StagedPart; set(next: StagedPart): void }) {
  const row = (field: Scalar) => {
    const [key, definition] = ROWS[field], value = String(part[field]), base = String(STAGED_DEFAULT[field]);
    const commit = (raw: ConfigValue | undefined) => {
      const text = String(raw ?? base);
      const next = typeof STAGED_DEFAULT[field] === 'number' ? Number(text) : text;
      if (typeof next === 'number' && !Number.isFinite(next)) return;
      set({ ...part, [field]: next });
    };
    return <Field key={key} optKey={key} type="process" value={value} systemValue={base} dirty={value !== base} definition={definition}
      onSet={(_, v) => commit(v)} onReset={() => commit(undefined)} resetTitle="Default"/>;
  };
  const triple = (key: string, label: string, field: 'point' | 'dir' | 'hingeStart') =>
    <TripleField key={key} optKey={key} label={label} values={part[field]} dirty={part[field].join() !== STAGED_DEFAULT[field].join()}
      onCommit={(values) => set({ ...part, [field]: values })} onReset={() => set({ ...part, [field]: STAGED_DEFAULT[field] })}/>;
  return <>
    {row('stage')}
    {row('style')}
    {triple('staged_axis_point', 'Axis point', 'point')}
    {triple('staged_axis_dir', AXIS_LABEL[part.style], 'dir')}
    {part.style === 'hinge' && <>{triple('staged_hinge_start', 'Start direction', 'hingeStart')}{row('hingeAngle')}</>}
    {part.style === 'grow_cone' && <>{row('coneHalfAngle')}{row('coneRadius')}</>}
    {row('tool')}
    {part.tool === 'fixed_tilt' && row('tilt')}
    {row('copies')}
  </>;
}

export default function StagedParts() {
  const advanced = useAdvancedMode();
  useSettingsGroups();
  const o = useStore((s) => s.selected && !s.selected.all ? s.objects.find((x) => x.id === s.selected!.object) : undefined);
  const staged = useStore((s) => !!o && isStaged(s, o));
  const picked = useStore((s) => s.selected?.volume);
  const report = useStore((s) => {
    const record = s.job.state === 'done' && !s.job.stale ? s.job.status?.record as { nonplanar_report?: { objects?: { name?: string; staged?: string }[] } } | undefined : undefined;
    return record?.nonplanar_report?.objects?.find((r) => r.name === o?.name.replace(/\.(stl|obj)$/i, ''))?.staged ?? '';
  });
  const levels = new Map(report.split('; ').flatMap((entry) => {
    const m = /^(.*): stage \d+, (\d+) levels x \d+ copies, ([\d.]+) to ([\d.]+) mm thick$/.exec(entry);
    return m ? [[m[1], `${m[2]} levels, ${m[3]} to ${m[4]} mm thick`] as const] : [];
  }));
  if (!advanced || !o || !staged || o.project) return null;
  const parts: { id: string; name: string; part: StagedPart; set(next: StagedPart): void }[] = [
    { id: 'main', name: o.partName ?? o.name, part: o.staged ?? STAGED_DEFAULT, set: (next) => updateObject(o.id, { staged: next }, 'Edit part settings') },
    ...(o.volumes ?? []).filter((v) => v.type === 'part').map((v) => ({ id: String(v.id), name: v.name, part: v.staged ?? STAGED_DEFAULT,
      set: (next: StagedPart) => updateVolume(o.id, v.id, { staged: next }, 'Edit part settings') })),
  ];
  const first = picked !== undefined && parts.some((p) => p.id === String(picked)) ? String(picked) : 'main';
  return <section className="ol-settings staged-parts" aria-label="Staged parts">
    <header className="ol-settings-head"><span className="ol-settings-name">Staged parts</span></header>
    {parts.map((p) => {
      const id = `staged/${o.id}/${p.id}`, open = isGroupOpen(id, p.id === first);
      return <section key={p.id} className="optgroup" data-collapsed={open ? undefined : ''}>
        <GroupHead id={id} title={p.name} open={open} modified={undefined} tag={`Stage ${p.part.stage}`}/>
        {levels.has(p.name) && <div className="ol-settings-head">{levels.get(p.name)}</div>}
        {open && <PartRows part={p.part} set={p.set}/>}
      </section>;
    })}
  </section>;
}

