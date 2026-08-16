"""Turn the raw downloads into meshes the browser can drive on.

Output lands in web/world/ as flat binary attribute blobs plus a meta.json
index. Everything is in the local ENU frame, metres, +X east, -Z north, +Y up.

The three things that decide whether this feels like a road instead of a
decal:
  1. Road elevation is low-passed along each centreline. Raw per-vertex DEM
     sampling gives you metre-scale noise and the car rattles over it.
  2. Ribbons are mitred at the joints, so a corner keeps its width instead of
     pinching.
  3. Road classes are lifted in a fixed order and junctions get a filler disc,
     which is what stops coplanar overlaps from z-fighting at every crossing.
"""
import json
import math
import os
import struct
import sys

import numpy as np

from geo import DATA, WORLD, Frame, ensure_dirs, load_config

# Wider, faster roads sit on top. A fixed 1 cm ladder per class means two
# overlapping ribbons never share a plane, which is cheaper and more stable
# than fighting it with polygonOffset at render time.
CLASS_ORDER = [
    "service", "living_street", "unclassified", "residential", "tertiary_link",
    "tertiary", "secondary_link", "secondary", "primary_link", "primary",
    "trunk_link", "trunk", "motorway_link", "motorway",
]


# ------------------------------------------------------------------ DEM sampler

class Height:
    def __init__(self, cfg, frame):
        self.dem = np.load(os.path.join(DATA, "dem.npy")).astype(np.float32)
        self.n = self.dem.shape[0]
        self.half = cfg["extent_m"] / 2.0
        self.extent = float(cfg["extent_m"])

    def sample(self, x, z):
        """Bilinear height at ENU (x, z). Accepts scalars or arrays."""
        fx = (np.asarray(x, dtype=np.float64) + self.half) / self.extent * (self.n - 1)
        fz = (np.asarray(z, dtype=np.float64) + self.half) / self.extent * (self.n - 1)
        fx = np.clip(fx, 0, self.n - 1.001)
        fz = np.clip(fz, 0, self.n - 1.001)
        x0 = fx.astype(np.int32); z0 = fz.astype(np.int32)
        tx = fx - x0; tz = fz - z0
        d = self.dem
        h = (d[z0, x0] * (1 - tx) * (1 - tz) + d[z0, x0 + 1] * tx * (1 - tz) +
             d[z0 + 1, x0] * (1 - tx) * tz + d[z0 + 1, x0 + 1] * tx * tz)
        return h


# ------------------------------------------------------------------- geometry

def ear_clip(poly):
    """Triangulate a simple polygon given as an (n,2) array of XZ points.

    Ear clipping is O(n^2), which is irrelevant here: OSM footprints average a
    dozen vertices. Returns a flat list of index triples into `poly`.
    """
    n = len(poly)
    if n < 3:
        return []
    idx = list(range(n))
    if _signed_area(poly) < 0:
        idx.reverse()
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 4 * n:
        guard += 1
        clipped = False
        for k in range(len(idx)):
            i0 = idx[(k - 1) % len(idx)]
            i1 = idx[k]
            i2 = idx[(k + 1) % len(idx)]
            a, b, c = poly[i0], poly[i1], poly[i2]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            if cross <= 0:
                continue  # reflex vertex, not an ear
            if any(_in_tri(poly[j], a, b, c) for j in idx if j not in (i0, i1, i2)):
                continue
            tris.append((i0, i1, i2))
            idx.pop(k)
            clipped = True
            break
        if not clipped:
            break  # degenerate ring, take what we have
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def _signed_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def _in_tri(p, a, b, c):
    d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1])
    d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1])
    d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def resample(points, step):
    """Walk a polyline emitting a point every `step` metres. Keeps both ends."""
    out = [points[0]]
    carry = 0.0
    for i in range(len(points) - 1):
        a = np.asarray(points[i], dtype=np.float64)
        b = np.asarray(points[i + 1], dtype=np.float64)
        seg = float(np.linalg.norm(b - a))
        if seg < 1e-9:
            continue
        d = (b - a) / seg
        t = step - carry
        while t <= seg:
            out.append(tuple(a + d * t))
            t += step
        carry = (carry + seg) % step
    if np.linalg.norm(np.array(out[-1]) - np.array(points[-1])) > 0.5:
        out.append(tuple(points[-1]))
    return out


