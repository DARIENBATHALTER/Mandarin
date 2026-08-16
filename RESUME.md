# Mandarin

Drive a 5 km square of Mandarin, Jacksonville, in the browser. Real roads, real
elevation, real 2023 aerial imagery. Built entirely from public-domain and
open data. No Google, no API keys, no accounts.

**Status: working.** Loads, drives, stays on the road. 0–100 km/h in 8.5 s.

## Run it

```bash
cd ~/Desktop/Development/Mandarin
./run.sh                    # http://127.0.0.1:8099/
```

If a copy is already serving, `run.sh` says so and exits instead of dying on
`[Errno 48] Address already in use` — which is what a leftover background
server looks like, and it reads exactly like the app being broken. To restart:

```bash
kill $(lsof -t -iTCP:8099 -sTCP:LISTEN) && ./run.sh
```

`W S` throttle / brake · `A D` steer · `SPACE` handbrake · `SHIFT` boost
`R` reset · `C` camera (chase → close → bumper → overhead) · `M` map · `V` vehicle · `F` free look

**Pick where you start.** Press `M` (or click the minimap) for the whole box.
Hover shows the road under the cursor by name; click puts you on it, facing
along it, at the correct surface height. `ESC` or `M` closes without moving.

**Pick a vehicle.** `V` cycles 14 of them, or `?car=police` / `?car=race` /
`?car=firetruck` straight in the URL.

**Start at a specific coordinate**: `http://127.0.0.1:8099/?at=30.1633,-81.6412`
— latitude first, the order every maps app copies to the clipboard. Out-of-box
coordinates warn on the console and fall back to the default spawn.

Needs no internet at runtime. three.js and Rapier are vendored in `web/node_modules`.

## The box

Centre **30.1570, −81.6320**, 5 km square. Covers San Jose Blvd (SR 13) down
the middle, I‑295 across the north, Loretto Rd, the Mandarin core, and the
east bank of the St. Johns.

Change it in `config.json` (`origin`, `extent_m`) and re-run the pipeline.

## Pipeline

```bash
cd tools
python3 fetch.py            # dem + osm + imagery  (~2 min, idempotent)
python3 build_world.py      # -> web/world/        (~3 s)
```

`fetch.py` takes arguments if you only want one stage: `python3 fetch.py dem osm`.

| stage | source | notes |
|---|---|---|
| elevation | USGS 3DEP bare-earth DEM | free, no key. **Bare-earth matters**: the DSM has every tree baked into the ground |
| imagery | USDA NAIP 2023, 30 cm, via Microsoft Planetary Computer | free, public domain. 100 chunks at 0.49 m/px |
| vectors | OpenStreetMap via Overpass | 2,024 roads, 9,534 buildings, 203 water polys, 525 street names |

`build_world.py` also emits `network.json` (every road centreline, decimated to
~12 m, carrying the **final smoothed surface height**) and `overview.jpg` (the
whole box at 2.5 m/px, downscaled from the imagery chunks).

One file, three jobs: the minimap strokes, the street name in the HUD, and
snapping a chosen spawn onto real asphalt. Because the centrelines carry the
same height the ribbons were built from, a picked spawn lands on the road
surface rather than on whatever the terrain happens to be underneath it — the
two differ by up to a metre wherever the profile was smoothed.

Raw downloads land in `data/` (gitignored, ~35 MB). Built world is
`web/world/` (~30 MB).

## What the build does that matters

1. **Road elevation is low-passed** over a 90 m window along each centreline.
   Sampling the DEM per vertex gives metre-scale noise and the car rattles.
   This single step is most of why it feels like a road.
2. **Bridges ramp end to end** rather than following the ground under them.
3. **Ribbons are mitred** at joints so corners keep their width.
4. **Road classes are lifted on a 1 cm ladder** (motorway highest, service
   lowest) so overlapping ribbons never share a plane and never z-fight.
   Junctions get a filler disc sized to the widest incoming road.
5. **Map strokes are drawn at display scale**, not baked into `overview.jpg`.
   Baked strokes shrink with the image, and at whole-box zoom a 2 px line
   becomes a quarter of a pixel and vanishes. The minimap culls by way bounding
   box so it is not stroking 2,024 ways twenty times a second.
6. **Lane markings are procedural**, drawn in the fragment shader from
   (offset-from-centreline, distance-along, half-width, lane count). No texture
   atlas, stays sharp at any distance, adapts to any road width.

## Vehicles

Kenney's [Car Kit](https://kenney.nl/assets/car-kit), **CC0**, in
`web/assets/cars/` with the licence file alongside. 2.7 MB for 14 vehicles.

Deliberately not real marques. A recognisable production car carries the
manufacturer's trademark and trade dress; that is licensed to games like Forza,
not free for the taking, and a model ripped out of another game is a copyright
problem on top of it. Generic bodies cost nothing and carry no exposure.

How they are fitted, in `car-model.js`:

