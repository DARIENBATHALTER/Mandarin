/**
 * Rapier world, terrain colliders, and the car.
 *
 * The car drives on the road trimesh, not on the terrain heightfield. That is
 * the whole point of smoothing the road profile at build time: if collision
 * came from the raw DEM the ride would be a washboard no matter how good the
 * road looked.
 */
import RAPIER from "rapier";

export const TUNE = {
  mass: 1250,
  chassis: { hx: 0.86, hy: 0.46, hz: 2.05 },
  wheel: { radius: 0.35, restLength: 0.34, restSag: 0.14, x: 0.78, y: -0.22, front: 1.42, rear: -1.36 },
  suspension: { stiffness: 20, compression: 0.88, relaxation: 0.92, maxForce: 20000, maxTravel: 0.30 },
  grip: { frictionSlip: 2.2, sideStiffness: 0.72 },
  engineForce: 2900,      // per driven wheel, newtons
  reverseForce: 1500,
  brakeForce: 42,
  handbrakeForce: 90,
  maxSteer: 0.55,         // radians at a standstill
  steerSpeedFalloff: 24,  // m/s at which steering is halved
  steerRate: 3.4,
  boost: 1.7,
};

export async function initPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.numSolverIterations = 6;
  return world;
}

/**
 * One heightfield collider per terrain chunk.
 *
 * Rapier stores the height matrix column-major with rows running along local Z
 * and columns along local X, so the build-time grid (which is row-major with
 * rows running north to south) has to be transposed on the way in. This is easy
 * to get backwards and the failure mode is a subtly mirrored world, so
 * verifyTerrain() below checks it against the CPU grid rather than trusting it.
 */
export function addTerrain(world, terrain) {
  const { heightChunks, grid, chunks, chunk_m, half } = terrain;
  const n = grid - 1;
  const colliders = [];
  for (let cz = 0; cz < chunks; cz++) {
    for (let cx = 0; cx < chunks; cx++) {
      const src = heightChunks[cz * chunks + cx];
      const heights = new Float32Array(grid * grid);
      for (let jz = 0; jz < grid; jz++) {
        for (let ix = 0; ix < grid; ix++) {
          heights[jz + ix * grid] = src[jz * grid + ix];
        }
      }
      const desc = RAPIER.ColliderDesc.heightfield(
        n, n, heights, { x: chunk_m, y: 1, z: chunk_m },
      )
        .setTranslation(-half + cx * chunk_m + chunk_m / 2, 0, -half + cz * chunk_m + chunk_m / 2)
        .setFriction(0.85);
      colliders.push(world.createCollider(desc));
    }
  }
  return colliders;
}

/** Sample the CPU height grid the same way the mesh does. */
export function sampleTerrain(terrain, x, z) {
  const { heightChunks, grid, chunks, chunk_m, half } = terrain;
  const cx = Math.min(chunks - 1, Math.max(0, Math.floor((x + half) / chunk_m)));
  const cz = Math.min(chunks - 1, Math.max(0, Math.floor((z + half) / chunk_m)));
  const h = heightChunks[cz * chunks + cx];
  const lx = (x + half - cx * chunk_m) / chunk_m * (grid - 1);
  const lz = (z + half - cz * chunk_m) / chunk_m * (grid - 1);
  const i0 = Math.min(grid - 2, Math.max(0, Math.floor(lx)));
  const j0 = Math.min(grid - 2, Math.max(0, Math.floor(lz)));
  const tx = lx - i0, tz = lz - j0;
  return h[j0 * grid + i0] * (1 - tx) * (1 - tz) + h[j0 * grid + i0 + 1] * tx * (1 - tz)
       + h[(j0 + 1) * grid + i0] * (1 - tx) * tz + h[(j0 + 1) * grid + i0 + 1] * tx * tz;
}

/**
 * Raycast down onto the physics terrain at a spread of points and compare with
 * the CPU grid. A transposed or mirrored heightfield still produces a plausible
 * looking surface, so only a numeric check catches it.
 */
export function verifyTerrain(world, terrain, samples = 24) {
  const half = terrain.half;
  let worst = 0;
  let checked = 0;
  for (let i = 0; i < samples; i++) {
    const x = (Math.random() * 2 - 1) * half * 0.9;
    const z = (Math.random() * 2 - 1) * half * 0.9;
    const expected = sampleTerrain(terrain, x, z);
    const ray = new RAPIER.Ray({ x, y: expected + 60, z }, { x: 0, y: -1, z: 0 });
    const hit = world.castRay(ray, 200, true);
    if (!hit) continue;
    const got = expected + 60 - hit.timeOfImpact;
    worst = Math.max(worst, Math.abs(got - expected));
    checked++;
  }
  return { worst, checked };
}

export function addRoads(world, positions, index) {
  const desc = RAPIER.ColliderDesc.trimesh(positions, index).setFriction(1.0);
  return world.createCollider(desc);
}

// ------------------------------------------------------------------------- car

export class Car {
  constructor(world, spawn) {
    this.world = world;
    this.spawn = spawn;
    this.steer = 0;
    this.build();
  }

