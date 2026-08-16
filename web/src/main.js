/**
 * Mandarin. Drive a 5 km square of Jacksonville built from public data.
 *
 * Frame convention throughout: +X east, -Z north, +Y up, metres, with the
 * origin at the config lat/lon. Nothing here ever sees a latitude.
 */
import * as THREE from "three";
import {
  loadMeta, buildTerrain, buildRoads, buildBuildings, buildWater,
} from "./world.js";
import { RoadNetwork, MapView } from "./map.js";
import { CARS, loadCarModel, buildBoxCar } from "./car-model.js";
import {
  initPhysics, addTerrain, addRoads, verifyTerrain, sampleTerrain, Car, TUNE,
} from "./physics.js";

const SUN = new THREE.Vector3(0.42, 0.78, 0.28).normalize();
const FOG = { color: 0xa9bccb, near: 380, far: 2300 };
const FIXED_DT = 1 / 60;

const boot = document.getElementById("boot");
const bootMsg = document.getElementById("bootmsg");
const bar = document.querySelector("#bar i");
let progress = 0;
function step(msg, pct) {
  progress = pct;
  bootMsg.textContent = msg;
  bar.style.width = `${pct}%`;
  // Yield with a timer rather than a frame. requestAnimationFrame does not
  // fire in a background tab, so a rAF-based loader deadlocks at whatever
  // percentage it happened to reach when the tab lost focus.
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Frame pump. Uses rAF when the page is visible and falls back to a timer when
 * it is not, so the simulation keeps running in a background tab instead of
 * freezing mid-drive.
 */
function schedule(fn) {
  if (document.hidden) setTimeout(() => fn(performance.now()), 16);
  else requestAnimationFrame(fn);
}

export async function start() {
  await step("physics", 5);
  const world = await initPhysics();

  await step("world index", 10);
  const meta = await loadMeta();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG.color);
  scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 6000);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.5);
  sun.position.copy(SUN).multiplyScalar(600);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 500;
  const s = 120;
  Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xbcd4e6, 0x4a4436, 1.05));

  await step("terrain", 20);
  let texLoaded = 0;
  const terrain = await buildTerrain(meta, () => {
    texLoaded++;
    if (texLoaded % 12 === 0) bar.style.width = `${progress + (texLoaded / 100) * 18}%`;
  });
  scene.add(terrain.group);

  await step("terrain collision", 40);
  addTerrain(world, terrain);
  const check = verifyTerrain(world, terrain);
  if (check.checked && check.worst > 1.0) {
    console.warn(`terrain collision disagrees with the visual mesh by up to ` +
      `${check.worst.toFixed(2)} m over ${check.checked} probes. ` +
      `The heightfield row/column order is probably transposed.`);
  } else {
    console.log(`terrain collision matches mesh within ${check.worst.toFixed(3)} m ` +
      `over ${check.checked} probes`);
  }

  await step("roads", 55);
  const roads = await buildRoads(meta, SUN, FOG);
  scene.add(roads.mesh);
  addRoads(world, roads.positions, roads.index);

  await step("buildings", 72);
  scene.add(await buildBuildings(meta));

  await step("water", 84);
  const water = await buildWater(meta);
  if (water) scene.add(water);

  await step("road network", 88);
  const network = await RoadNetwork.load(meta);

  await step("map", 92);
  const mapView = await MapView.load(meta, network);

  await step("car", 96);
  // ?at=<lat>,<lon> drops you anywhere in the box. Paste a coordinate straight
  // out of a maps app and start at your own driveway.
  const car = new Car(world, spawnFromUrl(meta, network) || meta.spawn);

  // Let the suspension settle once, then place every body from the real ride
  // height rather than a guess.
  const restSag = car.measureRestSag();
  car.respawn(car.spawn);

  const wanted = new URLSearchParams(location.search).get("car");
  let carIndex = Math.max(0, CARS.indexOf(wanted));
  const carGroup = new THREE.Group();
  scene.add(carGroup);
  await setCarModel(carIndex);

  async function setCarModel(i) {
    carIndex = ((i % CARS.length) + CARS.length) % CARS.length;
    let model;
    try {
      model = await loadCarModel(CARS[carIndex], TUNE, restSag);
    } catch (e) {
      console.warn(`car model "${CARS[carIndex]}" failed to load, using the placeholder`, e);
      model = buildBoxCar(TUNE);
    }
    carGroup.clear();
    carGroup.add(model.body);
    for (const w of model.wheels) carGroup.add(w);
    carGroup.userData.wheels = model.wheels;
    const el = document.getElementById("carname");
    if (el) {
      el.textContent = model.name.replace(/-/g, " ");
      el.classList.add("on");
      clearTimeout(el._t);
      el._t = setTimeout(() => el.classList.remove("on"), 1800);
    }
  }

  document.getElementById("credit").innerHTML = meta.attribution.join("<br>");

  const input = makeInput(renderer.domElement);

  const goTo = (wx, wz) => {
    const hit = network.snap(wx, wz);
    if (!hit) return;
    car.respawn(hit);
    camState.pos.set(0, 0, 0);          // force the chase cam to re-seat
    camState.look.set(hit.x, hit.y, hit.z);
    mapView.close();
    if (hit.name) {
      hudStreet.textContent = hit.name;
      hudStreet.classList.add("on");
      lastStreet = hit.name;
    }
  };

  mapView.small.addEventListener("click", () => mapView.toggle(carState()));
  mapView.full.addEventListener("mousemove", (e) => {
    const r = mapView.full.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const w = mapView.fullToWorld(px, py);
    mapView.hover = { px, py, snap: network.snap(w.x, w.z) };
    mapView.drawFull(carState());
  });
  mapView.full.addEventListener("mouseleave", () => {
    mapView.hover = null;
    if (mapView.open) mapView.drawFull(carState());
  });
  mapView.full.addEventListener("click", (e) => {
    const r = mapView.full.getBoundingClientRect();
    const w = mapView.fullToWorld(e.clientX - r.left, e.clientY - r.top);
    goTo(w.x, w.z);
  });
  mapView.overlay.addEventListener("click", (e) => {
    if (e.target === mapView.overlay) mapView.close();
  });

  function carState() {
    const t = car.body.translation();
    return { x: t.x, z: t.z, heading: carHeading(car) };
  }
  const hudSpeed = document.getElementById("speed");
  const hudStreet = document.getElementById("street");
  let lastStreet = "";

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ------------------------------------------------------------------- loop
  const camState = { pos: new THREE.Vector3(), look: new THREE.Vector3(), mode: 0 };
  const tmpQ = new THREE.Quaternion();
  const tmpV = new THREE.Vector3();
  let acc = 0;
  let last = performance.now();
  let streetTimer = 0;
  let mapTimer = 0;

  function frame(now) {
    schedule(frame);
    const wall = Math.min((now - last) / 1000, 0.1);
    last = now;

    // Fixed-step physics. A variable step makes the vehicle controller's
    // suspension behave differently on every machine.
    acc += wall;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 5) {
      car.update(FIXED_DT, input.state());
      world.timestep = FIXED_DT;
      world.step();
      acc -= FIXED_DT;
      steps++;
    }
    if (input.consumeRespawn()) car.respawn(nearestRoadSpawn(car, meta));
    if (input.consumeCamera()) camState.mode = (camState.mode + 1) % 4;
    if (input.consumeMap()) mapView.toggle(carState());
    if (input.consumeCarSwap()) setCarModel(carIndex + 1);
    if (input.consumeEscape()) mapView.close();

    const t = car.body.translation();
    const r = car.body.rotation();
    carGroup.position.set(t.x, t.y, t.z);
    carGroup.quaternion.set(r.x, r.y, r.z, r.w);
    for (let i = 0; i < 4; i++) {
      const w = car.wheelTransform(i);
      if (!w) continue;
      const m = carGroup.userData.wheels[i];
      m.position.set(w.x, w.y, w.z);
      m.quaternion.setFromEuler(new THREE.Euler(0, w.steering, 0));
      m.rotateX(-w.rotation);
    }

    // Fell through the world, or launched off a bridge into the void.
    if (t.y < -40) car.respawn(nearestRoadSpawn(car, meta));

    updateCamera(camera, camState, carGroup, car, wall, input);
    sun.position.set(t.x + SUN.x * 300, t.y + SUN.y * 300, t.z + SUN.z * 300);
    sun.target.position.set(t.x, t.y, t.z);
    roads.mesh.material.uniforms.uSun.value.copy(SUN);

    const kmh = Math.abs(car.speed) * 3.6;
    hudSpeed.firstChild.textContent = String(Math.round(kmh));

    streetTimer -= wall;
    if (streetTimer <= 0) {
      streetTimer = 0.25;
      const name = network.nearestName(t.x, t.z, 26);
      if (name && name !== lastStreet) {
        lastStreet = name;
        hudStreet.textContent = name;
        hudStreet.classList.add("on");
      } else if (!name) {
        hudStreet.classList.remove("on");
        lastStreet = "";
      }
    }

    // The minimap is a canvas blit, cheap but not free, and it carries no
    // information that changes meaningfully within a single frame.
    mapTimer -= wall;
    if (mapTimer <= 0) {
      mapTimer = 1 / 20;
      mapView.drawMinimap(t.x, t.z, carHeading(car));
      if (mapView.open) mapView.drawFull(carState());
    }

    renderer.render(scene, camera);
    void tmpQ; void tmpV;
  }

  await step("ready", 100);
  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 600);
  schedule(frame);

  Object.assign(window, { scene, car, world, meta, terrain, THREE, sampleTerrain,
                          network, mapView, goTo });
}

