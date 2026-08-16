/**
 * The road network index and the two map views.
 *
 * One data file drives three things: the street name in the HUD, the minimap
 * strokes, and snapping a chosen spawn point onto real asphalt. The centrelines
 * carry the same smoothed surface height the ribbons were built from, so a
 * spawn lands on the road rather than wherever the terrain happens to be.
 */

const WORLD = "./world";

// Stroke weight and brightness per class, so an arterial reads differently from
// a parking aisle at a glance. Index matches CLASS_ORDER in build_world.py.
//
// These are screen pixels, deliberately independent of zoom. Baking the strokes
// into the source image instead means they shrink with it, and at whole-map
// scale a 2 px line becomes a quarter of a pixel and disappears.
const CLASS_STYLE = [
  { w: 0.6, a: 0.34 },  // service
  { w: 0.8, a: 0.42 },  // living_street
  { w: 0.9, a: 0.46 },  // unclassified
  { w: 1.0, a: 0.56 },  // residential
  { w: 1.2, a: 0.62 },  // tertiary_link
  { w: 1.4, a: 0.70 },  // tertiary
  { w: 1.5, a: 0.74 },  // secondary_link
  { w: 1.8, a: 0.80 },  // secondary
  { w: 1.8, a: 0.84 },  // primary_link
  { w: 2.2, a: 0.92 },  // primary
  { w: 2.0, a: 0.92 },  // trunk_link
  { w: 2.5, a: 0.97 },  // trunk
  { w: 2.2, a: 0.95 },  // motorway_link
  { w: 2.8, a: 1.00 },  // motorway
];

