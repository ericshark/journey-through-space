import {
  AmbientLight,
  BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material,
} from 'three';
import { vertexShader, fragmentShader } from './blackhole.glsl';
import { smooth } from './science';
import { buildVoyager, loadVoyager, disposeVoyager } from './voyager';
import { SceneryLayers } from './scenery-layers';
import { sceneryAt } from './scenery';
import { CHECKPOINTS } from './journey';
import { SPACING, type FlightState } from './flight';
import {
  ASSETS,
  HERO,
  configureTexture,
  residentAssets,
  residentStops,
} from './assets';
import {
  RING_INNER,
  RING_OUTER,
  atmosphereMaterial,
  cloudShellMaterial,
  coronaMaterial,
  earthMaterial,
  glintMaterial,
  proximaMaterial,
  ringMaterial,
  sunMaterial,
  surfaceMaterial,
} from './planet-materials';
import { DEFAULT_LIGHT, lookFor, type WorldLook } from './worlds';
import { BASE_FOV, exposureFor, warpAt, type GlareSource } from './warp';
import { Starfield, skyRotation } from './starfield';
import { Post, forcedTier, selectTier, tierSettings, type Tier } from './post';

const assets = new Map<string, Texture>();
export const LOAD_TIMEOUT_MS = 10_000;
/** Uniforms that point at a base map and may be upgraded to its 8K hero. */
interface HeroSlot {
  name: string;
  uniform: { value: Texture | null };
  active?: boolean;
}
interface Node {
  group: Group;
  body?: Mesh;
  clouds?: Mesh;
  ring?: Mesh;
  field?: Points;
  glint: Points;
  look?: WorldLook;
  light: Vector3;
  heroes: HeroSlot[];
  probe?: Group;
}
const FALLBACK_LOOK: WorldLook = {
  surface: 'rock',
  tilt: 0,
  oblateness: 0,
  light: DEFAULT_LIGHT,
  sun: 1.6,
  ambient: [0.001, 0.001, 0.001],
  glint: [1, 1, 1],
};
export class JourneyRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private renderer: WebGLRenderer;
  private loseContextExt: {
    loseContext: () => void;
    restoreContext: () => void;
  } | null = null;
  private gpuFence: WebGLSync | null = null;
  private busyTicks = 0;
  private drawnKey = '';
  private pendingAssets = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private scene = new Scene();
  private horizonScene = new Scene();
  private horizonTarget = new WebGLRenderTarget(1, 1, { depthBuffer: false });
  private horizonComposite = new Scene();
  private horizonCompositeMaterial = new MeshBasicMaterial({
    map: this.horizonTarget.texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private horizonCompositeQuad = new Mesh(
    new PlaneGeometry(2, 2),
    this.horizonCompositeMaterial,
  );
  private horizonCamera = new Camera();
  private horizonMaterial = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uResolution: { value: new Vector2() },
      uTime: { value: 0 },
      uCamPos: { value: new Vector3() },
      uCamBasis: { value: new Matrix3() },
      uTanHalfFov: { value: 0.36 },
      uSky: { value: null as Texture | null },
      uGalFromLens: { value: new Matrix3() },
      uOpacity: { value: 0 },
      uDarkness: { value: 0 },
      uOffset: { value: new Vector2() },
    },
  });
  private horizonQuad = new Mesh(new PlaneGeometry(2, 2), this.horizonMaterial);
  private camera = new PerspectiveCamera(36, 1, 0.01, 500);
  private object = new Group();
  private sun!: DirectionalLight;
  private body?: Mesh;
  private clouds?: Mesh;
  private ring?: Mesh;
  private scratch = new Matrix4();
  private nodes = new Map<number, Node>();
  private scenery = new SceneryLayers();
  private starfield = new Starfield();
  private post: Post;
  private software = false;
  private floatTargets = false;
  private forced: Tier | null = forcedTier();
  private heroes = new Map<string, { texture?: Texture }>();
  private skyHero?: Texture;
  private skyHeroLoading = false;
  private voyagerLoading = false;
  private voyager?: Group;
  private disposed = false;
  private horizonWidth = 0;
  private horizonHeight = 0;
  private horizonDrawKey = '';
  /** Odometer of route position travelled, driving near-field parallax. */
  private odometer = 0;
  private lastPosition: number | null = null;
  diagnostics = {
    loaded: [] as number[],
    textures: [] as string[],
    warp: 0,
    pending: 0,
    quality: 0.85,
    tier: 'low' as Tier,
    contextLost: false,
    reducedMotion: false,
    camera: [0, 0, 0] as number[],
    yaw: 0,
    nodeIds: {} as Record<number, string>,
    scenery: {} as Record<string, number>,
    fov: 0,
    beta: 0,
    stretch: 0,
    exposure: { scene: 1, sky: 1 },
    heroes: [] as string[],
    bank: 0,
    target: { x: 0, y: 0, visible: false },
    horizonSize: [0, 0],
    voyagerModel: false,
  };
  private scale = 0.85;
  private last = 0;
  private spinTime = 0;
  private spinRate = 1;
  private slow = 0;
  private loader = new TextureLoader();
  private field?: Points;
  frames = 0;
  textureFailures = 0;
  timedOutTextures = 0;
  contextLost = false;
  fallbackPinned = false;
  onStatusChange?: () => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
  /** Textures requested but not yet decoded; acceptance checks wait for zero. */
  pendingTextures = 0;
  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    this.gpuFence = null;
    this.diagnostics.contextLost = true;
    this.onContextLost?.();
  };
  private handleContextRestored = () => {
    if (this.fallbackPinned) return;
    this.contextLost = false;
    this.drawnKey = '';
    this.horizonDrawKey = '';
    this.diagnostics.contextLost = false;
    this.onContextRestored?.();
  };
  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.loseContextExt = gl.getExtension('WEBGL_lose_context');
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.renderer = new WebGLRenderer({
      canvas,
      context: gl,
      antialias: true,
      alpha: false,
    });
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '',
    );
    this.software = /swiftshader|llvmpipe|software|lavapipe/i.test(name);
    this.floatTargets =
      this.renderer.extensions.has('EXT_color_buffer_float') ||
      this.renderer.extensions.has('EXT_color_buffer_half_float');
    // A pinned tier (verification captures) also pins full resolution.
    this.scale = this.forced ? 1 : this.software || innerWidth < 760 ? 0.85 : 1;
    this.horizonScene.add(this.horizonQuad);
    this.horizonComposite.add(this.horizonCompositeQuad);
    this.renderer.setClearColor('#000000');
    this.scene.add(new AmbientLight('#adc5df', 0.1));
    const sun = (this.sun = new DirectionalLight('#fff2df', 2.5));
    sun.position.set(-4, 2, 5);
    this.scene.add(sun, sun.target);
    this.scene.add(
      this.starfield.sky,
      this.starfield.stars,
      this.scenery.group,
    );
    this.post = new Post(
      this.renderer,
      this.scene,
      this.camera,
      this.horizonComposite,
      this.horizonCamera,
    );
    this.applyTier();
    this.resize();
  }
  private get tierSettings() {
    return tierSettings(this.post.tier);
  }
  /** Re-evaluate the quality tier after any change to scale or viewport. */
  private applyTier() {
    const tier = selectTier({
      scale: this.scale,
      mobile: innerWidth < 760,
      floatTargets: this.floatTargets,
      software: this.software,
      forced: this.forced,
    });
    this.post.setTier(tier);
    this.diagnostics.tier = tier;
    if (!tierSettings(tier).hero) this.releaseHeroes();
  }
  static create(canvas: HTMLCanvasElement) {
    try {
      const gl = canvas.getContext('webgl2', {
        antialias: true,
        powerPreference: 'high-performance',
      });
      return gl ? new JourneyRenderer(canvas, gl) : null;
    } catch {
      return null;
    }
  }
  private loadTexture(name: string) {
    if (assets.has(name)) return assets.get(name)!;
    const spec = ASSETS[name];
    this.pendingAssets.add(name);
    this.pendingTextures = this.pendingAssets.size;
    document.documentElement.dataset.textures = 'loading';
    let settled = false;
    const clearTimer = () => {
      const timer = this.timers.get(name);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(name);
    };
    const applyFallback = (timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimer();
      this.pendingAssets.delete(name);
      this.pendingTextures = this.pendingAssets.size;
      // Reserved for load failures or 10 s timeout: a flat placeholder keeps the scene alive.
      this.textureFailures++;
      if (timedOut) this.timedOutTextures++;
      document.documentElement.dataset.textureFallback = 'true';
      if (this.pendingTextures === 0 && this.nodes.size > 0)
        document.documentElement.dataset.textures = 'ready';
      const fallback = document.createElement('canvas');
      fallback.width = 4;
      fallback.height = 2;
      const ctx = fallback.getContext('2d')!;
      ctx.fillStyle = spec.fallback;
      ctx.fillRect(0, 0, 4, 2);
      (texture.source as { data: unknown }).data = fallback;
      texture.needsUpdate = true;
      this.drawnKey = '';
      this.onStatusChange?.();
    };
    const texture = this.loader.load(
      `/textures/${name}.${spec.ext}`,
      () => {
        if (settled) return;
        settled = true;
        clearTimer();
        this.pendingAssets.delete(name);
        this.pendingTextures = this.pendingAssets.size;
        if (this.pendingTextures === 0 && this.nodes.size > 0)
          document.documentElement.dataset.textures = 'ready';
        this.drawnKey = '';
        this.onStatusChange?.();
      },
      undefined,
      () => applyFallback(false),
    );
    this.timers.set(
      name,
      setTimeout(() => applyFallback(true), LOAD_TIMEOUT_MS),
    );
    configureTexture(
      texture,
      name,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    assets.set(name, texture);
    return texture;
  }
  /**
   * Stream an 8K upgrade outside the pending-texture accounting: base maps are
   * already showing, so a slow or failed hero never delays or degrades a stop.
   */
  private loadHero(name: string, onLoad: (texture: Texture) => void) {
    this.loader.load(
      `/textures/${HERO[name]}`,
      (texture) => {
        configureTexture(
          texture,
          name,
          this.renderer.capabilities.getMaxAnisotropy(),
        );
        texture.needsUpdate = true;
        onLoad(texture);
      },
      undefined,
      () => undefined,
    );
  }
  /** Keep 8K maps only for the world being observed, on the high tier. */
  private updateHeroes(observing: number | null) {
    const allowed = this.tierSettings.hero && !this.contextLost;
    const wanted = new Set<string>();
    if (allowed && observing !== null)
      for (const slot of this.nodes.get(observing)?.heroes ?? [])
        wanted.add(slot.name);
    for (const name of wanted)
      if (!this.heroes.has(name)) {
        const entry: { texture?: Texture } = {};
        this.heroes.set(name, entry);
        this.loadHero(name, (texture) => {
          if (this.heroes.get(name) !== entry) return texture.dispose();
          entry.texture = texture;
          this.drawnKey = '';
        });
      }
    for (const [name, entry] of this.heroes)
      if (!wanted.has(name)) {
        entry.texture?.dispose();
        this.heroes.delete(name);
      }
    // One shared 8K texture per name, bound to every slot that wants it.
    for (const [i, node] of this.nodes)
      for (const slot of node.heroes) {
        const hero =
          i === observing ? this.heroes.get(slot.name)?.texture : undefined;
        const value = hero ?? assets.get(slot.name) ?? slot.uniform.value;
        slot.active = Boolean(hero);
        if (slot.uniform.value !== value) slot.uniform.value = value;
      }
    if (
      allowed &&
      !this.skyHero &&
      !this.skyHeroLoading &&
      this.pendingTextures === 0
    ) {
      this.skyHeroLoading = true;
      this.loadHero('milkyway', (texture) => {
        this.skyHeroLoading = false;
        if (!this.tierSettings.hero) return texture.dispose();
        this.skyHero = texture;
        this.starfield.setMap(texture);
      });
    }
    this.diagnostics.heroes = [
      ...[...this.heroes].filter(([, e]) => e.texture).map(([n]) => n),
      ...(this.skyHero ? ['milkyway'] : []),
    ];
  }
  private releaseHeroes() {
    for (const entry of this.heroes.values()) entry.texture?.dispose();
    this.heroes.clear();
    for (const node of this.nodes.values())
      for (const slot of node.heroes) {
        slot.uniform.value = assets.get(slot.name) ?? slot.uniform.value;
        slot.active = false;
      }
    if (this.skyHero) {
      this.skyHero.dispose();
      this.skyHero = undefined;
      this.starfield.setMap(assets.get('milkyway') ?? null);
    }
  }
  /** Dispose textures no resident stop needs; shared ones survive. */
  private releaseUnusedTextures(leg: number) {
    const keep = residentAssets(leg);
    for (const [name, texture] of assets)
      if (!keep.has(name)) {
        const timer = this.timers.get(name);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(name);
        this.pendingAssets.delete(name);
        texture.dispose();
        assets.delete(name);
      }
    this.pendingTextures = this.pendingAssets.size;
    if (this.pendingTextures === 0)
      document.documentElement.dataset.textures = 'ready';
  }
  loseContext() {
    this.fallbackPinned = false;
    this.canvas.dispatchEvent(
      new Event('webglcontextlost', { cancelable: true }),
    );
  }
  restoreContext() {
    this.fallbackPinned = false;
    try {
      if (this.loseContextExt && this.gl.isContextLost()) {
        this.loseContextExt.restoreContext();
      }
    } catch {
      /* synthetic recovery */
    }
    this.canvas.dispatchEvent(new Event('webglcontextrestored'));
  }
  useStaticFallback() {
    this.fallbackPinned = true;
    this.contextLost = true;
    this.diagnostics.contextLost = true;
    this.onStatusChange?.();
  }
  /** Adaptive-quality hook (EH-06): scales the render resolution without touching flight state. */
  setQuality(scale: number) {
    this.scale = Math.max(0.35, Math.min(1, scale));
    this.slow = 0;
    this.busyTicks = 0;
    this.diagnostics.quality = this.scale;
    this.applyTier();
    this.resize();
  }
  get quality() {
    return this.scale;
  }
  private clear() {
    // The loaded spacecraft is reused when its stop becomes resident again.
    if (this.voyager?.parent === this.object) this.voyager.removeFromParent();
    this.object.traverse((child) => {
      if (child instanceof Mesh || child instanceof Points) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((m) => m.dispose());
      }
    });
    this.object.clear();
    this.body = undefined;
    this.clouds = undefined;
    this.ring = undefined;
    this.field = undefined;
  }
  private setCheckpoint(index: number) {
    if (this.nodes.has(index)) return;
    this.object = new Group();
    this.body = undefined;
    this.clouds = undefined;
    this.ring = undefined;
    this.field = undefined;
    this.scene.add(this.object);
    const p = CHECKPOINTS[index];
    const look =
      lookFor(p.id) ??
      (p.kind === 'planet' || p.kind === 'star' ? FALLBACK_LOOK : undefined);
    const heroes: HeroSlot[] = [];
    let probe: Group | undefined;
    /** Bind a material uniform to a base map, remembering 8K upgrades. */
    const bind = (m: Material, uniform: string, name: string) => {
      const u = (m as ShaderMaterial).uniforms[uniform];
      u.value = this.loadTexture(name);
      if (HERO[name]) heroes.push({ name, uniform: u });
    };
    if (look && (p.kind === 'planet' || p.kind === 'star')) {
      const tex = (name: string) => this.loadTexture(name);
      let mat: ShaderMaterial;
      if (p.id === 'earth') {
        mat = earthMaterial({
          day: tex('earth'),
          night: tex('night'),
          clouds: tex('clouds'),
          normal: tex('earth-normal'),
          ocean: tex('earth-specular'),
          look,
        });
        bind(mat, 'day', 'earth');
        bind(mat, 'clouds', 'clouds');
      } else if (p.id === 'proxima') {
        mat = proximaMaterial(look);
      } else if (look.surface === 'star') {
        mat = sunMaterial(tex(p.texture ?? 'sun'), look);
      } else {
        const map = p.texture ? tex(p.texture) : tex('moon');
        mat = surfaceMaterial(look, {
          map,
          normal: look.normalMap ? tex(look.normalMap) : undefined,
          rings: p.id === 'saturn' ? tex('saturn-rings') : undefined,
        });
        if (p.texture) bind(mat, 'map', p.texture);
      }
      const lite = !this.tierSettings.post;
      this.body = new Mesh(
        new SphereGeometry(1, lite ? 96 : 160, lite ? 48 : 80),
        mat,
      );
      this.body.scale.y = 1 - look.oblateness;
      this.body.rotation.y = (p.id.length * 1.7) % 6; // varies the initial longitude per world
      this.object.add(this.body);
      if (p.id === 'earth') {
        this.clouds = new Mesh(
          new SphereGeometry(1.008, lite ? 80 : 128, lite ? 40 : 64),
          cloudShellMaterial(tex('clouds'), look),
        );
        bind(this.clouds.material as ShaderMaterial, 'map', 'clouds');
        this.clouds.renderOrder = 2;
        this.object.add(this.clouds);
      }
      // Axial tilt. Saturn is additionally pitched towards the camera so the
      // ring plane is open rather than edge-on at the canonical viewpoint.
      this.object.rotation.z = (look.tilt * Math.PI) / 180;
      if (p.id === 'saturn') this.object.rotation.x = 0.42;
      if (look.atmosphere) {
        const shell = new Mesh(
          new SphereGeometry(
            look.atmosphere.top,
            lite ? 64 : 96,
            lite ? 32 : 48,
          ),
          atmosphereMaterial(look, lite ? 7 : 14),
        );
        shell.scale.y = 1 - look.oblateness;
        shell.renderOrder = 4;
        // World → body frame with the flattening undone, so the limb is uniform.
        const rotation = new Matrix3().setFromMatrix4(
          new Matrix4().makeRotationFromQuaternion(this.object.quaternion),
        );
        (shell.material as ShaderMaterial).uniforms.uToLocal.value =
          new Matrix3()
            .set(1, 0, 0, 0, 1 / (1 - look.oblateness), 0, 0, 0, 1)
            .multiply(rotation.transpose());
        this.object.add(shell);
      }
      if (look.surface === 'star') {
        const corona = new Mesh(
          new PlaneGeometry(2, 2),
          coronaMaterial(look, p.id === 'sun' ? 3.4 : 3),
        );
        corona.renderOrder = 1;
        corona.frustumCulled = false;
        this.object.add(corona);
      }
      if (p.id === 'saturn') {
        this.ring = new Mesh(
          new RingGeometry(RING_INNER, RING_OUTER, 512, 1),
          ringMaterial(tex('saturn-rings')),
        );
        this.ring.rotation.x = -Math.PI / 2;
        // Draw after the globe so the near ring crosses it and the far ring is occluded.
        this.ring.renderOrder = 3;
        this.object.add(this.ring);
      }
    } else if (p.kind === 'probe') {
      // Dish faces the approaching camera, turned so the booms read in silhouette.
      this.object.rotation.set(0.22, Math.PI + 0.7, 0.12);
      probe = this.voyager ?? buildVoyager();
      this.object.add(probe);
      if (!this.voyager && !this.voyagerLoading) {
        this.voyagerLoading = true;
        void loadVoyager()
          .then((model) => {
            if (this.disposed) {
              disposeVoyager(model);
              return;
            }
            this.voyager = model;
            const node = this.nodes.get(index);
            if (!node?.probe) return;
            node.probe.removeFromParent();
            disposeVoyager(node.probe);
            node.group.add(model);
            node.probe = model;
            this.drawnKey = '';
          })
          .catch(() => {
            this.voyagerLoading = false;
          });
      }
    } else if (p.kind === 'field') {
      const points = [],
        n = p.id === 'oort' ? 420 : 650;
      let seed = 77;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      for (let i = 0; i < n; i++) {
        const a = random() * Math.PI * 2,
          r = 1.3 + random() * 1.4,
          y = random() * 2 - 1;
        points.push(
          Math.cos(a) * r,
          p.id === 'oort' ? y * r : y * 0.13,
          Math.sin(a) * r,
        );
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(points, 3));
      this.field = new Points(
        g,
        new PointsMaterial({
          color: p.color,
          size: p.id === 'oort' ? 0.018 : 0.027,
          transparent: true,
          opacity: 0.7,
        }),
      );
      this.object.add(this.field);
    }
    if (p.kind === 'blackhole') {
      const orb = new Mesh(
        new SphereGeometry(1, 48, 24),
        new MeshBasicMaterial({ color: '#000000' }),
      );
      this.object.add(orb);
      // Emissive HDR disc so the approach glows before the lensed view takes over.
      const ring = new Mesh(
        new RingGeometry(1.2, 2.1, 128),
        new MeshBasicMaterial({
          color: new Color(2.6, 1.45, 0.62),
          side: DoubleSide,
          transparent: true,
          opacity: 0.8,
          depthWrite: false,
        }),
      );
      ring.rotation.x = 1.2;
      this.object.add(ring);
    }
    const glintG = new BufferGeometry();
    glintG.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
    const color = new Color(p.color);
    const glint = new Points(
      glintG,
      glintMaterial(
        look?.glint ??
          (p.kind === 'blackhole'
            ? [1.6, 0.9, 0.45]
            : [color.r * 1.2, color.g * 1.2, color.b * 1.2]),
      ),
    );
    glint.frustumCulled = false;
    glint.renderOrder = 8;
    this.scene.add(glint);
    this.nodes.set(index, {
      group: this.object,
      body: this.body,
      clouds: this.clouds,
      ring: this.ring,
      field: this.field,
      glint,
      look,
      light: new Vector3(...(look?.light ?? DEFAULT_LIGHT)),
      heroes,
      probe,
    });
  }
  resize() {
    const width = innerWidth,
      height = innerHeight;
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, this.tierSettings.dprCap) * this.scale,
    );
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.post.resize();
    this.drawnKey = '';
  }
  render(
    s: FlightState & {
      thrust?: number;
      playback?: string;
      flightPhase?: string;
      reducedMotion?: boolean;
    },
    time: number,
  ) {
    const thrust = s.thrust ?? 0;
    const reduced = Boolean(s.reducedMotion);
    const mobile = innerWidth < 760;
    const warp = warpAt(s.cameraPose ? thrust : 0, reduced);
    const originZ = s.now * SPACING;
    const leg = Math.min(CHECKPOINTS.length - 1, Math.floor(s.position));
    const resident = [...residentStops(leg)];
    if (
      s.playback &&
      s.playback !== 'observing' &&
      s.legProgress > 0.35 &&
      !resident.includes(s.next)
    ) {
      if (resident.length >= 4) {
        let farthest = 0;
        for (let k = 1; k < resident.length; k++) {
          if (
            Math.abs(resident[k] - s.next) >
            Math.abs(resident[farthest] - s.next)
          )
            farthest = k;
        }
        resident.splice(farthest, 1);
      }
      resident.push(s.next);
    }
    // Earth first: build the active stop, then adjacent stops (preloading their textures).
    for (const i of [...resident].sort(
      (a, b) => Math.abs(a - s.now) - Math.abs(b - s.now),
    ))
      this.setCheckpoint(i);
    if (!this.skyHero) this.starfield.setMap(this.loadTexture('milkyway'));
    if (this.pendingTextures === 0 && this.nodes.size > 0)
      document.documentElement.dataset.textures = 'ready';
    let removed = false;
    for (const [i, node] of this.nodes) {
      if (!resident.includes(i)) {
        removed = true;
        this.object = node.group;
        this.clear();
        this.scene.remove(node.group, node.glint);
        node.glint.geometry.dispose();
        (node.glint.material as ShaderMaterial).dispose();
        this.nodes.delete(i);
      }
    }
    if (removed) this.releaseUnusedTextures(leg);
    this.updateHeroes(s.playback === 'observing' || !s.playback ? s.now : null);
    this.camera.fov = s.cameraPose
      ? BASE_FOV + warp.fov
      : 36 + (reduced ? 0 : 24 * smooth(s.position / 0.15));
    if (mobile) this.camera.fov = s.cameraPose ? 100 : 75;
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(s.cameraX, 0, s.cameraZ - originZ);
    this.camera.lookAt(s.cameraX, 0, s.cameraZ - originZ - 10);
    this.camera.rotation.y = -s.yaw;
    if (s.cameraPose) {
      this.camera.position.fromArray(s.cameraPose.position);
      this.camera.position.z -= originZ;
      this.camera.quaternion.fromArray(s.cameraPose.rotation);
    }
    this.camera.setViewOffset(
      innerWidth,
      innerHeight,
      mobile ? 0 : -innerWidth * 0.1,
      mobile ? innerHeight * (s.cameraPose ? 0.24 : 0.23) : 0,
      innerWidth,
      innerHeight,
    );
    this.camera.updateMatrixWorld();
    const final = CHECKPOINTS.length - 1;
    const handoff = smooth((s.position - (final - 0.28)) / 0.24);
    const interior = s.phase === 'interior';
    const descent = s.phase === 'blackhole' || interior;
    const hu = this.horizonMaterial.uniforms;
    if (handoff > 0) {
      hu.uSky.value = this.skyHero ?? assets.get('milkyway') ?? null;
      hu.uGalFromLens.value.setFromMatrix4(
        new Matrix4()
          .makeRotationFromQuaternion(skyRotation(s.position))
          .transpose()
          .multiply(this.scratch.makeRotationX(-0.25)),
      );
    }
    hu.uTime.value = reduced ? 0 : time;
    hu.uOpacity.value = handoff;
    hu.uDarkness.value = descent ? 1 - smooth((s.bhRadius - 1) / 0.5) : 0;
    // Authored optical magnification: 1,000 scientific radii frame at 20 shader radii.
    const hp = new Vector3().fromArray(
      s.cameraPose?.position ?? [0, 0, final * SPACING - 7],
    );
    hp.z -= final * SPACING;
    hp.multiplyScalar(20 / 7).applyAxisAngle(new Vector3(1, 0, 0), 0.25);
    hu.uCamPos.value.copy(hp);
    const basis = new Matrix4().lookAt(hp, new Vector3(), new Vector3(0, 1, 0));
    basis.scale(new Vector3(1, 1, -1));
    hu.uCamBasis.value.setFromMatrix4(basis);
    hu.uTanHalfFov.value = mobile ? 0.78 : 0.36;
    hu.uOffset.value.set(mobile ? 0 : -0.2, mobile ? -0.48 : 0);
    this.spinRate +=
      ((s.dragging || reduced ? 0 : 1) - this.spinRate) *
      (1 - Math.exp(-Math.max(0, time - this.spinTime) * 5));
    // Standard materials (Voyager) take the light of the stop that dominates the view.
    const litStop = s.cameraPose && s.legProgress > 0.5 ? s.next : s.now;
    const litNode = this.nodes.get(litStop);
    const litZ = litStop * SPACING - originZ;
    const litDir = litNode?.light ?? new Vector3(...DEFAULT_LIGHT);
    this.sun.position.set(litDir.x * 5, litDir.y * 5, litZ + litDir.z * 5);
    this.sun.target.position.set(0, 0, litZ);
    const pixelRatio = this.renderer.getPixelRatio();
    const focal =
      (innerHeight * pixelRatio * 0.5) /
      Math.tan((this.camera.fov * Math.PI) / 360);
    const forward = new Vector3(0, 0, -1).applyQuaternion(
      this.camera.quaternion,
    );
    const screenArea = innerWidth * innerHeight * pixelRatio * pixelRatio;
    const glare: GlareSource[] = [];
    for (const [i, node] of this.nodes) {
      node.group.position.set(0, 0, i * SPACING - originZ);
      node.glint.position.copy(node.group.position);
      node.group.visible = true;
      node.group.updateMatrixWorld(true);
      const ringNormal = new Vector3(0, 1, 0).applyQuaternion(
        node.group.quaternion,
      );
      node.group.traverse((child) => {
        if (
          !(child instanceof Mesh) ||
          !(child.material instanceof ShaderMaterial)
        )
          return;
        const u = child.material.uniforms;
        if (u.uLight && child !== node.ring) u.uLight.value.copy(node.light);
        if (u.uCenter) u.uCenter.value.copy(node.group.position);
        if (u.uRingNormal) u.uRingNormal.value.copy(ringNormal);
        if (u.time) u.time.value = reduced ? 0 : time;
      });
      if (node.ring) {
        const inv = this.scratch.copy(node.ring.matrixWorld).invert();
        const ru = (node.ring.material as ShaderMaterial).uniforms;
        ru.uLight.value.copy(node.light).transformDirection(inv);
        ru.uView.value.copy(this.camera.position).applyMatrix4(inv);
      }
      // Distant bodies are points of light that resolve into discs as they grow.
      const toBody = node.group.position.clone().sub(this.camera.position);
      const distance = Math.max(1e-3, toBody.length());
      const discPx = (focal * 1) / distance;
      const inFront = toBody.dot(forward) / distance;
      const gm = (node.glint.material as ShaderMaterial).uniforms;
      const weight = (1 - smooth((discPx - 1.2) / 3.4)) * (1 - handoff);
      node.glint.visible = weight > 0.002;
      gm.uWeight.value = weight;
      gm.uSize.value = (node.look?.surface === 'star' ? 4.5 : 6) * pixelRatio;
      if (inFront > 0.2 && node.look)
        glare.push({
          coverage: Math.min(1, (Math.PI * discPx * discPx) / screenArea),
          star: node.look.surface === 'star',
        });
      if (node.body) {
        // Integrate local spin so releasing a drag cannot jump to a wall-clock angle.
        if (!s.dragging && !reduced)
          node.body.rotation.y +=
            (Math.min(0.05, Math.max(0, time - this.spinTime)) *
              Math.PI *
              2 *
              this.spinRate) /
            120;
      }
      if (node.clouds) {
        if (!reduced) node.clouds.rotation.y = (time * Math.PI * 2) / 140;
        const bu = (node.body!.material as ShaderMaterial).uniforms;
        bu.uCloudShift.value =
          (node.body!.rotation.y - node.clouds.rotation.y) / (Math.PI * 2);
      }
      if (node.field && !reduced) node.field.rotation.y = time * 0.008;
    }
    this.spinTime = time;
    const exposure = exposureFor(glare, warp.envelope);
    const scenery = sceneryAt(s.earthKm, s.position);
    if (this.lastPosition !== null && !reduced)
      this.odometer += Math.min(0.2, Math.abs(s.position - this.lastPosition));
    this.lastPosition = s.position;
    const heading = s.heading
      ? new Vector3(...s.heading).normalize()
      : forward.clone();
    const viewport = this.renderer.getDrawingBufferSize(new Vector2());
    this.starfield.update({
      camera: this.camera,
      position: s.position,
      heading,
      beta: warp.beta,
      stretch: warp.stretch,
      exposure: exposure.sky * (1 - 0.85 * handoff),
      tint: scenery.tint,
      viewport,
      pixelRatio,
      density: this.tierSettings.post ? 1 : 0.4,
    });
    // Near-field layers stream past along the view direction.
    const facing = this.camera.quaternion
      .clone()
      .multiply(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI),
      );
    this.scenery.update({
      at: this.camera.position,
      facing,
      scenery,
      travel: this.odometer,
      focal,
      stretch: warp.stretch,
      viewport,
      reduced,
    });
    const target = new Vector3(0, 0, s.next * SPACING - originZ).project(
      this.camera,
    );
    const centre = this.camera.position
      .clone()
      .add(heading)
      .project(this.camera);
    const alignment = Math.max(0, heading.dot(forward));
    this.diagnostics = {
      loaded: [...this.nodes.keys()],
      textures: [...assets.keys()],
      warp: reduced ? 0 : s.warp,
      pending: this.pendingTextures,
      quality: this.scale,
      tier: this.post.tier,
      contextLost: this.contextLost,
      reducedMotion: reduced,
      scenery: this.scenery.weights,
      fov: this.camera.fov,
      beta: warp.beta,
      stretch: warp.stretch,
      exposure,
      heroes: this.diagnostics.heroes,
      bank: s.bank ?? 0,
      camera: this.camera.position.toArray(),
      yaw: s.yaw,
      nodeIds: Object.fromEntries(
        [...this.nodes].map(([i, n]) => [i, n.group.uuid]),
      ),
      horizonSize:
        handoff > 0 ? [this.horizonWidth, this.horizonHeight] : [0, 0],
      voyagerModel: Boolean(this.voyager?.parent),
      target: {
        x: (target.x + 1) / 2,
        y: (1 - target.y) / 2,
        visible:
          target.z > -1 &&
          target.z < 1 &&
          Math.abs(target.x) < 0.9 &&
          Math.abs(target.y) < 0.9,
      },
    };
    if (this.contextLost) return;
    // Downscale before drawing: resizing clears the canvas, so the same frame
    // must redraw into the new buffer rather than leave it blank.
    if (this.slow > 8 && this.scale > 0.35 && !this.forced) {
      this.scale = Math.max(0.35, this.scale - 0.15);
      this.slow = 0;
      this.applyTier();
      this.resize();
    }
    let gpuBusy = false;
    if (this.gpuFence) {
      const status = this.gl.clientWaitSync(this.gpuFence, 0, 0);
      if (status === this.gl.TIMEOUT_EXPIRED) {
        gpuBusy = true;
        this.busyTicks++;
      } else {
        this.gl.deleteSync(this.gpuFence);
        this.gpuFence = null;
        if (this.busyTicks >= 2) this.slow++;
        this.busyTicks = 0;
      }
    }
    const poseKey =
      s.phase === 'orbit' || s.phase === 'flyby' || s.phase === 'blackhole'
        ? `${s.cameraPose?.position.map((n) => n.toFixed(3)).join(',')}:${s.cameraPose?.rotation.map((n) => n.toFixed(3)).join(',')}`
        : '';
    const drawKey = `${s.now}:${s.next}:${s.playback ?? ''}:${s.flightPhase ?? ''}:${s.phase}:${Math.round(s.position * 5)}:${s.bhRadius.toFixed(1)}:${this.pendingTextures}:${reduced}:${poseKey}`;
    // An invalidated canvas (resize, new texture, restored context) always redraws.
    if (
      gpuBusy &&
      this.drawnKey !== '' &&
      (s.playback === 'flying' || drawKey === this.drawnKey)
    )
      return;
    this.drawnKey = drawKey;
    if (handoff > 0) {
      const buffer = this.renderer.getDrawingBufferSize(new Vector2());
      // Reduce only ray integration during motion. High-tier observation resolves
      // at the drawing buffer's native resolution, including on 4K displays.
      const moving = s.playback === 'flying' || s.dragging || descent;
      const rayScale =
        this.post.tier === 'high'
          ? moving && !reduced
            ? 0.6
            : 1
          : this.post.tier === 'medium'
            ? moving
              ? 0.5
              : 0.8
            : moving
              ? 0.45
              : 0.6;
      const budgetScale = Math.sqrt((3840 * 2160) / (buffer.x * buffer.y));
      const scale = Math.min(rayScale, budgetScale);
      this.horizonWidth = Math.max(1, Math.round(buffer.x * scale));
      this.horizonHeight = Math.max(1, Math.round(buffer.y * scale));
      this.diagnostics.horizonSize = [this.horizonWidth, this.horizonHeight];
      this.horizonTarget.setSize(this.horizonWidth, this.horizonHeight);
      hu.uResolution.value.set(this.horizonWidth, this.horizonHeight);
      const staticView =
        (reduced && s.playback === 'observing') || hu.uDarkness.value >= 1;
      const horizonKey = staticView
        ? `${drawKey}:${this.horizonWidth}:${this.horizonHeight}:${hu.uSky.value?.version}:${hu.uSky.value?.uuid}`
        : '';
      if (!horizonKey || horizonKey !== this.horizonDrawKey) {
        this.horizonDrawKey = horizonKey;
        this.renderer.setRenderTarget(this.horizonTarget);
        this.renderer.setClearColor('#000000', 0);
        this.renderer.render(this.horizonScene, this.horizonCamera);
        this.renderer.setRenderTarget(null);
        this.renderer.setClearColor('#000000', 1);
      }
    }
    const composed = this.post.render({
      exposure: exposure.scene,
      center: new Vector2((centre.x + 1) / 2, (centre.y + 1) / 2),
      bend: warp.bend * alignment,
      stretch: warp.stretch * alignment,
      overlay: handoff > 0,
      opaqueOverlay: handoff === 1 ? this.horizonTarget : undefined,
    });
    if (!composed) {
      if (handoff < 1) this.renderer.render(this.scene, this.camera);
      if (handoff > 0) {
        this.renderer.autoClear = handoff === 1;
        this.renderer.render(this.horizonComposite, this.horizonCamera);
        this.renderer.autoClear = true;
      }
    }
    if (this.gpuFence) this.gl.deleteSync(this.gpuFence);
    this.gpuFence = this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.gl.flush();
    if (this.pendingTextures === 0) this.frames++;
    const now = performance.now(),
      dt = this.last ? now - this.last : 16;
    this.last = now;
    if (dt > 50) this.slow++;
    else if (!gpuBusy) this.slow = Math.max(0, this.slow - 1);
  }
  resetTiming() {
    this.last = 0;
    this.slow = 0;
    this.busyTicks = 0;
    this.drawnKey = '';
  }
  dispose() {
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.handleContextRestored,
    );
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pendingAssets.clear();
    if (this.gpuFence && !this.contextLost) {
      this.gl.deleteSync(this.gpuFence);
      this.gpuFence = null;
    }
    this.releaseHeroes();
    for (const n of this.nodes.values()) {
      this.object = n.group;
      this.clear();
      n.glint.geometry.dispose();
      (n.glint.material as ShaderMaterial).dispose();
    }
    this.nodes.clear();
    if (this.voyager) disposeVoyager(this.voyager);
    this.scenery.dispose();
    this.starfield.dispose();
    this.post.dispose();
    assets.forEach((t) => t.dispose());
    assets.clear();
    this.horizonQuad.geometry.dispose();
    this.horizonMaterial.dispose();
    this.horizonTarget.dispose();
    this.horizonCompositeQuad.geometry.dispose();
    this.horizonCompositeMaterial.dispose();
    this.renderer.dispose();
  }
}