// ------------------------------------------------------------------------ car

/** Yaw of the chassis, matching the build-time convention (forward = local +Z). */
function carHeading(car) {
  const q = car.body.rotation();
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

function spawnFromUrl(meta, network) {
  const at = new URLSearchParams(location.search).get("at");
  if (!at) return null;
  const [a, b] = at.split(",").map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  // Latitude first, the order every maps app copies to the clipboard.
  const p = Math.PI * meta.origin.lat / 180;
  const mLat = 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p);
  const mLon = 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p);
  const x = (b - meta.origin.lon) * mLon;
  const z = -(a - meta.origin.lat) * mLat;
  const half = meta.extent_m / 2;
  if (Math.abs(x) > half || Math.abs(z) > half) {
    console.warn(`?at=${at} is outside the built area, using the default spawn`);
    return null;
  }
  return network.snap(x, z);
}

function nearestRoadSpawn(car, meta) {
  const t = car.body.translation();
  const half = meta.extent_m / 2;
  // Off the edge of the built area there is no ground to land on, so putting
  // the car back at its own x/z drops it into the void again on the next
  // frame and the respawn fires forever. Only keep the position if it is
  // actually inside the world.
  if (Math.abs(t.x) > half - 20 || Math.abs(t.z) > half - 20 || !Number.isFinite(t.y)) {
    return meta.spawn;
  }
  // Otherwise leave the player where they are, just upright and stopped.
  return { x: t.x, y: Math.max(t.y, meta.terrain.max) + 1.0, z: t.z, heading: 0 };
}

