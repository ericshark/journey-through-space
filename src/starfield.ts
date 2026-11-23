/**
 * The sky: NASA's Milky Way panorama, ~9,000 individual stars and near-field
 * streaks. At speed the sky is relativistically aberrated towards the heading,
 * Doppler-tinted (blue ahead, red behind) and every star stretches along its own
 * apparent motion. All motion comes from the flight snapshot; nothing keeps time.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  type Camera,
} from 'three';
import { smooth } from './science';

const OUTPUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`;

/** Brightness of the panorama's brightest regions at sky exposure 1 (linear). */
const SKY_BRIGHTNESS = 0.32;

const ABERRATE = `
vec3 aberrate(vec3 s,vec3 h,float beta){
  float c=dot(s,h),co=(c+beta)/(1.+beta*c);
  vec3 p=s-h*c;float pl=length(p);
  return pl>1e-6?h*co+p/pl*sqrt(max(0.,1.-co*co)):s;
}`;
const BLACKBODY = `
vec3 blackbody(float k){
  float t=clamp(k,1500.,40000.)/100.;
  float r=t<=66.?1.:clamp(1.292936*pow(t-60.,-.1332047),0.,1.);
  float g=t<=66.?clamp(.3900816*log(t)-.6318414,0.,1.):clamp(1.129891*pow(t-60.,-.0755148),0.,1.);
  float b=t>=66.?1.:t<=19.?0.:clamp(.5432068*log(t-10.)-1.1962541,0.,1.);
  return pow(vec3(r,g,b),vec3(2.2));
}`;
/** Capsule fragment shared by stars and streaks: bright head, fading tail. */
const CAPSULE_FRAG = `
varying vec3 vC;
varying vec2 vQ;
varying float vLen, vW, vHalo;
void main(){
  float x=clamp(vQ.x,0.,vLen);
  float progress=x/max(vLen,0.001);
  float trail=smoothstep(0.,3.*vW,vLen);
  float taper=mix(1.,mix(.24,1.,sqrt(progress)),trail);
  vec2 delta=vec2(vQ.x-x,vQ.y)/(vW*taper);
  float radius2=dot(delta,delta);
  float edge=1.-smoothstep(.55,1.,radius2);
  float core=exp(-radius2*5.5);
  float halo=vHalo*exp(-radius2*1.8)*.24;
  float along=mix(1.,mix(.025,1.,pow(progress,1.5)),trail);
  gl_FragColor=vec4(vC*(core+halo)*edge*along,1.);
  ${OUTPUT}
}`;
/** Screen-space quad between a projected tail and head, `width` px half-width. */
const CAPSULE_QUAD = `
attribute vec2 aCorner;uniform vec2 uViewport;
varying vec2 vQ;varying float vLen,vW,vHalo;
vec4 capsule(vec4 ch,vec4 ct,float width,float depth){
  vec2 sh=ch.xy/ch.w*.5*uViewport,st=ct.xy/ct.w*.5*uViewport;
  vec2 axis=sh-st;float len=length(axis);
  vec2 dir=len>1e-3?axis/len:vec2(1.,0.),nrm=vec2(-dir.y,dir.x);
  vec2 pos=mix(st-dir*width,sh+dir*width,aCorner.x)+nrm*aCorner.y*width;
  vQ=vec2(aCorner.x*(len+2.*width)-width,aCorner.y*width);vLen=len;vW=width;
  return vec4(pos/(.5*uViewport),depth,1.);
}`;

function quadGeometry(count: number) {
  const g = new InstancedBufferGeometry();
  g.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0], 3),
  );
  g.setAttribute(
    'aCorner',
    new Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = count;
  return g;
}

function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
const gaussian = (r: () => number) =>
  Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());

/** Galactic → render-space rotation for a galactic-centre direction and north. */
function galacticBasis(centre: Vector3, north: Vector3) {
  const x = centre.clone().normalize();
  const z = north
    .clone()
    .sub(x.clone().multiplyScalar(north.dot(x)))
    .normalize();
  const y = z.clone().cross(x);
  return new Matrix4().makeBasis(x, y, z);
}
/**
 * Sky orientation by route position: through the inner system the galactic core
 * sits behind and above; across the interstellar legs it swings dead ahead, so the
 * visitor visibly flies into the bright heart of the Milky Way.
 */
