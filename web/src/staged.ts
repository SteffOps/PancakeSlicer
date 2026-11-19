import type { Config } from './api/types';
import { preferenceText, savePreferences, usePreference } from './saved-preferences';
import { bedBounds, parsePoints } from './plater/geometry';
import { effectiveConfig, printerPreset, type PlateObject, type StagedPart, type StagedStyle, type StagedTool, type State, type Vec3 } from './state/store';

export const ADVANCED_MODE = 'orca.advanced_mode';
export const advancedMode = () => preferenceText(ADVANCED_MODE) === '1';
export const useAdvancedMode = () => String(usePreference(ADVANCED_MODE) ?? '') === '1';
export const setAdvancedMode = (on: boolean) => savePreferences({ [ADVANCED_MODE]: on ? '1' : '0' });

export const STAGED_MODE = 'staged';
export const STAGED_DEFAULT: StagedPart = {
  stage: 1, style: 'flat', point: [0, 0, 0], dir: [0, 0, 1], hingeStart: [0, 0, 1], hingeAngle: 90,
  coneHalfAngle: 45, coneRadius: 0, tool: 'follow', tilt: 0, copies: 1,
};
export const STAGED_STYLES: [StagedStyle, string][] = [['flat', 'Flat'], ['hinge', 'Hinge'], ['grow_cone', 'Grow from cone']];
export const STAGED_TOOLS: [StagedTool, string][] = [['follow', 'Follow layer'], ['fixed_tilt', 'Fixed tilt']];

export const isStaged = (s: State, o: PlateObject) => String({ ...effectiveConfig(s, 'process'), ...o.settings }.nonplanar_mode ?? '') === STAGED_MODE;
export function stagedOrigin(s: State): (o: PlateObject) => [number, number] | null {
  const centre = bedBounds(parsePoints(printerPreset(s)?.config.printable_area)).center;
  return (o) => isStaged(s, o) ? [centre.x, centre.y] : null;
}

const vec = (v: Vec3) => v.join(',');
export function stagedConfig(p: StagedPart = STAGED_DEFAULT): Record<string, string> {
  return {
    staged_stage: String(p.stage), staged_layer_style: p.style, staged_axis_point: vec(p.point), staged_axis_dir: vec(p.dir),
    staged_hinge_start: vec(p.hingeStart), staged_hinge_angle: String(p.hingeAngle), staged_cone_half_angle: String(p.coneHalfAngle),
    staged_cone_radius: String(p.coneRadius), staged_tool: p.tool, staged_tool_tilt: String(p.tilt), staged_copies: String(p.copies),
  };
}

const number = (text: string | undefined, fallback: number) => text !== undefined && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : fallback;
const triple = (text: string | undefined, fallback: Vec3): Vec3 => {
  const parts = (text ?? '').split(/[,x]/).map((t) => Number(t.trim()));
  return parts.length === 3 && parts.every(Number.isFinite) ? parts as Vec3 : fallback;
};
const choice = <T extends string>(text: string | undefined, list: [T, string][], fallback: T): T => list.find(([v]) => v === text)?.[0] ?? fallback;

export function stagedFromSettings(settings: Record<string, string>): { staged: StagedPart; rest: Config } {
  const d = STAGED_DEFAULT, v = (k: string) => settings[`staged_${k}`];
  const staged: StagedPart = {
    stage: Math.max(1, Math.round(number(v('stage'), d.stage))), style: choice(v('layer_style'), STAGED_STYLES, d.style),
    point: triple(v('axis_point'), d.point), dir: triple(v('axis_dir'), d.dir), hingeStart: triple(v('hinge_start'), d.hingeStart),
    hingeAngle: number(v('hinge_angle'), d.hingeAngle), coneHalfAngle: number(v('cone_half_angle'), d.coneHalfAngle),
    coneRadius: number(v('cone_radius'), d.coneRadius), tool: choice(v('tool'), STAGED_TOOLS, d.tool), tilt: number(v('tool_tilt'), d.tilt),
    copies: Math.max(1, Math.round(number(v('copies'), d.copies))),
  };
  return { staged, rest: Object.fromEntries(Object.entries(settings).filter(([k]) => !k.startsWith('staged_'))) };
}
