# Mandarin

Drive a real 5 km square of Jacksonville, Florida, in the browser. Built entirely from free public geodata. No Google, no API keys, no accounts.

![Public domain data](https://img.shields.io/badge/data-public%20domain%20%2B%20ODbL-brightgreen)
![Runs in browser](https://img.shields.io/badge/runs-in%20your%20browser-blue)
![No API keys](https://img.shields.io/badge/API%20keys-zero-lightgrey)

![](docs/hero.gif)

Real roads, real elevation, real 2023 aerial imagery. San Jose Boulevard down the middle, I-295 across the north, the St. Johns River on the west edge. Point `config.json` at your own hometown and re-run the pipeline.

Built with Claude writing the code. The box, the feel, and every tuning call are hand-done.

## What it does

- 2,024 OSM roads as drivable 3D ribbons, with procedural lane markings drawn in the fragment shader. Sharp at any distance, no texture atlas.
- 9,534 building footprints extruded from OSM. 203 water polygons. 525 named streets, shown in the HUD as you drive over them.
- Terrain from the USGS 3DEP bare-earth DEM. Aerial skin from USDA NAIP 2023 at 0.49 m/px, 100 chunks.
- Rapier physics on a road trimesh. 0 to 100 km/h in 8.5 s.
- 14 vehicles (Kenney Car Kit, CC0). `V` cycles them, or `?car=police` in the URL.
- Full-box map on `M`: hover names the road under the cursor, click spawns you on it, facing along it, at road surface height.
- Start anywhere: `?at=30.1633,-81.6412` drops you at a coordinate pasted straight from a maps app.
- Runs offline once built. three.js and Rapier are vendored; nothing phones home.

## Quick start

```bash
git clone <this repo> Mandarin && cd Mandarin
cd tools
python3 fetch.py            # DEM + imagery + OSM, ~2 min, idempotent
python3 build_world.py      # meshes -> web/world/, ~3 s
cd ..
./run.sh                    # http://127.0.0.1:8099/
```

Needs Python 3 with `numpy`, `requests`, `Pillow`, plus `npm` (run.sh vendors three.js and Rapier on first run). Raw downloads land in `data/` (~72 MB), the built world in `web/world/` (~63 MB). Both are gitignored.

| key | action |
|---|---|
| `W S` | throttle / brake |
| `A D` | steer |
| `SPACE` | handbrake |
| `SHIFT` | boost |
| `C` | camera: chase, close, bumper, overhead |
| `M` | map (click to start there) |
| `V` | vehicle |
| `R` | reset |

## How it works

Three free sources, one build step, one static server.

| stage | source | notes |
|---|---|---|
| elevation | USGS 3DEP bare-earth DEM | free, no key. Bare-earth matters: the surface model has every tree baked into the ground |
| imagery | USDA NAIP 2023, 30 cm, via Microsoft Planetary Computer | free, public domain |
| vectors | OpenStreetMap via Overpass | roads, buildings, water, street names |

`tools/fetch.py` pulls all three into `data/`, with retries and hole-filling (open water returns nothing from the DEM; lidar throws spikes; both get repaired from valid neighbours). `tools/build_world.py` turns them into flat binary attribute blobs in `web/world/` that the browser loads directly.

The build steps that make it feel like a road instead of a decal:

1. Road elevation is low-passed over a 90 m window along each centreline. Raw per-vertex DEM sampling gives metre-scale noise and the car rattles.
2. Bridges ramp end to end instead of following the ground under them.
3. Ribbons are mitred at joints so corners keep their width.
4. Road classes sit on a 1 cm height ladder (motorway on top, service at the bottom) so overlapping ribbons never z-fight. Junctions get a filler disc.
5. The build ends with a winding check that hard-fails if more than 1% of horizontal triangles face down. That check exists because an entire class of geometry was once invisible from above and the aerial photo underneath hid it for days.

At runtime the car drives on the road trimesh, not the terrain heightfield. That is the entire point of smoothing the road profile at build time. The centreline network (`network.json`) carries the same smoothed heights, so a map-picked spawn lands on asphalt, not on the terrain a metre below it.

## Layout

```
config.json           the box: origin, extent, road widths, attribution
tools/fetch.py        DEM / imagery / OSM downloads
tools/build_world.py  meshes -> web/world/, ends with the winding check
serve.py              static server, correct MIME for .bin/.wasm
web/src/              world loading, road shader, map, physics, input
```

## Credits

- Road and building data (c) OpenStreetMap contributors, ODbL
- Imagery: USDA NAIP 2023, public domain, via Microsoft Planetary Computer
- Elevation: USGS 3DEP bare-earth DEM, public domain
- Vehicles: [Kenney Car Kit](https://kenney.nl/assets/car-kit), CC0

Attribution is displayed in-app and required by the OSM licence.

## License

Code: MIT. See [LICENSE](LICENSE). World data derived from OpenStreetMap remains ODbL.