const INNER = new Quaternion().setFromRotationMatrix(
  galacticBasis(new Vector3(-0.55, 0.32, -0.77), new Vector3(0.38, 0.92, 0.1)),
);
const OUTER = new Quaternion().setFromRotationMatrix(
  galacticBasis(new Vector3(0.02, -0.05, 1), new Vector3(0.42, 0.9, 0)),
);
export function skyRotation(position: number) {
  return INNER.clone().slerp(OUTER, smooth((position - 8.5) / 3.3));
}

export interface StreakSpec {
  count: number;
  spread: [number, number];
  depth: number;
  /** World-space size of a speck. */
  size: number;
  /** World units of drift per unit of travel. */
  drift: number;
  colors: string[];
  seed: number;
  /** Streak length in world units at full stretch. */
  streak: number;
  /** Widest a speck may draw, in device pixels. */
  maxWidth?: number;
}

/** Near-field specks drifting towards the camera along local −Z, drawn as streaks. */
export class StreakField {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  constructor(spec: StreakSpec) {
    const random = rng(spec.seed * 7919);
    const pos: number[] = [],
      col: number[] = [];
    for (let i = 0; i < spec.count; i++) {
      pos.push(
        (random() - 0.5) * spec.spread[0] * 2,
        (random() - 0.5) * spec.spread[1] * 2,
        random() * spec.depth,
      );
      const hex = spec.colors[Math.floor(random() * spec.colors.length)];
      const shade = 0.55 + 0.45 * random();
      for (let k = 0; k < 3; k++)
        col.push(
          (parseInt(hex.slice(1 + 2 * k, 3 + 2 * k), 16) / 255) ** 2.2 * shade,
        );
    }
    const g = quadGeometry(spec.count);
    g.setAttribute(
      'aPos',
      new InstancedBufferAttribute(new Float32Array(pos), 3),
    );
    g.setAttribute(
      'aColor',
      new InstancedBufferAttribute(new Float32Array(col), 3),
    );
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTravel: { value: 0 },
        uDrift: { value: spec.drift },
        uDepth: { value: spec.depth },
        uSize: { value: spec.size },
        uFocal: { value: 1000 },
        uStretch: { value: 0 },
        uStreak: { value: spec.streak },
        uOpacity: { value: 0 },
        uViewport: { value: new Vector2(1, 1) },
        uMaxWidth: { value: spec.maxWidth ?? 10 },
      },
      vertexShader: `attribute vec3 aPos;attribute vec3 aColor;
uniform float uTravel,uDrift,uDepth,uSize,uFocal,uStretch,uStreak,uOpacity,uMaxWidth;
varying vec3 vC;
${CAPSULE_QUAD}
void main(){
  float z=mod(aPos.z-uTravel*uDrift,uDepth)+2.;
  float fade=smoothstep(2.,22.,z)*(1.-smoothstep(uDepth*.7,uDepth,z));
  vec4 vh=modelViewMatrix*vec4(aPos.xy,z,1.);
  vec4 vt=modelViewMatrix*vec4(aPos.xy,z+uStretch*uStreak,1.);
  if(vh.z>-.05){gl_Position=vec4(2.,2.,2.,1.);return;}
  if(vt.z>-.05)vt=vh;
  vec4 ch=projectionMatrix*vh,ct=projectionMatrix*vt;
  float width=clamp(uSize*uFocal/max(1.,-vh.z),.6,uMaxWidth);
  float len=length((ch.xy/ch.w-ct.xy/ct.w)*.5*uViewport);
  // Spread a speck's light along its streak so long streaks don't flare.
  vC=aColor*fade*uOpacity*mix(1.,(2.*width)/(2.*width+len),.6);
  vHalo=0.;
  gl_Position=capsule(ch,ct,width,ch.z/ch.w);
}`,
      fragmentShader: CAPSULE_FRAG,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Panorama and catalogue-like stars at infinity. */
export class Starfield {
  readonly sky: Mesh;
  readonly stars: Mesh;
  private skyMaterial: ShaderMaterial;
  private starMaterial: ShaderMaterial;
  private galactic = new Matrix3();
  private world = new Matrix3();
  constructor(private count = 9000) {
    const tri = new BufferGeometry();
    tri.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3),
    );
    this.skyMaterial = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        map: { value: null },
        uHasMap: { value: 0 },
        uProjInv: { value: new Matrix4() },
        uCamWorld: { value: new Matrix4() },
        uGalFromWorld: { value: this.galactic },
        uHeading: { value: new Vector3(0, 0, 1) },
        uBeta: { value: 0 },
        uExposure: { value: 1 },
        uTint: { value: new Vector3(1, 1, 1) },
      },
      vertexShader: `uniform mat4 uProjInv;uniform mat4 uCamWorld;varying vec3 vRay;
void main(){vec4 v=uProjInv*vec4(position.xy,1.,1.);vRay=mat3(uCamWorld)*(v.xyz/v.w);gl_Position=vec4(position.xy,1.,1.);}`,
      fragmentShader: `uniform sampler2D map;uniform float uHasMap;uniform mat3 uGalFromWorld;uniform vec3 uHeading;
uniform float uBeta;uniform float uExposure;uniform vec3 uTint;varying vec3 vRay;
void main(){
  vec3 d=normalize(vRay);
  float co=dot(d,uHeading);
  // Inverse aberration: which source direction appears here at this speed?
  float cs=(co-uBeta)/(1.-uBeta*co);
  vec3 p=d-uHeading*co;float pl=length(p);
  vec3 s=pl>1e-6?uHeading*cs+p/pl*sqrt(max(0.,1.-cs*cs)):d;
  vec3 g=uGalFromWorld*s;
  vec2 uv=vec2(.5-atan(g.y,g.x)/6.2831853,.5+asin(clamp(g.z,-1.,1.))/3.14159265);
  vec3 c=uHasMap>.5?texture2D(map,uv).rgb:vec3(.004);
  float D=inversesqrt(1.-uBeta*uBeta)*(1.+uBeta*cs);
  c*=min(pow(D,1.5),2.2);
  c=mix(c,c*vec3(.7,.86,1.3),clamp((D-1.)*.45,0.,1.));
  c=mix(c,c*vec3(1.35,.62,.4),clamp((1.-D)*1.4,0.,1.));
  gl_FragColor=vec4(c*${SKY_BRIGHTNESS.toFixed(3)}*uExposure*uTint,1.);
  ${OUTPUT}
}`,
    });
    this.sky = new Mesh(tri, this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -100;

    const random = rng(1123);
    const dir: number[] = [],
      mag: number[] = [],
      temp: number[] = [];
    for (let i = 0; i < count; i++) {
      // Concentrated towards the galactic plane and core, like the real sky.
      let l: number, b: number;
      const kind = random();
      if (kind < 0.42) {
        const z = random() * 2 - 1;
        l = random() * Math.PI * 2;
        b = Math.asin(z);
      } else {
        l =
          kind < 0.62 ? gaussian(random) * 0.7 : (random() - 0.5) * Math.PI * 2;
        b = gaussian(random) * (kind < 0.62 ? 0.12 : 0.22);
      }
      dir.push(
        Math.cos(b) * Math.cos(l),
        Math.cos(b) * Math.sin(l),
        Math.sin(b),
      );
      const r = random();
      mag.push(0.05 + 0.5 * r ** 5 + 4 * r ** 40);
      const t = random();
      temp.push(
        t < 0.12
          ? 3200 + 900 * random()
          : t < 0.85
            ? 4600 + 2600 * random()
            : 8000 + 5000 * random(),
      );
    }
    const g = quadGeometry(count);
    g.setAttribute(
      'aDir',
      new InstancedBufferAttribute(new Float32Array(dir), 3),
    );
    g.setAttribute(
      'aMag',
      new InstancedBufferAttribute(new Float32Array(mag), 1),
    );
    g.setAttribute(
      'aTemp',
      new InstancedBufferAttribute(new Float32Array(temp), 1),
    );
    this.starMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uWorldFromGal: { value: this.world },
        uHeading: { value: new Vector3(0, 0, 1) },
        uBeta: { value: 0 },
        uStretch: { value: 0 },
        uExposure: { value: 1 },
        uPx: { value: 1 },
        uViewport: { value: new Vector2(1, 1) },
      },
      vertexShader: `attribute vec3 aDir;attribute float aMag;attribute float aTemp;
uniform mat3 uWorldFromGal;uniform vec3 uHeading;uniform float uBeta;uniform float uStretch;
uniform float uExposure;uniform float uPx;varying vec3 vC;
${ABERRATE}${BLACKBODY}${CAPSULE_QUAD}
void main(){
  vec3 s=uWorldFromGal*aDir;
  vec3 head=aberrate(s,uHeading,uBeta);
  // The tail traces where aberration has carried the star from: a smear of its motion.
  vec3 tail=aberrate(s,uHeading,max(0.,uBeta-uStretch*mix(.12,.19,smoothstep(.45,2.,aMag))));
  vec4 ch=projectionMatrix*vec4(mat3(viewMatrix)*head,1.);
  vec4 ct=projectionMatrix*vec4(mat3(viewMatrix)*tail,1.);
  if(ch.w<=0.){gl_Position=vec4(2.,2.,2.,1.);return;}
  if(ct.w<=0.)ct=ch;
  float co=dot(s,uHeading);
  float D=inversesqrt(1.-uBeta*uBeta)*(1.+uBeta*co);
  vHalo=smoothstep(.4,2.,aMag);
  float width=max(.85,uPx*(1.+1.7*vHalo));
  float len=length((ch.xy/ch.w-ct.xy/ct.w)*.5*uViewport);
  vC=blackbody(aTemp*D)*aMag*min(D*D,2.)*uExposure*mix(1.,(2.*width)/(2.*width+len),.7);
  gl_Position=capsule(ch,ct,width,.99999);
}`,
      fragmentShader: CAPSULE_FRAG,
    });
    this.stars = new Mesh(g, this.starMaterial);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -90;
  }
  setMap(map: Texture | null) {
    if (this.skyMaterial.uniforms.map.value === map) return;
    // Equirectangular panorama sampled near 1:1, so no mipmaps: this also avoids
    // a mip seam where longitude wraps.
    if (map) {
      map.generateMipmaps = false;
      map.minFilter = LinearFilter;
      if (map.image) map.needsUpdate = true;
    }
    this.skyMaterial.uniforms.map.value = map;
    this.skyMaterial.uniforms.uHasMap.value = map ? 1 : 0;
  }
  update(o: {
    camera: Camera;
    position: number;
    heading: Vector3;
    beta: number;
    stretch: number;
    exposure: number;
    tint: [number, number, number];
    viewport: Vector2;
    pixelRatio: number;
    /** Fraction of stars drawn; the order is random, so a prefix is a fair subset. */
    density?: number;
  }) {
    const g = this.stars.geometry as InstancedBufferGeometry;
    g.instanceCount = Math.round(this.count * (o.density ?? 1));
    const rotation = new Matrix4().makeRotationFromQuaternion(
      skyRotation(o.position),
    );
    this.world.setFromMatrix4(rotation);
    this.galactic.copy(this.world).transpose();
    const su = this.skyMaterial.uniforms;
    su.uProjInv.value.copy(o.camera.projectionMatrixInverse);
    su.uCamWorld.value.copy(o.camera.matrixWorld);
    su.uHeading.value.copy(o.heading);
    su.uBeta.value = o.beta;
    su.uExposure.value = o.exposure;
    const peak = Math.max(...o.tint, 1e-6);
    su.uTint.value.set(
      0.55 + (0.45 * o.tint[0]) / peak,
      0.55 + (0.45 * o.tint[1]) / peak,
      0.55 + (0.45 * o.tint[2]) / peak,
    );
    const st = this.starMaterial.uniforms;
    st.uHeading.value.copy(o.heading);
    st.uBeta.value = o.beta;
    st.uStretch.value = o.stretch;
    st.uExposure.value = o.exposure;
    st.uPx.value = o.pixelRatio;
    st.uViewport.value.copy(o.viewport);
  }
  dispose() {
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.stars.geometry.dispose();
    this.starMaterial.dispose();
  }
}