  build() {
    const t = TUNE;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(this.spawn.x, this.spawn.y + 0.55, this.spawn.z)
        .setRotation(yawQuat(this.spawn.heading))
        .setLinearDamping(0.06)
        .setAngularDamping(0.7)
        .setCanSleep(false),
    );
    // Mass comes from density on the box, not from setAdditionalMass. The
    // latter adds mass without any rotational inertia, and a body with zero
    // inverse inertia cannot rotate at all: the car will not pitch, will not
    // yaw, and the vehicle controller's drive impulses go nowhere.
    const volume = 8 * t.chassis.hx * t.chassis.hy * t.chassis.hz;
    const col = RAPIER.ColliderDesc.cuboid(t.chassis.hx, t.chassis.hy, t.chassis.hz)
      // Centre of mass low in the hull, or it rolls over in the first corner.
      .setTranslation(0, -0.12, 0)
      .setDensity(t.mass / volume)
      .setFriction(0.35);
    this.world.createCollider(col, body);
    this.body = body;

    const v = this.world.createVehicleController(body);
    v.indexUpAxis = 1;
    v.setIndexForwardAxis = 2;
    const w = t.wheel;
    const positions = [
      { x: -w.x, z: w.front }, { x: w.x, z: w.front },
      { x: -w.x, z: w.rear }, { x: w.x, z: w.rear },
    ];
    for (const p of positions) {
      v.addWheel(
        { x: p.x, y: w.y, z: p.z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        w.restLength, w.radius,
      );
    }
    for (let i = 0; i < 4; i++) {
      v.setWheelSuspensionStiffness(i, t.suspension.stiffness);
      v.setWheelSuspensionCompression(i, t.suspension.compression);
      v.setWheelSuspensionRelaxation(i, t.suspension.relaxation);
      v.setWheelMaxSuspensionForce(i, t.suspension.maxForce);
      v.setWheelMaxSuspensionTravel(i, t.suspension.maxTravel);
      v.setWheelFrictionSlip(i, t.grip.frictionSlip);
      v.setWheelSideFrictionStiffness(i, t.grip.sideStiffness);
    }
    this.controller = v;
  }

  respawn(at) {
    const s = at || this.spawn;
    this.body.setTranslation({ x: s.x, y: s.y + 0.55, z: s.z }, true);
    this.body.setRotation(yawQuat(s.heading ?? 0), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
  }

  /**
   * Suspension compression with the car parked, measured rather than assumed.
   *
   * The bodywork is positioned from this so the model's ground plane meets the
   * road. Hardcoding it means the car sits on stilts or buried to the sills the
   * moment anyone retunes the springs, which is exactly what happened.
   */
  measureRestSag(steps = 90) {
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: true, boost: false };
    for (let i = 0; i < steps; i++) {
      this.update(1 / 60, idle);
      this.world.timestep = 1 / 60;
      this.world.step();
    }
    let total = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      const l = this.controller.wheelSuspensionLength(i);
      if (l != null && Number.isFinite(l)) { total += l; n++; }
    }
    return n ? total / n : TUNE.wheel.restSag;
  }

  /**
   * Signed forward speed in m/s.
   *
   * Rapier's currentVehicleSpeed() is the magnitude of the chassis velocity,
   * so a car sitting still while its suspension settles reports several m/s and
   * the speedo reads a dozen km/h at a standstill. Project onto the actual
   * heading instead.
   */
  get speed() {
    const v = this.body.linvel();
    const q = this.body.rotation();
    // local +Z rotated into world space
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return v.x * fx + v.y * fy + v.z * fz;
  }

  update(dt, input) {
    const t = TUNE;
    const speed = Math.abs(this.speed);

    // Steering authority falls off with speed. Without this the car is
    // undriveable above about 60 km/h: full lock at highway speed just spins it.
    const limit = t.maxSteer / (1 + speed / t.steerSpeedFalloff);
    const target = input.steer * limit;
    const rate = t.steerRate * dt;
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));
    this.controller.setWheelSteering(0, this.steer);
    this.controller.setWheelSteering(1, this.steer);

    let engine = 0;
    let brake = 0;
    const forward = this.speed;
    if (input.throttle > 0) {
      if (forward < -0.6) brake = t.brakeForce;          // still rolling back, brake first
      else engine = t.engineForce * input.throttle * (input.boost ? t.boost : 1);
    } else if (input.brake > 0) {
      if (forward > 0.6) brake = t.brakeForce * input.brake;
      else engine = -t.reverseForce * input.brake;
    }
    if (input.handbrake) { brake = t.handbrakeForce; engine = 0; }

    // Hold the car still when nobody is asking it to move. Without this it
    // creeps off the camber of the road the moment you stop touching the keys,
    // which is exactly what you do not want on the first frame after a spawn.
    if (!input.throttle && !input.brake && speed < 0.7) {
      brake = Math.max(brake, t.handbrakeForce);
      engine = 0;
    }

    // Rear wheel drive, brakes on all four.
    this.controller.setWheelEngineForce(2, engine);
    this.controller.setWheelEngineForce(3, engine);
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelBrake(i, i >= 2 ? brake : brake * 0.7);
    }
    this.controller.updateVehicle(dt);
  }

  /**
   * Wheel placement in chassis space, so the meshes can hang off the car group
   * and inherit its transform. Note that wheelHardPoint is world-space while
   * wheelDirectionCs is chassis-space; combining those two directly is wrong,
   * which is why this uses the connection point instead.
   */
  wheelTransform(i) {
    const c = this.controller;
    const conn = c.wheelChassisConnectionPointCs(i);
    const dir = c.wheelDirectionCs(i);
    const len = c.wheelSuspensionLength(i) ?? TUNE.wheel.restLength;
    if (!conn || !dir) return null;
    return {
      x: conn.x + dir.x * len,
      y: conn.y + dir.y * len,
      z: conn.z + dir.z * len,
      rotation: c.wheelRotation(i) ?? 0,
      steering: c.wheelSteering(i) ?? 0,
      contact: c.wheelIsInContact(i),
    };
  }
}

function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
