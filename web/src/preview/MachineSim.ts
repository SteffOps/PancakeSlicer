import * as THREE from 'three';
import type { PreviewData } from './data';
import { toolAxis } from './pose';

interface PackedMachinePart {
  name: string;
  file: string;
  link: 'carY' | 'cradleB' | 'tableC' | 'head';
  nv: number;
  nt: number;
  i32: boolean;
  min: [number, number, number];
  span: [number, number, number];
  b64: string;
}

interface PackedMachine {
  v: number;
  parts: PackedMachinePart[];
}

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const MACH = {
  bearing: [
    [12, 32, -54.5, -49.5, 'tableC'],
    [12, 36, -60, -55, 'cradleB'],
  ] as const,
  rodR: 4,
  xRods: { y: 30.5, z: [73, 118.1], len: 370 },
  yRods: { x: [-60, 60], feet: [-65, 100], footZ: -92, block: [34, 30, 22] as const, over: 60 },
  yLimits: [-70, 40] as const,
};

let cachedMachinePromise: Promise<PackedMachine | null> | null = null;

function fetchGoetheLabMachine(): Promise<PackedMachine | null> {
  if (!cachedMachinePromise) {
    cachedMachinePromise = fetch('/machines/goethelab-5axisfdm.json')
      .then((r) => (r.ok ? (r.json() as Promise<PackedMachine>) : null))
      .catch(() => null);
  }
  return cachedMachinePromise;
}

async function gunzipBase64(b64: string): Promise<ArrayBuffer> {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * Detailed opaque 3D hotend/nozzle assembly with tip at (0, 0, 0) and tool axis along +Z.
 * Used both as the tilted nozzle in Part View and mounted at the tip of the extruder in Machine Sim View.
 */
export function createNozzleAssembly(): THREE.Group {
  const g = new THREE.Group();

  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xdca843,
    metalness: 0.72,
    roughness: 0.28,
  });
  const blockMat = new THREE.MeshStandardMaterial({
    color: 0x2c3038,
    metalness: 0.35,
    roughness: 0.55,
  });
  const steelMat = new THREE.MeshStandardMaterial({
    color: 0xb0b8c4,
    metalness: 0.8,
    roughness: 0.25,
  });
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x4b5362,
    metalness: 0.65,
    roughness: 0.35,
  });
  const tipGlowMat = new THREE.MeshBasicMaterial({
    color: 0xffb84d,
  });

  // Brass tapered nozzle cone: tip at z = 0, expanding up to z = 4.4 mm
  const coneGeo = new THREE.CylinderGeometry(2.3, 0.32, 4.4, 24);
  coneGeo.rotateX(Math.PI / 2);
  coneGeo.translate(0, 0, 2.2);
  g.add(new THREE.Mesh(coneGeo, brassMat));

  // Subtle glowing molten orifice collar right at tip
  const collarGeo = new THREE.TorusGeometry(0.42, 0.14, 10, 20);
  collarGeo.translate(0, 0, 0.2);
  g.add(new THREE.Mesh(collarGeo, tipGlowMat));

  // Brass hex nut collar (z = 4.4 .. 7.4)
  const hexGeo = new THREE.CylinderGeometry(3.7, 3.7, 3.0, 6);
  hexGeo.rotateX(Math.PI / 2);
  hexGeo.translate(0, 0, 5.9);
  g.add(new THREE.Mesh(hexGeo, brassMat));

  // Heater block / silicone sock (z = 7.6 .. 18.6, slightly asymmetric like an E3D V6)
  const blockGeo = new THREE.BoxGeometry(20, 16, 11);
  blockGeo.translate(2.5, 0, 13.1);
  g.add(new THREE.Mesh(blockGeo, blockMat));

  // Heatbreak throat (z = 18.6 .. 23.0)
  const throatGeo = new THREE.CylinderGeometry(1.7, 1.7, 4.4, 16);
  throatGeo.rotateX(Math.PI / 2);
  throatGeo.translate(0, 0, 20.8);
  g.add(new THREE.Mesh(throatGeo, steelMat));

  // Heatsink core + cooling fins (z = 23.0 .. 36.0)
  const coreGeo = new THREE.CylinderGeometry(4.2, 4.2, 13.0, 20);
  coreGeo.rotateX(Math.PI / 2);
  coreGeo.translate(0, 0, 29.5);
  g.add(new THREE.Mesh(coreGeo, steelMat));

  const finGeo = new THREE.CylinderGeometry(10.5, 10.5, 1.0, 28);
  finGeo.rotateX(Math.PI / 2);
  for (let k = 0; k < 5; k++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.z = 24.0 + k * 2.75;
    g.add(fin);
  }

  return g;
}

