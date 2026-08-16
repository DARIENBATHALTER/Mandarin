/**
 * Vehicle bodywork.
 *
 * Models are Kenney's Car Kit, CC0. See assets/cars/KENNEY-LICENSE.txt.
 * Deliberately not real marques: a recognisable production car carries the
 * manufacturer's trademark and trade dress, which is licensed to games, not
 * free for the taking.
 *
 * Each kit model already contains four named wheel nodes. Those get detached
 * and re-driven from the physics wheel positions, which means a truck keeps
 * truck wheels and a racer keeps slicks without any per-vehicle mapping table.
 * The kit's convention, confirmed by reading the files: front is +Z, left is
 * +X, wheel centres sit at y = 0.3, and the ground plane is y = 0.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const DIR = "./assets/cars";

// Everything in the kit that reads as drivable. This is the V-key cycle order.
export const CARS = [
  "sedan", "sedan-sports", "hatchback-sports", "suv", "suv-luxury",
  "van", "taxi", "police", "truck", "delivery",
  "race", "ambulance", "garbage-truck", "firetruck",
];

const loader = new GLTFLoader();
const cache = new Map();

async function loadGlb(name) {
  if (!cache.has(name)) cache.set(name, loader.loadAsync(`${DIR}/${name}.glb`));
  return (await cache.get(name)).scene.clone(true);
}

export async function loadCarModel(name, tune, restSag = tune.wheel.restSag) {
  const root = await loadGlb(name);

  // Pull the wheels out of the body. Left and right are modelled separately
  // (the hub cap only faces one way), so keep one of each as a prototype.
  const wheelNodes = [];
  root.traverse((o) => { if (/wheel/i.test(o.name)) wheelNodes.push(o); });
  let protoLeft = null, protoRight = null;
  for (const w of wheelNodes) {
    if (w.position.x >= 0 && !protoLeft) protoLeft = w;
    if (w.position.x < 0 && !protoRight) protoRight = w;
  }
  for (const w of wheelNodes) w.parent.remove(w);
  if (!protoLeft && !protoRight) {
    const fallback = await loadGlb("wheel-default");
    protoLeft = protoRight = fallback;
  }
  protoLeft = protoLeft || protoRight;
  protoRight = protoRight || protoLeft;

  // Scale the remaining bodywork to fill the collision box. Width and height
  // share a factor so the car is not distorted head on, which is the view you
  // spend the whole time looking at; only length is stretched, and the kit's
  // bodies are short enough that it reads as a longer car rather than a
  // smeared one.
  // The kit draws a narrow track under wide arches, so sizing the body to the
  // collision box alone leaves the tyres standing outside the fenders. Widen
  // just enough to cover the track instead.
  const bbox = new THREE.Box3().setFromObject(root);
  const size = bbox.getSize(new THREE.Vector3());
  const coverTrack = (tune.wheel.x + 0.15) * 2;
  const sx = Math.max(tune.chassis.hx * 2, coverTrack) / (size.x || 1.5);
  const sz = (tune.chassis.hz * 2 * 0.94) / (size.z || 2.55);
  root.scale.set(sx, sx, sz);

  // Drop the body so the model's ground plane meets the road at rest. Anything
  // else leaves the car hovering or buried to the sills.
  const groundY = tune.wheel.y - restSag - tune.wheel.radius;
  root.position.y = groundY - bbox.min.y * sx;

  prepare(root);

  const wheelBox = new THREE.Box3().setFromObject(protoLeft);
  const wheelSize = wheelBox.getSize(new THREE.Vector3());
  const ws = (tune.wheel.radius * 2) / (wheelSize.y || 0.6);

  // Physics wheel order is front-right, front-left, rear-right, rear-left:
  // index 0 sits at -x, and with forward = +Z and up = +Y, left is +X.
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const holder = new THREE.Group();
    const src = (i % 2 === 1) ? protoLeft : protoRight;
    const w = src.clone(true);
    w.position.set(0, 0, 0);
    w.rotation.set(0, 0, 0);
    w.scale.setScalar(ws);
    prepare(w);
    holder.add(w);
    wheels.push(holder);
  }

  return { body: root, wheels, name };
}

function prepare(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // Materials are shared out of the cache, so clone before touching them or
    // every vehicle inherits the last one's finish.
    if (o.material) {
      o.material = o.material.clone();
      o.material.roughness = 0.5;
      o.material.metalness = 0.2;
      if (o.material.map) o.material.map.anisotropy = 8;
    }
  });
}

/** The placeholder, kept as a fallback if the models fail to load. */
export function buildBoxCar(tune) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xa8cc55, roughness: 0.35, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x14202a, roughness: 0.12, metalness: 0.85 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.62, 4.1), bodyMat);
  hull.position.y = -0.06;
  hull.castShadow = true;
  g.add(hull);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.56, 2.0), glassMat);
  cabin.position.set(0, 0.5, -0.15);
  cabin.castShadow = true;
  g.add(cabin);
  const wheelGeo = new THREE.CylinderGeometry(tune.wheel.radius, tune.wheel.radius, 0.26, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.85 });
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.castShadow = true;
    wheels.push(w);
  }
  return { body: g, wheels, name: "box" };
}