def smooth_profile(h, window_pts):
    """Moving average with edge clamping.

    Roads are engineered surfaces; terrain is not. Sampling the DEM per vertex
    and using it raw gives a washboard. This is the single most important line
    in the file for how the car feels.
    """
    if window_pts < 3 or len(h) < 3:
        return h
    w = min(window_pts | 1, len(h) if len(h) % 2 else len(h) - 1)
    if w < 3:
        return h
    pad = w // 2
    padded = np.concatenate([np.full(pad, h[0]), h, np.full(pad, h[-1])])
    kern = np.ones(w) / w
    return np.convolve(padded, kern, mode="valid")


# ----------------------------------------------------------------------- roads

class RoadBuilder:
    def __init__(self, cfg, frame, hf):
        self.cfg = cfg
        self.frame = frame
        self.hf = hf
        r = cfg["roads"]
        self.step = r["resample_m"]
        self.widths = r["widths"]
        self.lane_m = r["default_lane_m"]
        self.smooth_m = r["smooth_window_m"]
        self.lift = r["lift_m"]
        self.pos, self.uv, self.info, self.idx = [], [], [], []
        self.centrelines = []
        self.junction_hits = {}
        self.stats = {"ways": 0, "bridges": 0, "tunnels": 0, "discs": 0}

    def width_for(self, tags):
        hw = tags.get("highway", "residential")
        base = self.widths.get(hw, 6.0)
        lanes = tags.get("lanes")
        lanes_known = False
        if lanes:
            try:
                n = float(str(lanes).split(";")[0])
                if n > 0:
                    base = max(base, n * self.lane_m)
                    lanes_known = True
            except ValueError:
                pass
        # A one-way way is usually one carriageway of a divided road, so the
        # class default (which describes the whole road) is too wide. But when
        # OSM gives an explicit lane count that count already refers to this
        # carriageway alone, and narrowing it again shrinks six-lane arterials
        # like San Jose Blvd down to the width of a side street.
        if not lanes_known and tags.get("oneway") == "yes" and hw in (
                "motorway", "trunk", "primary", "secondary"):
            base *= 0.62
        return base

    def class_lift(self, tags):
        hw = tags.get("highway", "residential")
        rank = CLASS_ORDER.index(hw) if hw in CLASS_ORDER else 0
        return self.lift + rank * 0.01

    def add_way(self, pts_xz, tags):
        if len(pts_xz) < 2:
            return
        pts = resample(pts_xz, self.step)
        if len(pts) < 2:
            return
        p = np.asarray(pts, dtype=np.float64)
        half_w = self.width_for(tags) * 0.5
        lift = self.class_lift(tags)

        h = np.asarray(self.hf.sample(p[:, 0], p[:, 1]), dtype=np.float64)
        window_pts = max(3, int(self.smooth_m / self.step))
        h = smooth_profile(h, window_pts)

        is_bridge = bool(tags.get("bridge")) and tags.get("bridge") != "no"
        is_tunnel = bool(tags.get("tunnel")) and tags.get("tunnel") != "no"
        try:
            layer = int(str(tags.get("layer", "0")).split(";")[0])
        except ValueError:
            layer = 0

        if is_bridge:
            # A bridge deck is a straight profile between its abutments, not a
            # copy of whatever the ground does underneath it. Ramp end to end
            # and add clearance so it clears the water or the road below.
            self.stats["bridges"] += 1
            t = np.linspace(0.0, 1.0, len(h))
            h = h[0] * (1 - t) + h[-1] * t + 1.2 + 4.5 * max(1, layer)
        elif is_tunnel:
            self.stats["tunnels"] += 1
            h = h - 6.0 * max(1, abs(layer) if layer else 1)
        elif layer > 0:
            h = h + 4.5 * layer

        h = h + lift

        # Mitred offsets. Without the miter scale a corner pinches to a point,
        # which reads instantly as fake.
        d = np.zeros((len(p), 2))
        d[:-1] = p[1:] - p[:-1]
        d[-1] = d[-2] if len(p) > 1 else (1.0, 0.0)
        seg_len = np.linalg.norm(d, axis=1, keepdims=True)
        seg_len[seg_len < 1e-9] = 1.0
        d = d / seg_len
        d_in = np.vstack([d[0:1], d[:-1]])
        tan = d_in + d
        tl = np.linalg.norm(tan, axis=1, keepdims=True)
        tl[tl < 1e-9] = 1.0
        tan = tan / tl
        cos_half = np.sum(tan * d, axis=1)
        miter = 1.0 / np.clip(np.abs(cos_half), 0.34, 1.0)
        nrm = np.stack([tan[:, 1], -tan[:, 0]], axis=1)

        along = np.concatenate([[0.0], np.cumsum(np.linalg.norm(p[1:] - p[:-1], axis=1))])
        base = len(self.pos)
        lanes_f = max(2.0, round(half_w * 2 / self.lane_m))
        for i in range(len(p)):
            off = nrm[i] * half_w * miter[i]
            for side in (-1.0, 1.0):
                self.pos.append((p[i, 0] + off[0] * side, h[i], p[i, 1] + off[1] * side))
                self.uv.append((side * half_w, along[i]))
                self.info.append((half_w, lanes_f))
        # Vertices are emitted side = -1 first, which lands on the right of the
        # direction of travel, so the naive winding faces the triangles at the
        # ground. Roads then vanish from every camera above them and all you see
        # is the aerial photo of the real road underneath, which is convincing
        # enough to hide the bug for a long time.
        for i in range(len(p) - 1):
            a = base + i * 2
            self.idx += [a, a + 2, a + 1, a + 1, a + 2, a + 3]

        # Keep the centreline with its final surface height. Sampling the
        # terrain later would put a chosen spawn point under the road wherever
        # the smoothed profile sits above the ground.
        every = max(1, int(round(12.0 / self.step)))
        pts = [[round(float(p[k, 0]), 1), round(float(h[k]), 2), round(float(p[k, 1]), 1)]
               for k in range(0, len(p), every)]
        if len(p) - 1 not in range(0, len(p), every):
            pts.append([round(float(p[-1, 0]), 1), round(float(h[-1]), 2),
                        round(float(p[-1, 1]), 1)])
        if len(pts) >= 2:
            entry = {"c": CLASS_ORDER.index(tags.get("highway", "residential"))
                     if tags.get("highway") in CLASS_ORDER else 0, "p": pts}
            name = tags.get("name")
            if name:
                entry["n"] = name
            self.centrelines.append(entry)

        if not (is_bridge or is_tunnel or layer):
            key_a = (round(p[0, 0] * 2) / 2, round(p[0, 1] * 2) / 2)
            key_b = (round(p[-1, 0] * 2) / 2, round(p[-1, 1] * 2) / 2)
            for k in (key_a, key_b):
                prev = self.junction_hits.get(k)
                self.junction_hits[k] = (max(prev[0], half_w) if prev else half_w,
                                         (prev[1] if prev else 0) + 1,
                                         max(prev[2], lift) if prev else lift)
        self.stats["ways"] += 1

    def add_junction_discs(self):
        """Fill the notch where ribbons meet.

        Clipping every ribbon back to a true junction polygon is the textbook
        fix and a lot of code. A disc sized to the widest incoming road, laid
        at that road's height, covers the same seam and is invisible in motion.
        """
        for (x, z), (half_w, count, lift) in self.junction_hits.items():
            if count < 2:
                continue
            r = half_w * 1.05
            y = float(self.hf.sample(x, z)) + lift + 0.005
            c = len(self.pos)
            # lanes = 0 tells the shader "plain asphalt". Running the lane-line
            # code across a junction would paint stripes through the middle of
            # every intersection.
            self.pos.append((x, y, z)); self.uv.append((0.0, 0.0)); self.info.append((half_w, 0.0))
            seg = 12
            for k in range(seg):
                a = 2 * math.pi * k / seg
                px, pz = x + math.cos(a) * r, z + math.sin(a) * r
                self.pos.append((px, y, pz))
                self.uv.append((math.cos(a) * r, math.sin(a) * r))
                self.info.append((half_w, 0.0))
            for k in range(seg):
                self.idx += [c, c + 1 + (k + 1) % seg, c + 1 + k]  # face up
            self.stats["discs"] += 1