/**
 * Full 5-axis BC-table / 3-axis printer digital twin overlay.
 * Renders translucent machine components in a secondary Three.js scene AFTER opaque G-code
 * segments so beads remain crisply visible through the translucent extruder and cradle.
 */
export class MachineSim {
  /** Secondary scene rendered after SegmentRenderer (preserving depth buffer). */
  readonly overlayScene = new THREE.Scene();

  private readonly carY = new THREE.Group();
  private readonly cradleB = new THREE.Group();
  private readonly tableC = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly gantry = new THREE.Group();
  private readonly partFrame = new THREE.Group();

  /** Opaque brass nozzle mounted in the main scene so it writes depth before translucent extruder. */
  readonly simNozzle = createNozzleAssembly();

  /** World matrix mapping part coordinates -> machine world coordinates (identity when sim off). */
  readonly tableMatrix = new THREE.Matrix4();

  private readonly machineParts: THREE.Object3D[] = [];
  private readonly ghostDepth = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
  private readonly materials: Record<string, THREE.Material>;
  private readonly geometries: THREE.BufferGeometry[] = [];

  private loadedGoetheLab = false;
  private loadingGoetheLab = false;
  private isFiveAxis = false;
  private active = false;
  private onMeshLoaded: () => void;

  constructor(onMeshLoaded: () => void) {
    this.onMeshLoaded = onMeshLoaded;

    // Lighting matching PreviewScene so ghosted CAD surfaces have clear 3D shading
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(-140, 160, 260);
    const fill = new THREE.DirectionalLight(0xc8d8f0, 0.55);
    fill.position.set(160, -140, 100);
    this.overlayScene.add(new THREE.AmbientLight(0xffffff, 0.65), key, fill);

    this.overlayScene.add(this.carY, this.head, this.gantry);
    this.carY.add(this.cradleB);
    this.cradleB.add(this.tableC);
    this.tableC.add(this.partFrame);

    const ghostMat = (color: number, opacity: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.58,
        metalness: 0.18,
        transparent: true,
        opacity,
        depthWrite: false,
        ...extra,
      });

    this.materials = {
      frame: ghostMat(0x52525b, 0.48, { roughness: 0.68 }),
      cradle: ghostMat(0x6b6b76, 0.52),
      rotary_table: ghostMat(0x5e606b, 0.56, { roughness: 0.42 }),
      extruder: ghostMat(0xa5abb6, 0.28, { metalness: 0.32, roughness: 0.5 }),
      bearing: ghostMat(0xa5abb6, 0.58, { metalness: 0.62, roughness: 0.34 }),
      rod: ghostMat(0x747882, 0.44, { metalness: 0.55, roughness: 0.36, vertexColors: true }),
      block: ghostMat(0x3f4149, 0.44),
    };

