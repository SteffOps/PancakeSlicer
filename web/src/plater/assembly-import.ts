import type * as THREE from 'three';
import { T3 } from '../three-runtime';
import type { Config } from '../api/types';
import { convertStep, printerBed } from '../actions';
import { importing } from '../flow/import';
import { beginBusy } from '../state/busy';
import { documentGeneration, undoable } from '../state/history';
import { markStale, newId, setState, toast, type PlateObject, type StagedPart, type Volume } from '../state/store';
import { bakeStl, bedBounds, loadMesh, loadProject, volumeGeometry } from './geometry';
import type { ProjectItem } from './threemf';
import { STAGED_DEFAULT } from '../staged';

export interface AssemblyPart { name?: string; staged?: StagedPart; settings?: Config }
interface Piece { name: string; geometry: THREE.BufferGeometry; centre: THREE.Vector3; source?: File }

const stem = (name: string) => name.replace(/\.(stl|obj|3mf|step|stp)$/i, '');
const authored = (g: THREE.BufferGeometry) => new T3.Vector3(...(g.userData.sourceCentre as [number, number, number] ?? [0, 0, 0]));

async function projectPieces(file: File, name: string, offset: boolean): Promise<Piece[]> {
  const pieces: Piece[] = [];
  let items: ProjectItem[] = [];
  await loadProject(file, {
    items(list) { items = list; },
    mesh(i, geometry, centre) {
      const shift = offset ? new T3.Vector3(...items[i].origin) : new T3.Vector3();
      pieces.push({ name: items.length > 1 ? items[i].name : name, geometry, centre: centre.clone().sub(shift) });
    },
    missing() {},
  }, true);
  return pieces;
}

async function piecesOf(file: File, signal: AbortSignal): Promise<Piece[]> {
  if (/\.(step|stp)$/i.test(file.name)) return projectPieces(await convertStep(file, signal), stem(file.name), true);
  if (/\.3mf$/i.test(file.name)) return projectPieces(file, stem(file.name), false);
  const geometry = await loadMesh(file, undefined, false);
  return [{ name: stem(file.name), geometry, centre: authored(geometry), source: file }];
}

export async function importAssembly(files: File[], name: string, parts: AssemblyPart[] = []): Promise<PlateObject | null> {
  if (!files.length) return null;
  setState({ tab: 'prepare' });
  const generation = documentGeneration(), task = importing.begin('loading'), busy = beginBusy(`Loading ${name}`, task.signal);
  const pieces: Piece[] = [];
  try {
    for (const f of files) {
      const found = await piecesOf(f, task.signal);
      if (!task.current()) { found.forEach((p) => p.geometry.dispose()); return null; }
      pieces.push(...found);
    }
    if (!pieces.length) throw new Error(`Oops! We couldn't find any 3D geometry in ${name}.`);
    const area = await printerBed();
    if (!task.current() || generation !== documentGeneration()) return null;
    const [main, ...rest] = pieces, origin = main.centre, centre = bedBounds(area).center;
    const volumes: Volume[] = rest.map((p, k) => {
      const position = p.geometry.attributes.position.array as Float32Array, index = (p.geometry.index?.array as Uint32Array | undefined) ?? null;
      const box = p.geometry.boundingBox ?? new T3.Box3().setFromBufferAttribute(p.geometry.attributes.position as THREE.BufferAttribute);
      const at = box.getCenter(new T3.Vector3()).add(p.centre).sub(origin);
      const part = parts[k + 1];
      return { id: newId(), name: part?.name ?? p.name, type: 'part', extruder: 0, settings: part?.settings ?? {},
        geometry: volumeGeometry(position.slice(), index && index.slice(), p.geometry.attributes.normal?.array.slice() as Float32Array | undefined),
        matrix: new T3.Matrix4().makeTranslation(at.x, at.y, at.z).elements, staged: part?.staged ?? STAGED_DEFAULT };
    });
    rest.forEach((p) => p.geometry.dispose());
    const triangles = (main.geometry.index?.count ?? main.geometry.attributes.position.count) / 3;
    const source = main.source ?? new File([await bakeStl({ geometry: main.geometry, rotX: 0, rotY: 0, scale: [1, 1, 1] } as PlateObject)], `${main.name}.stl`, { type: 'model/stl' });
    const [{ blobDigest }, { assignBlobKey }] = await Promise.all([import('../api/blobs'), import('../persist/session')]);
    assignBlobKey(source, `sha256-${await blobDigest(source)}`);
    if (!task.current() || generation !== documentGeneration()) return null;
    const object: PlateObject = {
      id: newId(), name, partName: parts[0]?.name ?? main.name, geometry: main.geometry, rotX: 0, rotY: 0, scale: [1, 1, 1], extruder: 1, source,
      settings: parts[0]?.settings ?? {}, staged: parts[0]?.staged ?? STAGED_DEFAULT,
      simplification: { trianglesBefore: triangles, trianglesAfter: triangles, maxErrorMm: 0, kept: 'original' },
      ...(volumes.length ? { volumes } : {}),
      instances: [{ id: newId(), x: centre.x + origin.x, y: centre.y + origin.y, z: origin.z, rotZ: 0 }],
    };
    undoable('Add assembly', () => setState((s) => ({ objects: [...s.objects, object],
      selected: { object: object.id, instance: object.instances[0].id, allInstances: true }, job: markStale(s.job) })));
    task.done();
    return object;
  } catch (e) {
    pieces.forEach((p) => p.geometry.dispose());
    if (task.current()) { task.fail(e); toast('couldnt_load_2', { label: name, detail: e instanceof Error ? e.message : String(e) }); }
    return null;
  } finally {
    busy.end();
    if (task.current()) task.done();
  }
}