# ------------------------------------------------------------------- buildings

def build_buildings(elements, frame, hf, half):
    pos, nrm, info, idx = [], [], [], []
    seed = 0
    kept = 0
    for el in elements:
        tags = el.get("tags", {})
        if "building" not in tags or el.get("type") != "way":
            continue
        g = el.get("geometry") or []
        ring = []
        for pt in g:
            if pt is None:
                ring = []
                break
            ring.append(frame.to_xz(pt["lat"], pt["lon"]))
        if len(ring) < 4:
            continue
        if abs(ring[0][0] - ring[-1][0]) < 1e-6 and abs(ring[0][1] - ring[-1][1]) < 1e-6:
            ring = ring[:-1]
        if len(ring) < 3:
            continue
        poly = np.asarray(ring, dtype=np.float64)
        if poly[:, 0].min() > half or poly[:, 0].max() < -half:
            continue
        if poly[:, 1].min() > half or poly[:, 1].max() < -half:
            continue
        area = abs(_signed_area(poly))
        if area < 12.0:
            continue

        h = _building_height(tags, area)
        base = float(np.min(hf.sample(poly[:, 0], poly[:, 1]))) - 0.6
        top = base + h
        seed += 1
        s = (seed % 97) / 97.0

        if _signed_area(poly) < 0:
            poly = poly[::-1]

        n = len(poly)
        wall_base = len(pos)
        for i in range(n):
            a = poly[i]
            b = poly[(i + 1) % n]
            ex, ez = b[0] - a[0], b[1] - a[1]
            el_ = math.hypot(ex, ez) or 1.0
            nx, nz = ez / el_, -ex / el_
            v = len(pos)
            pos += [(a[0], base, a[1]), (b[0], base, b[1]),
                    (a[0], top, a[1]), (b[0], top, b[1])]
            nrm += [(nx, 0.0, nz)] * 4
            info += [(s, 0.0)] * 4
            # Wound so the front face points outward. A ring that is
            # counter-clockwise in maths orientation on the XZ plane reads as
            # clockwise when viewed from +Y, because Z runs the opposite way to
            # a textbook Y axis. Get this backwards and every surface is culled,
            # leaving you looking at the unlit inside of the building.
            idx += [v, v + 2, v + 1, v + 1, v + 2, v + 3]

        roof_base = len(pos)
        for pt in poly:
            pos.append((pt[0], top, pt[1]))
            nrm.append((0.0, 1.0, 0.0))
            info.append((s, 1.0))
        for tri in ear_clip(poly):
            idx += [roof_base + tri[0], roof_base + tri[2], roof_base + tri[1]]
        kept += 1
        _ = wall_base
    return pos, nrm, info, idx, kept


