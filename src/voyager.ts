/**
 * Illustrative Voyager 1 model, +Z along the high-gain dish axis. Dish, bus, RTG,
 * science and magnetometer booms and the plasma-wave antennas keep the real layout;
 * boom lengths are compressed (≈ 1/4) so the whole silhouette fits inside the
 * maximum-zoom frame. Proportions follow NASA/JPL Voyager spacecraft descriptions
 * (3.7 m dish, ≈13 m magnetometer boom, 10 m plasma-wave antennas).
 */
import {
  Box3,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Texture,
  Vector2,
  Vector3,
} from 'three';

const foil = () =>
  new MeshStandardMaterial({
    color: '#c99a3c',
    metalness: 0.85,
    roughness: 0.38,
    flatShading: true,
  });
const white = () =>
  new MeshStandardMaterial({
    color: '#ebe8dd',
    metalness: 0.25,
    roughness: 0.55,
    side: DoubleSide,
  });
const steel = () =>
  new MeshStandardMaterial({
    color: '#b7bbbd',
    metalness: 0.9,
    roughness: 0.4,
  });
const dark = () =>
  new MeshStandardMaterial({
    color: '#34373a',
    metalness: 0.6,
    roughness: 0.6,
  });

/** A rod between two points. */
function rod(
  from: Vector3,
  to: Vector3,
  radius: number,
  material: MeshStandardMaterial,
) {
  const length = from.distanceTo(to);
  const mesh = new Mesh(
    new CylinderGeometry(radius, radius, length, 8),
    material,
  );
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(
    new Vector3(0, 1, 0),
    to.clone().sub(from).normalize(),
  );
  return mesh;
}

