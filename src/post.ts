/**
 * HDR image pipeline and quality tiers. The scene renders into a multisampled
 * half-float buffer, bright light blooms, and one output pass applies the warp's
 * lens bend and radial streak blur in linear light before tone mapping, sRGB
 * encoding and dither. The low tier skips the chain and tone-maps in materials.
 */
import {
  Camera,
  HalfFloatType,
  NeutralToneMapping,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type Tier = 'high' | 'medium' | 'low';
export interface TierInput {
  /** Adaptive render scale, 0.35–1. */
  scale: number;
  mobile: boolean;
  /** Renderable float colour buffers are available. */
  floatTargets: boolean;
  /** Software rasteriser (SwiftShader, llvmpipe). */
  software: boolean;
  forced?: Tier | null;
}
export function selectTier(i: TierInput): Tier {
  if (i.forced) return i.forced === 'low' || i.floatTargets ? i.forced : 'low';
  if (!i.floatTargets || i.software || i.scale < 0.5) return 'low';
  if (i.mobile || i.scale < 0.8) return 'medium';
  return 'high';
}
export interface TierSettings {
  /** HDR chain with bloom and lens effects. */
  post: boolean;
  samples: number;
  /** Bloom resolution relative to the canvas. */
  bloom: number;
  /** Device-pixel-ratio cap before the adaptive scale. */
  dprCap: number;
  /** Stream 8K hero maps. */
  hero: boolean;
}
export function tierSettings(tier: Tier): TierSettings {
  return tier === 'high'
    ? { post: true, samples: 4, bloom: 1, dprCap: 2, hero: true }
    : tier === 'medium'
      ? { post: true, samples: 2, bloom: 0.5, dprCap: 1.75, hero: false }
      : { post: false, samples: 0, bloom: 0, dprCap: 1.75, hero: false };
}
/** `?quality=high|medium|low` pins a tier for verification captures. */
export function forcedTier(
  search = globalThis.location?.search ?? '',
): Tier | null {
  const q = new URLSearchParams(search).get('quality');
  return q === 'high' || q === 'medium' || q === 'low' ? q : null;
}

const OutputShader = {
  uniforms: {
    tDiffuse: { value: null },
    uExposure: { value: 1 },
    uCenter: { value: new Vector2(0.5, 0.5) },
    uBend: { value: 0 },
    uStretch: { value: 0 },
    uAspect: { value: 1 },
    uSeed: { value: 0 },
  },
  vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `uniform sampler2D tDiffuse;uniform float uExposure;uniform vec2 uCenter;uniform float uBend;
uniform float uStretch;uniform float uAspect;uniform float uSeed;varying vec2 vUv;
vec3 neutral(vec3 c){
  const float start=.76,desat=.15;
  float x=min(c.r,min(c.g,c.b));c-=x<.08?x-6.25*x*x:.04;
  float peak=max(c.r,max(c.g,c.b));if(peak<start)return c;
  float d=1.-start,np=1.-d*d/(peak+d-start);c*=np/peak;
  float g=1.-1./(desat*(peak-np)+1.);return mix(c,vec3(np),g);
}
vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(.0031308,c));}
void main(){
  vec2 a=vec2(uAspect,1.);
  vec2 d=(vUv-uCenter)*a;float r=length(d);
  // Space bends softly towards the frame edges at speed; the heading stays true.
  vec2 uv=uCenter+d*(1.-uBend*.16*r*r)/a;
  vec3 col;
  float w=uStretch*smoothstep(.20,.95,r)*.018;
  // A short exposure smear at the periphery. The stronger individual trails
  // come from projected star motion, so the destination retains a crisp edge.
  if(w>.0005){
    vec2 smear=(uCenter-uv)*w;
    col=texture2D(tDiffuse,uv).rgb*.5
      +texture2D(tDiffuse,uv+smear*.32).rgb*.27
      +texture2D(tDiffuse,uv+smear*.65).rgb*.15
      +texture2D(tDiffuse,uv+smear).rgb*.08;
  }else col=texture2D(tDiffuse,uv).rgb;
  col=srgb(clamp(neutral(col*uExposure),0.,1.));
  float n=fract(sin(dot(gl_FragCoord.xy+uSeed,vec2(12.9898,78.233)))*43758.5453);
  gl_FragColor=vec4(col+(n-.5)/255.,1.);
}`,
};

export interface PostFrame {
  exposure: number;
  /** Heading projected to the viewport, 0–1 with origin bottom-left. */
  center: Vector2;
  bend: number;
  stretch: number;
  overlay: boolean;
  opaqueOverlay?: WebGLRenderTarget;
}

export class Post {
  private composer?: EffectComposer;
  private target?: WebGLRenderTarget;
  private bloom?: UnrealBloomPass;
  private output?: ShaderPass;
  private overlayPass?: RenderPass;
  private settings: TierSettings = tierSettings('low');
  private frame = 0;
  tier: Tier = 'low';
  constructor(
    private renderer: WebGLRenderer,
    private scene: Scene,
    private camera: Camera,
    private overlay: Scene,
    private overlayCamera: Camera,
  ) {
    renderer.toneMapping = NeutralToneMapping;
  }
  setTier(tier: Tier) {
    if (tier === this.tier && (this.composer || !tierSettings(tier).post))
      return;
    this.tier = tier;
    this.settings = tierSettings(tier);
    this.disposeChain();
    if (!this.settings.post) return;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.target = new WebGLRenderTarget(size.x, size.y, {
      type: HalfFloatType,
      samples: this.settings.samples,
    });
    const composer = (this.composer = new EffectComposer(
      this.renderer,
      this.target,
    ));
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.overlayPass = new RenderPass(this.overlay, this.overlayCamera);
    this.overlayPass.clear = false;
    this.overlayPass.enabled = false;
    composer.addPass(this.overlayPass);
    this.bloom = new UnrealBloomPass(
      new Vector2(size.x * this.settings.bloom, size.y * this.settings.bloom),
      // Only stars, glints, city lights and the accretion disc exceed this.
      0.6,
      0.55,
      2.2,
    );
    composer.addPass(this.bloom);
    this.output = new ShaderPass(OutputShader);
    this.output.material.toneMapped = false;
    composer.addPass(this.output);
    this.resize();
  }
  get settingsForTier() {
    return this.settings;
  }
  resize() {
    if (!this.composer) return;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.composer.setPixelRatio(1);
    this.composer.setSize(size.x, size.y);
    this.bloom?.setSize(
      Math.max(1, Math.round(size.x * this.settings.bloom)),
      Math.max(1, Math.round(size.y * this.settings.bloom)),
    );
    if (this.output) this.output.uniforms.uAspect.value = size.x / size.y;
  }
  /** Returns false when the low tier should render directly instead. */
  render(f: PostFrame) {
    if (!this.composer || !this.output) {
      this.renderer.toneMappingExposure = f.exposure;
      return false;
    }
    const u = this.output.uniforms;
    u.uExposure.value = f.exposure;
    u.uCenter.value.copy(f.center);
    u.uBend.value = f.bend;
    u.uStretch.value = f.stretch;
    u.uSeed.value = this.frame = (this.frame + 1) % 997;
    if (f.opaqueOverlay) {
      // The opaque lens covers the scene, and its tone-mapped pixels are below
      // the bloom threshold. Present it without allocating the MSAA buffers.
      this.output.renderToScreen = true;
      this.output.render(
        this.renderer,
        f.opaqueOverlay,
        f.opaqueOverlay,
        0,
        false,
      );
    } else {
      this.overlayPass!.enabled = f.overlay;
      this.composer.render();
    }
    return true;
  }
  private disposeChain() {
    this.composer?.dispose();
    this.target?.dispose();
    this.bloom?.dispose();
    this.output?.material.dispose();
    this.composer = this.target = this.bloom = this.output = undefined;
    this.overlayPass = undefined;
  }
  dispose() {
    this.disposeChain();
  }
}
