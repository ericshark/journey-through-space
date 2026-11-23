export const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Units: the Schwarzschild radius is 1, so the horizon is r = 1, the photon
// sphere is r = 1.5 and the innermost stable orbit is r = 3.
export const fragmentShader = /* glsl */ `
precision highp float;

uniform vec2 uResolution;
uniform float uOpacity;
uniform float uDarkness;
uniform vec2 uOffset;
uniform float uTime;
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform float uTanHalfFov;
uniform sampler2D uSky;
uniform mat3 uGalFromLens;

varying vec2 vUv;

const float DISK_IN = 2.4;
const float DISK_OUT = 11.0;
const float ESCAPE_R = 60.0;
const int MAX_STEPS = 120;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
        mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
        mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return v;
}

// Art-directed emission ramp: deep red, ember, gold, white-hot, blue-white.
// t is roughly temperature relative to the disk's inner edge after Doppler shift.
vec3 diskRamp(float t) {
  vec3 c = mix(vec3(0.32, 0.03, 0.01), vec3(1.0, 0.27, 0.04), smoothstep(0.08, 0.42, t));
  c = mix(c, vec3(1.0, 0.62, 0.22), smoothstep(0.38, 0.75, t));
  c = mix(c, vec3(1.0, 0.93, 0.80), smoothstep(0.75, 1.15, t));
  c = mix(c, vec3(0.70, 0.84, 1.0), smoothstep(1.2, 1.9, t));
  return c;
}

vec3 stars(vec3 dir) {
  vec3 p = dir * 135.0;
  vec3 cell = floor(p);
  vec3 h = hash33(cell);
  if (h.y < 0.89) return vec3(0.0);
  float d = length(fract(p) - 0.5 - (h - 0.5) * 0.48);
  float core = (1.0 - smoothstep(0.02, 0.22, d)) * pow(h.x, 8.0);
  return mix(vec3(1.0, 0.83, 0.69), vec3(0.76, 0.87, 1.0), h.z) * core * 0.55;
}

vec3 sky(vec3 dir) {
  vec3 g = uGalFromLens * dir;
  vec2 uv = vec2(0.5 - atan(g.y, g.x) / 6.2831853,
                 0.5 + asin(clamp(g.z, -1.0, 1.0)) / 3.14159265);
  // Fixed detail level avoids ringing where adjacent lensed rays diverge.
  vec3 dust = textureLod(uSky, uv, 1.5).rgb;
  return dust * vec3(0.37, 0.29, 0.23) + stars(g);
}

// Emission and opacity where a ray pierces the disk plane at p.
vec4 diskSample(vec3 p, vec3 rayDir) {
  float r = length(p.xz);
  if (r < DISK_IN || r > DISK_OUT) return vec4(0.0);

  float angle = atan(p.z, p.x);
  float omega = 1.6 / pow(r, 1.5);
  float a = angle + uTime * omega;
  vec2 q = vec2(cos(a), sin(a)) * r;
  float turbulence = fbm(vec3(q * 0.92, r * 0.3));
  float streaks = fbm(vec3(q * 1.75, r * 10.5 + turbulence * 3.7));
  float strands = fbm(vec3(q * 3.2, r * 24.0 + streaks * 3.0));
  float lanes = mix(0.5, 1.0, smoothstep(0.19, 0.8, streaks * 0.74 + strands * 0.26));

  float density = smoothstep(DISK_IN, DISK_IN + 0.5, r) * (1.0 - smoothstep(DISK_OUT - 5.5, DISK_OUT, r));
  density *= (0.39 + 0.61 * turbulence) * lanes;

  // Keplerian orbital velocity and relativistic Doppler factor toward the camera.
  vec3 velDir = normalize(vec3(-p.z, 0.0, p.x));
  float beta = min(sqrt(0.5 / r), 0.7);
  float gamma = inversesqrt(1.0 - beta * beta);
  float doppler = 1.0 / (gamma * (1.0 - beta * dot(velDir, -rayDir)));
  float shift = doppler * sqrt(1.0 - 1.0 / r);

  float heat = pow(DISK_IN / r, 0.85);
  vec3 col = diskRamp(heat * pow(shift, 1.6) * (0.85 + 0.3 * streaks));
  float intensity = density * pow(heat, 1.15) * pow(shift, 3.0) * 4.4;
  return vec4(col * intensity, clamp(density * 1.05, 0.0, 0.94));
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 acceleration(vec3 p, float h2) {
  float invR = inversesqrt(max(dot(p, p), 0.25));
  float invR2 = invR * invR;
  return -1.5 * h2 * p * invR * invR2 * invR2;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 + uOffset;
  if (uDarkness >= 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, uOpacity); return; }
  float aspect = uResolution.x / uResolution.y;
  vec3 rd = normalize(uCamBasis * vec3(ndc.x * uTanHalfFov * aspect, ndc.y * uTanHalfFov, 1.0));

  vec3 pos = uCamPos;
  vec3 vel = rd;
  vec3 angular = cross(pos, vel);
  float h2 = dot(angular, angular);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  float glow = 0.0;
  float ringGlow = 0.0;
  bool captured = false;
  vec3 acc = acceleration(pos, h2);

  for (int i = 0; i < MAX_STEPS; i++) {
    float r = length(pos);
    float dt = clamp(0.078 * r, 0.027, max(1.2, r * 0.078));

    // Leapfrog integration keeps the lens stable without pixel or time jitter.
    vec3 prev = pos;
    vel += acc * (0.5 * dt);
    pos += vel * dt;
    float rNew = length(pos);
    if (rNew < 1.0) {
      captured = true;
      break;
    }
    acc = acceleration(pos, h2);
    vel += acc * (0.5 * dt);

    if (prev.y * pos.y < 0.0) {
      vec3 hit = mix(prev, pos, prev.y / (prev.y - pos.y));
      vec4 d = diskSample(hit, normalize(vel));
      col += trans * d.rgb * d.a;
      trans *= 1.0 - d.a;
    }

    // Thin volumetric haze hugging the disk, plus the photon ring's halo.
    float diskBand = smoothstep(DISK_IN - 0.4, DISK_IN + 1.0, rNew) * (1.0 - smoothstep(DISK_IN + 2.0, DISK_OUT + 2.0, rNew));
    glow += exp(-abs(pos.y) * 5.0) * diskBand * dt * 0.018 / max(rNew - 1.0, 0.3);
    ringGlow += exp(-pow((rNew - 1.5) * 7.0, 2.0)) * dt * 0.027;

    if (trans < 0.01) break;
    if (rNew > ESCAPE_R && dot(pos, vel) > 0.0) break;
  }

  if (!captured) col += trans * sky(normalize(vel)) + ringGlow * vec3(1.0, 0.7, 0.42);
  col += glow * vec3(1.0, 0.45, 0.16);

  col = aces(col * 1.25);

  vec2 vig = vUv - 0.5;
  col *= 1.0 - dot(vig, vig) * 0.62;

  gl_FragColor = vec4(col * (1.0 - uDarkness), uOpacity);
}
`;
