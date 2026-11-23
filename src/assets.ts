/**
 * Texture requirements per stop. The renderer loads these through one shared
 * cache; this module is pure data so lifecycle rules can be tested directly.
 */
import {
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { CHECKPOINTS } from './journey';

export interface AssetSpec {
  name: string;
  ext: 'jpg' | 'png' | 'webp';
  /** Colour used only if the real file fails to load. */
  fallback: string;
  linear?: boolean;
  /** Greyscale data uploaded as one channel to save GPU memory. */
  single?: boolean;
}
export const ASSETS: Record<string, AssetSpec> = {
  milkyway: { name: 'milkyway', ext: 'jpg', fallback: '#05080c' },
  earth: { name: 'earth', ext: 'jpg', fallback: '#27618e' },
  night: { name: 'night', ext: 'jpg', fallback: '#000000' },
  clouds: {
    name: 'clouds',
    ext: 'jpg',
    fallback: '#000000',
    linear: true,
    single: true,
  },
  'earth-normal': {
    name: 'earth-normal',
    ext: 'jpg',
    fallback: '#8080ff',
    linear: true,
  },
  'earth-specular': {
    name: 'earth-specular',
    ext: 'jpg',
    fallback: '#000000',
    linear: true,
    single: true,
  },
  moon: { name: 'moon', ext: 'jpg', fallback: '#9a9a9a' },
  'moon-normal': {
    name: 'moon-normal',
    ext: 'jpg',
    fallback: '#8080ff',
    linear: true,
  },
  'mars-normal': {
    name: 'mars-normal',
    ext: 'jpg',
    fallback: '#8080ff',
    linear: true,
  },
  mercury: { name: 'mercury', ext: 'jpg', fallback: '#8d8478' },
  venus: { name: 'venus', ext: 'jpg', fallback: '#d9bd86' },
  sun: { name: 'sun', ext: 'jpg', fallback: '#ff9d2e' },
  mars: { name: 'mars', ext: 'jpg', fallback: '#a5573a' },
  jupiter: { name: 'jupiter', ext: 'jpg', fallback: '#c4a27e' },
  saturn: { name: 'saturn', ext: 'jpg', fallback: '#d8c08c' },
  'saturn-rings': { name: 'saturn-rings', ext: 'png', fallback: '#b8a47c' },
  uranus: { name: 'uranus', ext: 'jpg', fallback: '#9fd4d8' },
  neptune: { name: 'neptune', ext: 'jpg', fallback: '#3f62c8' },
};
/** Equirectangular maps tile around longitude. The ring strip is radial. */
export function configureTexture(
  texture: Texture,
  name: string,
  anisotropy: number,
) {
  const spec = ASSETS[name];
  texture.colorSpace = spec.linear ? NoColorSpace : SRGBColorSpace;
  if (name !== 'saturn-rings') texture.wrapS = RepeatWrapping;
  if (spec.single) texture.format = RedFormat;
  texture.anisotropy = anisotropy;
}
const EXTRA: Record<string, string[]> = {
  earth: ['night', 'clouds', 'earth-normal', 'earth-specular'],
  moon: ['moon-normal'],
  mars: ['mars-normal'],
  saturn: ['saturn-rings'],
};
/**
 * 8K upgrades for base maps. They stream in only on the high quality tier and
 * only for the world being observed, then are released on departure, so at most
 * a couple of 8K textures are ever resident. Base maps always load first.
 */
export const HERO: Record<string, string> = {
  earth: 'earth-8k.webp',
  clouds: 'clouds-8k.webp',
  moon: 'moon-8k.webp',
  mars: 'mars-8k.webp',
  mercury: 'mercury-8k.webp',
  milkyway: 'milkyway-8k.webp',
};
/** Hero upgrades wanted while observing `stop`. */
export function heroAssetsFor(stop: number): string[] {
  return assetsFor(CHECKPOINTS[stop].id).filter((name) => name in HERO);
}
/** Every texture the stop needs while it is built. */
export function assetsFor(id: string): string[] {
  const stop = CHECKPOINTS.find((p) => p.id === id);
  return [...(stop?.texture ? [stop.texture] : []), ...(EXTRA[id] ?? [])];
}
/** Stops whose scenes are kept alive around a leg: previous, both ends, next. */
export function residentStops(leg: number) {
  const last = CHECKPOINTS.length - 1;
  const from = Math.max(0, leg - 1),
    to = Math.min(last, leg + 2);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
/** Textures to keep while `leg` is active; everything else may be disposed. */
export function residentAssets(leg: number) {
  const set = new Set<string>(['milkyway']);
  for (const i of residentStops(leg))
    for (const name of assetsFor(CHECKPOINTS[i].id)) set.add(name);
  return set;
}