def _building_height(tags, area):
    if "height" in tags:
        try:
            return max(2.5, float(str(tags["height"]).replace("m", "").strip()))
        except ValueError:
            pass
    if "building:levels" in tags:
        try:
            return max(2.5, float(str(tags["building:levels"]).split(";")[0]) * 3.2)
        except ValueError:
            pass
    kind = tags.get("building", "yes")
    if kind in ("house", "detached", "residential", "bungalow"):
        return 5.2
    if kind in ("garage", "garages", "shed", "carport", "hut"):
        return 2.8
    if kind in ("apartments", "commercial", "retail", "school", "church", "industrial"):
        return 9.0
    # Mandarin is overwhelmingly single storey; scale gently with footprint so
    # the strip malls on San Jose read taller than the ranch houses.
    return 4.5 + min(5.0, area / 400.0)


# ----------------------------------------------------------------------- water

def build_water(elements, frame, half):
    pos, idx = [], []
    count = 0
    for el in elements:
        tags = el.get("tags", {})
        if not (tags.get("natural") == "water" or tags.get("waterway") == "riverbank"):
            continue
        rings = []
        if el.get("type") == "way" and el.get("geometry"):
            rings.append(el["geometry"])
        elif el.get("type") == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    rings.append(m["geometry"])
        for g in rings:
            ring = [frame.to_xz(p["lat"], p["lon"]) for p in g if p]
            if len(ring) < 4:
                continue
            if abs(ring[0][0] - ring[-1][0]) < 1e-6 and abs(ring[0][1] - ring[-1][1]) < 1e-6:
                ring = ring[:-1]
            if len(ring) < 3:
                continue
            poly = np.asarray(ring, dtype=np.float64)
            if poly[:, 0].min() > half or poly[:, 0].max() < -half:
                continue
            if poly[:, 1].min() > half or poly[:, 1].max() < -half:
                continue
            if abs(_signed_area(poly)) < 50:
                continue
            if _signed_area(poly) < 0:
                poly = poly[::-1]
            base = len(pos)
            for pt in poly:
                pos.append((pt[0], 0.15, pt[1]))
            for tri in ear_clip(poly):
                idx += [base + tri[0], base + tri[2], base + tri[1]]  # face up, see note above
            count += 1
    return pos, idx, count