/** Stroke a set of ways through `project`, dark casing under a light line. */
function strokeWays(ctx, ways, project, boost = 1) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const pass of [0, 1]) {
    for (const way of ways) {
      const st = CLASS_STYLE[way.c] || CLASS_STYLE[3];
      if (pass === 0 && st.w < 1.0) continue;   // no casing for parking aisles
      ctx.beginPath();
      for (let i = 0; i < way.p.length; i++) {
        const [px, py] = project(way.p[i][0], way.p[i][2]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      if (pass === 0) {
        ctx.strokeStyle = `rgba(6,10,14,${st.a * 0.8})`;
        ctx.lineWidth = st.w * boost + 1.7;
      } else {
        ctx.strokeStyle = `rgba(236,244,220,${st.a})`;
        ctx.lineWidth = st.w * boost;
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

export class RoadNetwork {
  constructor(ways, extent, cell = 150) {
    this.ways = ways;
    this.extent = extent;
    this.half = extent / 2;
    this.cell = cell;
    this.buckets = new Map();
    for (const way of ways) {
      for (let i = 0; i < way.p.length - 1; i++) {
        const a = way.p[i], b = way.p[i + 1];
        const seg = { a, b, n: way.n, c: way.c };
        const kx0 = Math.floor(Math.min(a[0], b[0]) / cell);
        const kx1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const kz0 = Math.floor(Math.min(a[2], b[2]) / cell);
        const kz1 = Math.floor(Math.max(a[2], b[2]) / cell);
        for (let kx = kx0; kx <= kx1; kx++) {
          for (let kz = kz0; kz <= kz1; kz++) {
            const key = `${kx},${kz}`;
            let list = this.buckets.get(key);
            if (!list) this.buckets.set(key, (list = []));
            list.push(seg);
          }
        }
      }
    }
  }

  static async load(meta) {
    const r = await fetch(`${WORLD}/network.json`);
    if (!r.ok) throw new Error(`network.json ${r.status}`);
    return new RoadNetwork(await r.json(), meta.extent_m);
  }

  /** Walk the 3x3 bucket neighbourhood, widening if nothing is close. */
  *candidates(x, z, rings = 1) {
    const kx = Math.floor(x / this.cell), kz = Math.floor(z / this.cell);
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dz = -rings; dz <= rings; dz++) {
        const list = this.buckets.get(`${kx + dx},${kz + dz}`);
        if (list) yield* list;
      }
    }
  }

  /** Nearest named road, for the HUD. Returns a string or null. */
  nearestName(x, z, maxDist = 26) {
    let best = null, bestD = maxDist * maxDist;
    for (const s of this.candidates(x, z)) {
      if (!s.n) continue;
      const d = segDist2(x, z, s.a, s.b);
      if (d < bestD) { bestD = d; best = s.n; }
    }
    return best;
  }

  /**
   * Closest point on any road, with a heading along it and the true surface
   * height. Widens the search until it finds something, so a click in the
   * middle of the woods still puts you somewhere sensible.
   */
  snap(x, z) {
    let best = null, bestD = Infinity;
    for (let rings = 1; rings <= 12 && !best; rings += 2) {
      bestD = Infinity;
      for (const s of this.candidates(x, z, rings)) {
        const d = segDist2(x, z, s.a, s.b);
        if (d < bestD) { bestD = d; best = s; }
      }
    }
    if (!best) return null;
    const { a, b } = best;
    const vx = b[0] - a[0], vz = b[2] - a[2];
    const len2 = vx * vx + vz * vz;
    let t = len2 > 1e-9 ? ((x - a[0]) * vx + (z - a[2]) * vz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return {
      x: a[0] + vx * t,
      y: a[1] + (b[1] - a[1]) * t,
      z: a[2] + vz * t,
      // Vehicle forward is local +Z, so world forward is (sin h, 0, cos h).
      heading: Math.atan2(vx, vz),
      name: best.n || null,
      dist: Math.sqrt(bestD),
    };
  }
}

function segDist2(px, pz, a, b) {
  const vx = b[0] - a[0], vz = b[2] - a[2];
  const wx = px - a[0], wz = pz - a[2];
  const len2 = vx * vx + vz * vz;
  let t = len2 > 1e-9 ? (wx * vx + wz * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dz = wz - vz * t;
  return dx * dx + dz * dz;
}

// ------------------------------------------------------------------ map views

export class MapView {
  constructor(meta, network, base) {
    this.meta = meta;
    this.network = network;
    this.base = base;                 // offscreen canvas, whole box
    this.px = base.width;             // base pixels across
    this.extent = meta.extent_m;
    this.half = this.extent / 2;
    this.mPerPx = this.extent / this.px;
    this.viewM = 700;                 // metres across the corner minimap
    this.open = false;

    this.small = document.getElementById("minimap");
    this.smallCtx = this.small.getContext("2d");
    this.full = document.getElementById("fullmap");
    this.fullCtx = this.full.getContext("2d");
    this.overlay = document.getElementById("mapoverlay");
    this.hover = null;
  }

  static async load(meta, network) {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("overview.jpg failed to load"));
      i.src = `${WORLD}/overview.jpg`;
    });
    const base = document.createElement("canvas");
    base.width = img.width;
    base.height = img.height;
    base.getContext("2d").drawImage(img, 0, 0);

    // Bounding box per way so the minimap can skip everything off screen
    // instead of stroking all two thousand of them twenty times a second.
    for (const way of network.ways) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const pt of way.p) {
        if (pt[0] < x0) x0 = pt[0];
        if (pt[0] > x1) x1 = pt[0];
        if (pt[2] < z0) z0 = pt[2];
        if (pt[2] > z1) z1 = pt[2];
      }
      way.bb = [x0, z0, x1, z1];
    }
    return new MapView(meta, network, base);
  }

  worldToBase(x, z) {
    return [(x + this.half) / this.mPerPx, (z + this.half) / this.mPerPx];
  }

  // ------------------------------------------------------------ minimap

  drawMinimap(x, z, heading) {
    const c = this.small, ctx = this.smallCtx;
    const size = c.width;
    const srcSpan = this.viewM / this.mPerPx;
    const [bx, by] = this.worldToBase(x, z);

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 6);
    ctx.clip();
    ctx.fillStyle = "#0b0f12";
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.base, bx - srcSpan / 2, by - srcSpan / 2, srcSpan, srcSpan,
                  0, 0, size, size);

    const v = this.viewM;
    const project = (wx, wz) => [
      ((wx - x) / v + 0.5) * size,
      ((wz - z) / v + 0.5) * size,
    ];
    const visible = this.network.ways.filter((w) =>
      w.bb[0] <= x + v / 2 && w.bb[2] >= x - v / 2 &&
      w.bb[1] <= z + v / 2 && w.bb[3] >= z - v / 2);
    strokeWays(ctx, visible, project, 1.15);

    drawCar(ctx, size / 2, size / 2, heading, 7);
    ctx.restore();

    // north tick, so a north-up map is obviously north-up
    ctx.save();
    ctx.fillStyle = "rgba(232,240,214,0.75)";
    ctx.font = "600 9px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText("N", size / 2, 11);
    ctx.restore();
  }

  // --------------------------------------------------------- full map

  toggle(carPos) {
    this.open = !this.open;
    this.overlay.classList.toggle("on", this.open);
    if (this.open) this.drawFull(carPos);
  }

  close() {
    this.open = false;
    this.overlay.classList.remove("on");
  }

  fitFull() {
    const s = Math.round(Math.min(innerWidth * 0.92, innerHeight * 0.82));
    if (this.full.width !== s) { this.full.width = s; this.full.height = s; }
    return s;
  }

  drawFull(carPos) {
    const s = this.fitFull();
    const ctx = this.fullCtx;
    ctx.clearRect(0, 0, s, s);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.base, 0, 0, this.px, this.px, 0, 0, s, s);
    // Knock the photo back a little so the network reads on top of it.
    ctx.fillStyle = "rgba(6,10,14,0.28)";
    ctx.fillRect(0, 0, s, s);
    strokeWays(ctx, this.network.ways, (wx, wz) => [
      ((wx + this.half) / this.extent) * s,
      ((wz + this.half) / this.extent) * s,
    ]);

    if (carPos) {
      const [bx, by] = this.worldToBase(carPos.x, carPos.z);
      drawCar(ctx, (bx / this.px) * s, (by / this.px) * s, carPos.heading, 9);
    }
    if (this.hover) {
      const { px, py, snap } = this.hover;
      ctx.save();
      ctx.strokeStyle = "rgba(168,204,85,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px - 14, py); ctx.lineTo(px + 14, py);
      ctx.moveTo(px, py - 14); ctx.lineTo(px, py + 14);
      ctx.stroke();
      if (snap) {
        const [sx, sy] = this.worldToBase(snap.x, snap.z);
        const cx = (sx / this.px) * s, cy = (sy / this.px) * s;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(168,204,85,0.95)";
        ctx.fill();
        if (snap.name) {
          ctx.font = "600 12px ui-monospace, Menlo, monospace";
          ctx.textAlign = "left";
          const label = snap.name;
          const w = ctx.measureText(label).width;
          const lx = Math.min(cx + 10, s - w - 12);
          ctx.fillStyle = "rgba(8,12,16,0.82)";
          ctx.fillRect(lx - 5, cy - 20, w + 10, 17);
          ctx.fillStyle = "#cfe3a8";
          ctx.fillText(label, lx, cy - 8);
        }
      }
      ctx.restore();
    }
  }

  /** Canvas pixel -> world metres, for the full map. */
  fullToWorld(px, py) {
    const s = this.full.width;
    return {
      x: (px / s) * this.extent - this.half,
      z: (py / s) * this.extent - this.half,
    };
  }
}

function drawCar(ctx, cx, cy, heading, r) {
  ctx.save();
  ctx.translate(cx, cy);
  // The arrow is drawn pointing up; world forward is (sin h, cos h) with +Z
  // down the map, so rotating by (PI - heading) aims it correctly.
  ctx.rotate(Math.PI - heading);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.72, r * 0.8);
  ctx.lineTo(0, r * 0.38);
  ctx.lineTo(-r * 0.72, r * 0.8);
  ctx.closePath();
  ctx.fillStyle = "#a8cc55";
  ctx.strokeStyle = "rgba(10,14,18,0.9)";
  ctx.lineWidth = 1.4;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