export function buildVoyager(): Group {
  const craft = new Group();
  // Parabolic high-gain dish, apex behind the rim, opening toward +Z.
  const profile: Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const r = (0.68 * i) / 24;
    profile.push(new Vector2(r, -0.14 + 0.36 * (r / 0.68) ** 2 * 0.62));
  }
  const dish = new Mesh(new LatheGeometry(profile, 72), white());
  dish.rotation.x = Math.PI / 2;
  craft.add(dish);
  // Decagonal bus behind the dish.
  const bus = new Mesh(new CylinderGeometry(0.33, 0.33, 0.3, 10), foil());
  bus.rotation.x = Math.PI / 2;
  bus.position.z = -0.3;
  craft.add(bus);
  // Feed and sub-reflector on three struts, low-gain antenna on top.
  const feed = new Mesh(new ConeGeometry(0.07, 0.12, 24), steel());
  feed.rotation.x = -Math.PI / 2;
  feed.position.z = 0.42;
  craft.add(feed);
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + Math.PI / 6;
    craft.add(
      rod(
        new Vector3(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.2),
        new Vector3(Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0.4),
        0.008,
        steel(),
      ),
    );
  }
  const low = new Mesh(new CylinderGeometry(0.015, 0.015, 0.16, 8), steel());
  low.rotation.x = Math.PI / 2;
  low.position.z = 0.5;
  craft.add(low);

  // RTG boom (−X): truss with three stacked generators.
  craft.add(
    rod(
      new Vector3(-0.3, 0, -0.32),
      new Vector3(-1.05, 0, -0.32),
      0.014,
      steel(),
    ),
  );
  for (let i = 0; i < 3; i++) {
    const rtg = new Mesh(new CylinderGeometry(0.06, 0.06, 0.32, 16), dark());
    rtg.rotation.z = Math.PI / 2;
    rtg.position.set(-0.55 - i * 0.2, 0, -0.32);
    craft.add(rtg);
    const fins = new Mesh(
      new CylinderGeometry(0.085, 0.085, 0.04, 16),
      steel(),
    );
    fins.rotation.z = Math.PI / 2;
    fins.position.copy(rtg.position);
    craft.add(fins);
  }
  // Science boom (+X): scan platform with cameras and spectrometers.
  craft.add(
    rod(
      new Vector3(0.3, 0, -0.32),
      new Vector3(0.95, 0, -0.32),
      0.012,
      steel(),
    ),
  );
  const platform = new Mesh(new BoxGeometry(0.26, 0.14, 0.2), foil());
  platform.position.set(1.0, 0, -0.32);
  craft.add(platform);
  for (const [dy, dz] of [
    [0.06, 0.04],
    [-0.06, 0.04],
  ]) {
    const lens = new Mesh(new CylinderGeometry(0.035, 0.045, 0.16, 14), dark());
    lens.rotation.z = Math.PI / 2;
    lens.position.set(1.0, dy, -0.32 + dz + 0.1);
    craft.add(lens);
  }
  // Magnetometer boom (+Y, longest): thin lattice with mid and tip sensors.
  craft.add(
    rod(new Vector3(0, 0.3, -0.3), new Vector3(0, 3.1, -0.3), 0.01, steel()),
  );
  for (const y of [1.6, 3.1]) {
    const sensor = new Mesh(new BoxGeometry(0.07, 0.07, 0.07), foil());
    sensor.position.set(0, y, -0.3);
    craft.add(sensor);
  }
  // Plasma-wave antennas: V below the bus.
  for (const side of [-1, 1])
    craft.add(
      rod(
        new Vector3(0, -0.3, -0.34),
        new Vector3(side * 1.9, -1.65, -0.34),
        0.009,
        steel(),
      ),
    );
  // Propellant tank band and instrument bay details.
  const band = new Mesh(new SphereGeometry(0.1, 16, 12), steel());
  band.position.set(0, -0.2, -0.5);
  craft.add(band);

  // Recentre on the bounding box so the orbit target is the visual centre.
  const centre = new Box3().setFromObject(craft).getCenter(new Vector3());
  for (const child of craft.children) child.position.sub(centre);
  return craft;
}
/** Distance from the model origin to its farthest point, in scene units. */
export function voyagerExtent() {
  const craft = buildVoyager();
  craft.updateMatrixWorld(true);
  const box = new Box3().setFromObject(craft);
  const corners = [box.min, box.max];
  let max = 0;
  for (const x of [0, 1])
    for (const y of [0, 1])
      for (const z of [0, 1])
        max = Math.max(
          max,
          new Vector3(corners[x].x, corners[y].y, corners[z].z).length(),
        );
  return max;
}

/** NASA VTAD's textured model. Keep the reference geometry in its original proportions. */
export async function loadVoyager() {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { scene } = await new GLTFLoader().loadAsync('/models/voyager.glb');
  // NASA's dish opens along +Y. The inspection scene expects +Z.
  scene.rotation.set(Math.PI / 2, 0, Math.PI, 'ZYX');
  const bounds = new Box3().setFromObject(scene);
  const scale = 6.1 / bounds.getSize(new Vector3()).length();
  scene.scale.setScalar(scale);
  scene.position.copy(bounds.getCenter(new Vector3())).multiplyScalar(-scale);
  scene.traverse((child) => {
    if (
      !(child instanceof Mesh) ||
      !(child.material instanceof MeshStandardMaterial)
    )
      return;
    const material = child.material;
    // Use the baked surface colors for a little fill on the side facing away
    // from the sun, so the bus and instruments stay readable in orbit.
    material.metalness *= 0.7;
    if (material.map && !material.transparent) {
      material.emissiveMap = material.map;
      material.emissive.setScalar(0.14);
    }
  });
  return new Group().add(scene);
}

export function disposeVoyager(craft: Group) {
  const materials = new Set<MeshStandardMaterial>();
  craft.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    const meshMaterials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of meshMaterials) materials.add(material);
  });
  const textures = new Set<Texture>();
  for (const material of materials) {
    for (const value of Object.values(material))
      if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    if (texture.image instanceof ImageBitmap) texture.image.close();
    texture.dispose();
  }
}