# ---------------------------------------------------------------------- output

def write_mesh(name, arrays, indices):
    """One file per mesh: float32 attribute blocks then a uint32 index block."""
    path = os.path.join(WORLD, f"{name}.bin")
    layout = {}
    offset = 0
    blobs = []
    for key, data, comps in arrays:
        a = np.asarray(data, dtype=np.float32).reshape(-1)
        layout[key] = {"offset": offset, "count": len(a) // comps, "components": comps}
        blobs.append(a.tobytes())
        offset += a.nbytes
    ia = np.asarray(indices, dtype=np.uint32)
    layout["index"] = {"offset": offset, "count": len(ia)}
    blobs.append(ia.tobytes())
    with open(path, "wb") as f:
        for b in blobs:
            f.write(b)
    layout["bytes"] = offset + ia.nbytes
    return layout


def main():
    cfg = load_config()
    frame = Frame(cfg)
    ensure_dirs()
    hf = Height(cfg, frame)
    half = cfg["extent_m"] / 2.0
    meta = {"name": cfg["name"], "origin": cfg["origin"], "extent_m": cfg["extent_m"],
            "chunks": cfg["chunks"], "chunk_m": cfg["chunk_m"],
            "attribution": cfg["attribution"]}

    # --- terrain: height grids only. The mesh is rebuilt in JS from these, which
    # keeps the download at kilobytes per chunk instead of megabytes.
    n = cfg["chunks"]
    v = cfg["terrain"]["verts_per_chunk"]
    grid = v + 1
    heights = np.zeros((n * n, grid, grid), dtype=np.float32)
    for cz in range(n):
        for cx in range(n):
            x0 = -half + cx * cfg["chunk_m"]
            z0 = -half + cz * cfg["chunk_m"]
            xs = np.linspace(x0, x0 + cfg["chunk_m"], grid)
            zs = np.linspace(z0, z0 + cfg["chunk_m"], grid)
            gx, gz = np.meshgrid(xs, zs)
            heights[cz * n + cx] = hf.sample(gx, gz).astype(np.float32)
    with open(os.path.join(WORLD, "terrain.bin"), "wb") as f:
        f.write(heights.tobytes())
    meta["terrain"] = {"grid": grid, "chunks": n, "chunk_m": cfg["chunk_m"],
                       "min": float(heights.min()), "max": float(heights.max())}
    print(f"terrain: {n * n} chunks, {grid}x{grid} each, "
          f"{heights.nbytes / 1024:.0f} KB, {heights.min():.1f}..{heights.max():.1f} m")

    with open(os.path.join(DATA, "osm.json")) as f:
        osm = json.load(f)["elements"]

    # --- roads
    rb = RoadBuilder(cfg, frame, hf)
    margin = 250.0
    for el in osm:
        tags = el.get("tags", {})
        if "highway" not in tags or el.get("type") != "way":
            continue
        if tags.get("area") == "yes":
            continue
        g = el.get("geometry") or []
        pts = [frame.to_xz(p["lat"], p["lon"]) for p in g if p]
        # Ways run past the box edge. Split into the runs that are inside so a
        # road does not vanish the moment one of its nodes leaves the tile.
        run = []
        for pt in pts:
            inside = abs(pt[0]) <= half + margin and abs(pt[1]) <= half + margin
            if inside:
                run.append(pt)
            else:
                if len(run) >= 2:
                    rb.add_way(run, tags)
                run = [pt]
        if len(run) >= 2:
            rb.add_way(run, tags)
    rb.add_junction_discs()
    meta["roads"] = write_mesh("roads", [
        ("position", rb.pos, 3), ("uv", rb.uv, 2), ("road", rb.info, 2)], rb.idx)
    print(f"roads:   {rb.stats['ways']} ways, {len(rb.pos)} verts, "
          f"{len(rb.idx) // 3} tris, {rb.stats['bridges']} bridges, "
          f"{rb.stats['tunnels']} tunnels, {rb.stats['discs']} junction discs")

    # --- buildings
    bpos, bnrm, binfo, bidx, bcount = build_buildings(osm, frame, hf, half)
    meta["buildings"] = write_mesh("buildings", [
        ("position", bpos, 3), ("normal", bnrm, 3), ("info", binfo, 2)], bidx)
    meta["buildings"]["count"] = bcount
    print(f"buildings: {bcount} kept, {len(bpos)} verts, {len(bidx) // 3} tris")

    # --- water
    wpos, widx, wcount = build_water(osm, frame, half)
    meta["water"] = write_mesh("water", [("position", wpos, 3)], widx)
    meta["water"]["count"] = wcount
    print(f"water:   {wcount} polygons, {len(wpos)} verts, {len(widx) // 3} tris")

    # --- road network: drives the minimap, the street-name HUD, and snapping a
    # chosen spawn point onto real asphalt. One file for all three.
    with open(os.path.join(WORLD, "network.json"), "w") as f:
        json.dump(rb.centrelines, f, separators=(",", ":"))
    named = len({c["n"] for c in rb.centrelines if "n" in c})
    pts = sum(len(c["p"]) for c in rb.centrelines)
    print(f"network: {len(rb.centrelines)} ways, {pts} points, {named} distinct names")

    build_overview(cfg)

    # --- spawn: drop the player on the widest road nearest the box centre so
    # the first frame is on asphalt, not in somebody's back yard.
    spawn = pick_spawn(rb)
    meta["spawn"] = spawn
    print(f"spawn:   x {spawn['x']:.1f}  y {spawn['y']:.1f}  z {spawn['z']:.1f}  "
          f"heading {math.degrees(spawn['heading']):.0f} deg")

    verify_windings(
        [("roads", rb.pos, rb.idx), ("water", wpos, widx), ("buildings", bpos, bidx)])

    with open(os.path.join(WORLD, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    total = sum(os.path.getsize(os.path.join(WORLD, p)) for p in os.listdir(WORLD)
                if p.endswith(".bin"))
    print(f"wrote web/world/  ({total / 1e6:.1f} MB of geometry)")


def build_overview(cfg):
    """Downscale the imagery chunks into one image of the whole box.

    The minimap needs the aerial at a glance, and re-using the 100 full-size
    chunk textures for that would cost more memory than the rest of the world
    put together.
    """
    try:
        from PIL import Image
    except ImportError:
        print("  (PIL missing, skipping overview)")
        return
    n = cfg["chunks"]
    per = 200
    out = Image.new("RGB", (n * per, n * per), (40, 46, 40))
    tex_dir = os.path.join(DATA, "tex")
    missing = 0
    for cz in range(n):
        for cx in range(n):
            src = os.path.join(tex_dir, f"{cx}_{cz}.jpg")
            if not os.path.exists(src):
                missing += 1
                continue
            tile = Image.open(src).convert("RGB").resize((per, per), Image.LANCZOS)
            out.paste(tile, (cx * per, cz * per))
    path = os.path.join(WORLD, "overview.jpg")
    out.save(path, quality=82, optimize=True)
    kb = os.path.getsize(path) / 1024
    print(f"overview: {out.width}x{out.height} ({cfg['extent_m'] / out.width:.2f} m/px), "
          f"{kb:.0f} KB" + (f", {missing} chunks missing" if missing else ""))


def verify_windings(meshes):
    """Fail loudly if any horizontal surface is wound face-down.

    A ring that is counter-clockwise in maths orientation on the XZ plane is
    clockwise seen from +Y, because Z increases the opposite way to a textbook
    Y axis. Getting this wrong produces geometry that is present, correctly
    positioned, collides properly, and is completely invisible, because every
    front face points at the ground. It cost an afternoon once; it does not get
    to cost one twice.
    """
    for name, pos, idx in meshes:
        p = np.asarray(pos, dtype=np.float64)
        tri = np.asarray(idx, dtype=np.int64).reshape(-1, 3)
        a, b, c = p[tri[:, 0]], p[tri[:, 1]], p[tri[:, 2]]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n, axis=1)
        ok = ln > 1e-9
        up = n[ok, 1] / ln[ok]
        down = int((up < -0.5).sum())
        flat = int((np.abs(up) > 0.5).sum())
        if flat and down > flat * 0.01:
            raise SystemExit(
                f"winding check failed for {name}: {down} of {flat} horizontal "
                f"triangles face downward. They will be invisible from above.")
        print(f"  winding ok: {name} ({down} downward of {flat} horizontal)")


def pick_spawn(rb):
    # Ribbon vertices come in left/right pairs per centreline point, so average
    # each pair back to the centre. Spawning on a raw vertex puts the car half a
    # lane into the grass.
    raw = np.asarray(rb.pos, dtype=np.float64)
    raw_info = np.asarray(rb.info, dtype=np.float64)
    n_pairs = len(raw) // 2
    pos = (raw[:n_pairs * 2:2] + raw[1:n_pairs * 2:2]) * 0.5
    info = raw_info[:n_pairs * 2:2]
    d = np.hypot(pos[:, 0], pos[:, 2])
    ok = (info[:, 0] > 4.0) & (info[:, 1] > 0) & (d < 900)
    if not ok.any():
        ok = info[:, 0] > 0
    cand = np.where(ok)[0]
    i = cand[np.argmin(d[cand])]
    j = min(i + 8, len(pos) - 1)
    # Yaw about +Y with the vehicle's local +Z as forward, matching Rapier's
    # forward-axis index 2. World forward is then (sin h, 0, cos h).
    heading = math.atan2(pos[j, 0] - pos[i, 0], pos[j, 2] - pos[i, 2])
    return {"x": float(pos[i, 0]), "y": float(pos[i, 1]), "z": float(pos[i, 2]),
            "heading": float(heading)}


if __name__ == "__main__":
    sys.exit(main())