    this.buildProceduralHardware();
    this.simNozzle.visible = false;
    this.setVisible(false);
  }

  get hasGoetheLabMeshes(): boolean {
    return this.loadedGoetheLab;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isTableRotary(): boolean {
    return this.active && this.isFiveAxis;
  }

  private addGhost(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
    this.geometries.push(geo);
    for (const [m, order] of [
      [this.ghostDepth, 10],
      [mat, 11],
    ] as const) {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.renderOrder = order;
      parent.add(mesh);
      this.machineParts.push(mesh);
    }
  }

  private buildProceduralHardware() {
    // Dashed kinematic rotation axis indicators (B = green along Y, C = blue along Z)
    const addAxisLine = (a: THREE.Vector3, b: THREE.Vector3, color: number, parent: THREE.Object3D) => {
      const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
      this.geometries.push(geo);
      const line = new THREE.Line(
        geo,
        new THREE.LineDashedMaterial({ color, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.85 })
      );
      line.computeLineDistances();
      line.renderOrder = 13;
      parent.add(line);
      this.machineParts.push(line);
    };
    addAxisLine(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 135, 0), 0x30d158, this.carY);
    addAxisLine(new THREE.Vector3(0, 0, -80), new THREE.Vector3(0, 0, 45), 0x0a84ff, this.cradleB);

    // C-axis slewing bearing rings between rotary_table and cradle
    const links: Record<'tableC' | 'cradleB', THREE.Object3D> = {
      tableC: this.tableC,
      cradleB: this.cradleB,
    };
    for (const [r0, r1, z0, z1, link] of MACH.bearing) {
      const shape = new THREE.Shape().absarc(0, 0, r1, 0, TAU, false);
      shape.holes.push(new THREE.Path().absarc(0, 0, r0, 0, TAU, true));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 64 });
      geo.translate(0, 0, z0);
      this.addGhost(links[link], geo, this.materials.bearing);
    }

    // X-gantry rods & Y-axis linear guide rods with alpha-faded tips
    const addRod = (parent: THREE.Object3D, len: number, x: number, y: number, z: number, alongX: boolean) => {
      const geo = new THREE.CylinderGeometry(MACH.rodR, MACH.rodR, len, 20, 40, true);
      const pos = geo.attributes.position;
      const col = new Float32Array(pos.count * 4);
      const fade = 0.25 * len;
      for (let i = 0; i < pos.count; i++) {
        const t = Math.min(1, (len / 2 - Math.abs(pos.getY(i))) / fade);
        col[4 * i] = col[4 * i + 1] = col[4 * i + 2] = 1;
        col[4 * i + 3] = t * t * (3 - 2 * t);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
      if (alongX) geo.rotateZ(Math.PI / 2);
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.materials.rod);
      mesh.position.set(x, y, z);
      mesh.renderOrder = 12;
      parent.add(mesh);
      this.machineParts.push(mesh);
    };

    for (const z of MACH.xRods.z) {
      addRod(this.gantry, MACH.xRods.len, 0, MACH.xRods.y, z, true);
    }

    const [bw, bl, bh] = MACH.yRods.block;
    const zr = MACH.yRods.footZ - bh / 2;
    const y0 = Math.min(...MACH.yRods.feet) - bl / 2 - MACH.yLimits[1] - MACH.yRods.over;
    const y1 = Math.max(...MACH.yRods.feet) + bl / 2 - MACH.yLimits[0] + MACH.yRods.over;
    const blockGeo = new THREE.BoxGeometry(bw, bl, bh);
    for (const x of MACH.yRods.x) {
      addRod(this.overlayScene, y1 - y0, x, (y0 + y1) / 2, zr, false);
      for (const y of MACH.yRods.feet) {
        this.addGhost(this.carY, blockGeo, this.materials.block, x, y, zr);
      }
    }
  }

  ensureLoaded() {
    if (this.loadedGoetheLab || this.loadingGoetheLab) return;
    this.loadingGoetheLab = true;
    fetchGoetheLabMachine().then(async (pkg) => {
      if (!pkg) {
        this.loadingGoetheLab = false;
        return;
      }
      const links: Record<PackedMachinePart['link'], THREE.Object3D> = {
        carY: this.carY,
        cradleB: this.cradleB,
        tableC: this.tableC,
        head: this.head,
      };
      for (const p of pkg.parts) {
        const buf = await gunzipBase64(p.b64);
        const nv = p.nv;
        const q = new Uint16Array(buf, 0, nv * 3);
        const pos = new Float32Array(nv * 3);
        for (let a = 0; a < 3; a++) {
          const lo = p.min[a];
          const s = p.span[a] / 65535;
          const off = a * nv;
          for (let i = 0; i < nv; i++) pos[3 * i + a] = lo + q[off + i] * s;
        }
        const idx = p.i32 ? new Uint32Array(buf, nv * 6, p.nt * 3) : new Uint16Array(buf, nv * 6, p.nt * 3);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeVertexNormals();
        const mat = this.materials[p.name] ?? this.materials.frame;
        this.addGhost(links[p.link], geo, mat);
      }
      this.loadedGoetheLab = true;
      this.loadingGoetheLab = false;
      this.setVisible(this.active && this.isFiveAxis);
      this.onMeshLoaded();
    });
  }

  private setVisible(showFiveAxis: boolean) {
    for (const o of this.machineParts) o.visible = showFiveAxis;
    this.head.visible = showFiveAxis;
    this.gantry.visible = showFiveAxis;
  }

  /**
   * Update kinematic pose for move index `moveIndex` (or reset to identity if disabled/null).
   * Returns `tableMatrix` (identity when not in 5-axis machine sim mode).
   */
  update(data: PreviewData | null, moveIndex: number | null, simEnabled: boolean): THREE.Matrix4 {
    const hasOrient = !!data && data.orientation.length > 0;
    const isTableBC = hasOrient && !!data!.header?.tableRotary && !data!.header?.tableAC;
    const isTableAC = hasOrient && !!data!.header?.tableAC;
    this.isFiveAxis = isTableBC || isTableAC;
    this.active = simEnabled && !!data && moveIndex != null && moveIndex >= 0 && moveIndex < data.loaded;

    if (!this.active || !data || moveIndex == null) {
      this.tableMatrix.identity();
      this.carY.position.set(0, 0, 0);
      this.cradleB.rotation.set(0, 0, 0);
      this.tableC.rotation.set(0, 0, 0);
      this.setVisible(false);
      this.simNozzle.visible = false;
      return this.tableMatrix;
    }

    const px = data.pos[moveIndex * 4];
    const py = data.pos[moveIndex * 4 + 1];
    const pz = data.pos[moveIndex * 4 + 2];

    if (this.isFiveAxis) {
      this.ensureLoaded();
      const base = moveIndex * 3;
      const aDeg = data.orientation[base] ?? 0;
      const bDeg = data.orientation[base + 1] ?? 0;
      const cDeg = data.orientation[base + 2] ?? 0;

      if (isTableBC) {
        const B = bDeg * D2R;
        const C = cDeg * D2R;
        // Forward transform: m = Ry(B) * Rz(C) * p
        const cc = Math.cos(C), sc = Math.sin(C);
        const cb = Math.cos(B), sb = Math.sin(B);
        const x1 = cc * px - sc * py;
        const y1 = sc * px + cc * py;
        const xm = cb * x1 + sb * pz;
        const ym = y1;
        const zm = -sb * x1 + cb * pz;

        this.carY.position.set(0, -ym, 0);
        this.cradleB.rotation.set(0, B, 0);
        this.tableC.rotation.set(0, 0, C);
        this.head.position.set(xm, 0, zm);
        this.gantry.position.set(0, 0, zm);
        this.simNozzle.position.set(xm, 0, zm);
        this.simNozzle.quaternion.identity();
      } else {
        // Table AC: Rz(C) then Rx(-A) aligns toolAxis [sinA*sinC, sinA*cosC, cosA] to +Z
        const A = aDeg * D2R;
        const C = cDeg * D2R;
        const cc = Math.cos(C), sc = Math.sin(C);
        const ca = Math.cos(-A), sa = Math.sin(-A);
        const x1 = cc * px - sc * py;
        const y1 = sc * px + cc * py;
        const xm = x1;
        const ym = ca * y1 - sa * pz;
        const zm = sa * y1 + ca * pz;

        this.carY.position.set(0, -ym, 0);
        this.cradleB.rotation.set(-A, 0, 0);
        this.tableC.rotation.set(0, 0, C);
        this.head.position.set(xm, 0, zm);
        this.gantry.position.set(0, 0, zm);
        this.simNozzle.position.set(xm, 0, zm);
        this.simNozzle.quaternion.identity();
      }

      this.carY.updateMatrixWorld(true);
      this.tableMatrix.copy(this.tableC.matrixWorld);
      this.setVisible(true);
      this.simNozzle.visible = true;
      return this.tableMatrix;
    }

    // 3-axis / head-tilting printer: stationary bed, moving detailed hotend oriented along toolAxis
    this.tableMatrix.identity();
    this.setVisible(false);
    this.simNozzle.visible = true;
    this.simNozzle.position.set(px, py, pz);
    const axis = toolAxis(data, moveIndex);
    this.simNozzle.quaternion.setFromUnitVectors(Z_AXIS, new THREE.Vector3(axis[0], axis[1], axis[2]));
    return this.tableMatrix;
  }

  dispose() {
    for (const g of this.geometries) g.dispose();
    this.ghostDepth.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
