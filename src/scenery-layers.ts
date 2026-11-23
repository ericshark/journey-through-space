/** GPU layers for the incidental interstellar scenery described by `scenery.ts`. */
import { Group, Quaternion, Vector2, Vector3 } from 'three';
import type { Scenery } from './scenery';
import { StreakField, type StreakSpec } from './starfield';

interface LayerSpec extends StreakSpec {
  key: keyof Pick<Scenery, 'kuiper' | 'heliopause' | 'oort' | 'interstellar'>;
  opacity: number;
}
/** Sparse by design: no layer is dense enough to read as an obstacle field. */
const SPECS: LayerSpec[] = [
  {
    key: 'kuiper',
    count: 140,
    spread: [48, 34],
    depth: 170,
    size: 0.09,
    drift: 110,
    opacity: 0.5,
    colors: ['#b9c6d6', '#9fb4c8', '#d4dbe3'],
    seed: 11,
    streak: 10,
  },
  {
    key: 'heliopause',
    count: 38,
    spread: [60, 40],
    depth: 190,
    size: 5.2,
    drift: 70,
    opacity: 0.06,
    colors: ['#7f9bff', '#a98bff', '#6fc3ff'],
    seed: 23,
    streak: 6,
  },
  {
    key: 'oort',
    count: 190,
    spread: [70, 48],
    depth: 220,
    size: 0.07,
    drift: 150,
    opacity: 0.55,
    colors: ['#dfe7f1', '#c8d3e6', '#f3e8d6'],
    seed: 37,
    streak: 12,
  },
  {
    key: 'interstellar',
    count: 620,
    spread: [85, 58],
    depth: 300,
    size: 0.12,
    drift: 260,
    opacity: 0.95,
    colors: ['#ffffff', '#cfe0ff', '#ffe2b8', '#ffb98a', '#ff9a7a'],
    seed: 53,
    streak: 18,
  },
];
/** Fine dust that streams past on every flight; its weight is the warp envelope. */
const FLOW: StreakSpec = {
  count: 650,
  spread: [42, 30],
  depth: 260,
  size: 0.03,
  maxWidth: 2.2,
  drift: 620,
  colors: ['#dfe9ff', '#ffffff', '#ffe9cc', '#c9dcff'],
  seed: 97,
  streak: 24,
};
const FLOW_OPACITY = 0.33;

export interface LayerFrame {
  at: Vector3;
  /** Orientation whose local +Z is the camera's forward direction. */
  facing: Quaternion;
  scenery: Scenery;
  /** Monotonic odometer of route position travelled. */
  travel: number;
  /** Focal length in device pixels. */
  focal: number;
  stretch: number;
  viewport: Vector2;
  reduced?: boolean;
}

export class SceneryLayers {
  readonly group = new Group();
  private layers: { spec: LayerSpec; field: StreakField }[] = [];
  private flow = new StreakField(FLOW);
  constructor() {
    for (const spec of SPECS) {
      const field = new StreakField(spec);
      field.mesh.visible = false;
      this.group.add(field.mesh);
      this.layers.push({ spec, field });
    }
    this.flow.mesh.visible = false;
    this.group.add(this.flow.mesh);
  }
  update(f: LayerFrame) {
    this.group.position.copy(f.at);
    this.group.quaternion.copy(f.facing);
    // Interstellar stars thicken towards the galactic centre.
    const stars = f.scenery.interstellar * (0.45 + 0.55 * f.scenery.galactic);
    const set = (field: StreakField, weight: number, opacity: number) => {
      const u = field.material.uniforms;
      field.mesh.visible = weight > 0.002;
      u.uOpacity.value = weight * opacity;
      u.uTravel.value = f.reduced ? 0 : f.travel;
      u.uFocal.value = f.focal;
      u.uStretch.value = f.reduced ? 0 : f.stretch;
      u.uViewport.value.copy(f.viewport);
    };
    for (const { spec, field } of this.layers)
      set(
        field,
        spec.key === 'interstellar' ? stars : f.scenery[spec.key],
        spec.opacity,
      );
    set(this.flow, f.reduced ? 0 : f.stretch, FLOW_OPACITY);
  }
  /** Current layer weights, for diagnostics and tests. */
  get weights() {
    return Object.fromEntries(
      this.layers.map(({ spec, field }) => [
        spec.key,
        field.material.uniforms.uOpacity.value / spec.opacity,
      ]),
    );
  }
  dispose() {
    for (const { field } of this.layers) field.dispose();
    this.flow.dispose();
  }
}