- Each kit model already contains four **named wheel nodes**. Those are detached
  and re-driven from the physics wheel positions, so a truck keeps truck wheels
  and the racer keeps slicks with no per-vehicle mapping table.
- Kit convention, read out of the files rather than assumed: front is **+Z**,
  left is **+X**, wheel centres at y = 0.3, ground plane at y = 0. Same
  handedness as the physics, so no correction rotation is needed.
- Bodies are scaled to fill the collision box, with width and height sharing a
  factor so the car is not distorted head on. Only length is stretched.
- The kit draws a narrow track under wide arches, so the body is widened just
  enough to cover the track or the tyres stand outside the fenders.
- Ride height comes from `Car.measureRestSag()`, which settles the suspension
  and **measures** the compression rather than assuming it. Hardcoding it put
  the car on stilts the moment the springs were retuned, which is exactly what
  happened when stiffness went from 30 to 20 and sag went 0.14 → 0.33.

Swapping bodywork does not touch physics: 0–100 km/h is still 8.47 s.

## The bug that cost the most, so it does not happen again

A ring that is counter-clockwise in maths orientation on the XZ plane is
**clockwise** seen from +Y, because Z increases opposite to a textbook Y axis.
Every horizontal surface — roads, roof caps, water, junction discs — was wound
face-down and therefore backface-culled. The geometry was present, correctly
positioned, and collided perfectly. It was just invisible from every camera
above it, and the NAIP photo of the real road showed through underneath, which
looked convincing enough to hide it for a long time.

`build_world.py` now ends with `verify_windings()`, which hard-fails the build
if more than 1% of horizontal triangles face down. Do not remove it.

## Physics notes

- Mass comes from **density on the chassis box**, never `setAdditionalMass`.
  The latter adds mass with zero rotational inertia, and a body with zero
  inverse inertia cannot rotate at all.
- `controller.currentVehicleSpeed()` is the **magnitude** of chassis velocity,
  so it reads several m/s while the suspension settles at a standstill.
  `Car.speed` projects onto the heading instead.
- The car drives on the **road trimesh**, not the terrain heightfield. That is
  the entire point of smoothing the road profile at build time.
- Terrain collision is verified against the visual mesh at load with downward
  raycasts (`verifyTerrain`), because a transposed heightfield still looks
  plausible.

## Known rough edges

- **A stale server is the first thing to check if it "won't start".** The port
  check above is there because a forgotten background `serve.py` cost a
  debugging round: every request to the URL succeeded, served by the old
  process, while every attempt to launch a new one failed.

- **Imagery seam.** A visible brightness step runs east–west across the box
  where the two NAIP scenes meet. Fix by histogram-matching the second scene to
  the first in `fetch.py`, or by feathering the alpha composite.
- **Buildings have no collision.** You drive straight through them. 9,534
  footprints as trimesh is too slow to build at load; do it per-chunk within a
  radius of the player.
- **Ground texture is soft at eye level.** 0.49 m/px is a lot at 1.5 m camera
  height. Could re-fetch at 1024 px per 250 m chunk for 0.24 m/px at 4× the
  tiles and ~100 MB.
- **No trees.** OSM has almost none here and the canopy is baked flat into the
  aerial. Extruding `natural=tree` plus a scatter over landuse would help most.
- **No traffic, no signals, no signs.**
- Vehicle bodies are stylised low-poly against photoreal aerial. It reads as a
  toy car on a real map, which is a look; it is not realism.
- The map is north-up and fixed-zoom (700 m across on the minimap). No rotate,
  no pinch. Fine for a 5 km box, would need work for anything larger.
- Background tabs: the sim keeps running via a `setTimeout` fallback, but Chrome
  throttles background timers to ~1 s, so it advances at roughly 9% of real
  time when hidden. Harmless, but it will fool you during automated testing.

## Next, in the order I would do it

1. Histogram-match the NAIP scenes to kill the seam.
2. Per-chunk building colliders near the player.
3. Trees.
4. A route/time-trial mode: pick two points, plot along the road graph, race it.
   `network.json` is already the graph, and the map already does point picking,
   so this is mostly A* plus a checkpoint ribbon.
5. Then, and only then, think about multiplayer (OVERCHARGE already has a
   netcode chassis worth reusing).

## Layout

```
config.json           box, chunking, road widths, attribution
serve.py              static server on :8099
tools/geo.py          config + local ENU frame (all metres, never lat/lon downstream)
tools/fetch.py        DEM / imagery / OSM downloads
tools/build_world.py  meshes -> web/world/, ends with the winding check
web/index.html        boot screen + HUD
web/src/world.js      loaders, terrain assembly, road shader
web/src/map.js        road index (naming + spawn snapping), minimap, full map
web/src/car-model.js  Kenney GLB loading, wheel extraction, ride height
web/src/physics.js    Rapier world, heightfields, vehicle
web/src/main.js       scene, camera, input, loop
```

Attribution is displayed in-app and required: OSM is ODbL; NAIP and 3DEP are
public domain.