// --------------------------------------------------------------------- camera

function updateCamera(camera, state, carGroup, car, dt, input) {
  const speed = Math.abs(car.speed);
  const back = [8.2, 5.4, 0, 0][state.mode];
  const up = [3.1, 2.2, 0, 0][state.mode];

  if (state.mode === 3) {
    // Overhead. Orients you instantly and shows how much of the map is real.
    camera.position.set(carGroup.position.x, carGroup.position.y + 320,
                        carGroup.position.z + 130);
    camera.lookAt(carGroup.position);
    camera.fov = 55;
    camera.updateProjectionMatrix();
    return;
  }

  if (state.mode === 2) {
    // Bumper cam.
    const off = new THREE.Vector3(0, 0.55, 1.6).applyQuaternion(carGroup.quaternion);
    camera.position.copy(carGroup.position).add(off);
    const fwd = new THREE.Vector3(0, 0.35, 12).applyQuaternion(carGroup.quaternion);
    camera.lookAt(carGroup.position.clone().add(fwd));
    camera.fov = 74;
    camera.updateProjectionMatrix();
    return;
  }

  // Pull the camera back and lower the FOV lift as speed rises. Cheap, and it
  // does most of the work of making 90 km/h feel different from 30.
  const dist = back + Math.min(speed * 0.16, 3.2);
  const desired = new THREE.Vector3(0, up, -dist).applyQuaternion(carGroup.quaternion)
    .add(carGroup.position);

  if (input.freeLook) {
    const a = input.lookAngle;
    desired.copy(new THREE.Vector3(
      Math.sin(a) * dist, up, Math.cos(a) * dist,
    ).applyQuaternion(carGroup.quaternion).add(carGroup.position));
  }

  // Seat the camera before smoothing, not after. Checking afterwards means the
  // test never fires (the lerp has already moved it off zero), so a teleport
  // across the map leaves the camera crawling in from the old position.
  if (state.pos.lengthSq() === 0) state.pos.copy(desired);
  const k = 1 - Math.exp(-dt * 7.5);
  state.pos.lerp(desired, k);
  camera.position.copy(state.pos);

  const lookTarget = carGroup.position.clone().add(
    new THREE.Vector3(0, 1.0, 0),
  );
  if (state.look.lengthSq() === 0) state.look.copy(lookTarget);
  state.look.lerp(lookTarget, 1 - Math.exp(-dt * 10));
  camera.lookAt(state.look);

  const targetFov = 62 + Math.min(speed * 0.42, 14);
  camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt * 3));
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------- input

function makeInput(canvas) {
  const keys = new Set();
  let respawn = false;
  let cam = false;
  let map = false;
  let escape = false;
  let carSwap = false;
  const api = { freeLook: false, lookAngle: 0 };

  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === "r") respawn = true;
    if (k === "c") cam = true;
    if (k === "f") api.freeLook = !api.freeLook;
    if (k === "m") map = true;
    if (k === "v") carSwap = true;
    if (k === "escape") escape = true;
    if ([" ", "w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      e.preventDefault();
    }
  });
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => keys.clear());
  canvas.addEventListener("mousemove", (e) => {
    if (api.freeLook) api.lookAngle += e.movementX * 0.004;
  });

  api.state = () => {
    const on = (...k) => k.some((x) => keys.has(x));
    return {
      throttle: on("w", "arrowup") ? 1 : 0,
      brake: on("s", "arrowdown") ? 1 : 0,
      steer: (on("a", "arrowleft") ? 1 : 0) - (on("d", "arrowright") ? 1 : 0),
      handbrake: on(" "),
      boost: on("shift"),
    };
  };
  api.consumeRespawn = () => { const v = respawn; respawn = false; return v; };
  api.consumeCamera = () => { const v = cam; cam = false; return v; };
  api.consumeMap = () => { const v = map; map = false; return v; };
  api.consumeCarSwap = () => { const v = carSwap; carSwap = false; return v; };
  api.consumeEscape = () => { const v = escape; escape = false; return v; };
  return api;
}
