"""Pull every raw input for the world box. Idempotent: skips what it already has.

  DEM      USGS 3DEP bare-earth, one float32 GeoTIFF for the whole box.
  Imagery  USDA NAIP 2023 30cm, one JPEG per terrain chunk, composited from
           whichever NAIP scenes overlap that chunk.
  Vectors  OpenStreetMap roads, buildings and water via Overpass.

Bare-earth matters. The DSM would have every tree and rooftop baked into the
ground surface, which is undrivable.
"""
import io
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests
from PIL import Image

from geo import DATA, Frame, ensure_dirs, load_config

UA = {"User-Agent": "MandarinDrive/0.1 (personal hobby project)"}
DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
PC = "https://planetarycomputer.microsoft.com/api/data/v1"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def get(url, **kw):
    """GET with retries. These are public services; be patient, not aggressive."""
    last = None
    for attempt in range(5):
        try:
            r = requests.get(url, headers=UA, timeout=kw.pop("timeout", 180), **kw)
            if r.status_code == 200:
                return r
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(2 * (attempt + 1))
                continue
            return r
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET failed after retries: {url[:120]} ({last})")


# --------------------------------------------------------------------------- DEM

def fetch_dem(cfg, frame):
    out = os.path.join(DATA, "dem.npy")
    if os.path.exists(out):
        print("  dem.npy exists, skipping")
        return
    px = cfg["terrain"]["dem_px"]
    w, s, e, n = frame.bbox_lonlat()
    url = (
        f"{DEM_URL}?bbox={w},{s},{e},{n}&bboxSR=4326&size={px},{px}&imageSR=4326"
        "&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image"
    )
    print(f"  requesting 3DEP {px}x{px} ...")
    r = get(url)
    r.raise_for_status()
    arr = np.array(Image.open(io.BytesIO(r.content))).astype(np.float32)

    lo, hi = cfg["terrain"]["valid_range_m"]
    bad = ~np.isfinite(arr) | (arr < lo) | (arr > hi)

    # Two different defects live in this raster and they need different answers.
    # Open water returns nothing at all, which shows up as a huge contiguous
    # sentinel blob. Lidar also throws isolated spikes (bridge decks, wires,
    # noise) that sit inside the nominal valid range but hundreds of metres off
    # the real surface. A fixed clamp catches the first and misses the second,
    # so derive the plausible band from the data itself.
    finite = arr[np.isfinite(arr) & ~bad]
    p_lo, p_hi = np.percentile(finite, [0.1, 99.9])
    bad |= (arr < p_lo - 3.0) | (arr > p_hi + 8.0)
    n_bad = int(bad.sum())

    arr = _fill_holes(arr, bad)
    np.save(out, arr)
    np.save(os.path.join(DATA, "dem_nodata.npy"), bad)
    print(f"  dem {arr.shape}  plausible band {p_lo:.2f}..{p_hi:.2f} m  "
          f"final relief {arr.min():.1f}..{arr.max():.1f} m")
    print(f"  repaired {n_bad} px ({n_bad / arr.size * 100:.2f}%) of water and spikes")


def _fill_holes(arr, bad):
    """Fill masked pixels from valid neighbours, coarse offsets first.

    Averaging immediate neighbours only would need one pass per pixel of hole
    radius, and the river hole here is hundreds of pixels across. Starting with
    a wide stride and halving it fills the interior in a handful of passes.
    """
    out = arr.astype(np.float32).copy()
    out[bad] = np.nan
    hole = np.isnan(out)
    for step in (128, 64, 32, 16, 8, 4, 2, 1, 1, 1):
        if not hole.any():
            break
        total = np.zeros_like(out)
        count = np.zeros_like(out)
        for dy, dx in ((step, 0), (-step, 0), (0, step), (0, -step),
                       (step, step), (step, -step), (-step, step), (-step, -step)):
            shifted = np.roll(np.roll(out, dy, axis=0), dx, axis=1)
            ok = ~np.isnan(shifted)
            total[ok] += shifted[ok]
            count[ok] += 1
        fillable = hole & (count > 0)
        out[fillable] = total[fillable] / count[fillable]
        hole = np.isnan(out)
    out[np.isnan(out)] = float(np.nanmedian(arr[~bad]))
    return out


# ----------------------------------------------------------------------- imagery

def fetch_imagery(cfg, frame):
    n = cfg["chunks"]
    px = cfg["imagery"]["tile_px"]
    items = cfg["imagery"]["naip_items"]
    tex_dir = os.path.join(DATA, "tex")
    os.makedirs(tex_dir, exist_ok=True)

    jobs = [(cx, cz) for cz in range(n) for cx in range(n)]
    jobs = [j for j in jobs if not os.path.exists(os.path.join(tex_dir, f"{j[0]}_{j[1]}.jpg"))]
    if not jobs:
        print(f"  all {n * n} imagery chunks present, skipping")
        return
    print(f"  fetching {len(jobs)} imagery chunks at {cfg['chunk_m'] / px:.3f} m/px ...")

    def one(job):
        cx, cz = job
        w, s, e, nn = frame.chunk_bbox_lonlat(cx, cz, cfg["chunk_m"])
        canvas = None
        for item in items:
            url = (f"{PC}/item/bbox/{w},{s},{e},{nn}/{px}x{px}.png"
                   f"?collection=naip&item={item}&assets=image&asset_bidx=image|1,2,3")
            r = get(url)
            if r.status_code != 200:
                continue
            layer = Image.open(io.BytesIO(r.content)).convert("RGBA")
            if np.array(layer)[..., 3].max() == 0:
                continue  # scene does not overlap this chunk
            canvas = layer if canvas is None else Image.alpha_composite(canvas, layer)
            if np.array(canvas)[..., 3].min() > 0:
                break  # fully covered, no need for further scenes
        if canvas is None:
            canvas = Image.new("RGBA", (px, px), (60, 70, 60, 255))
        canvas.convert("RGB").save(
            os.path.join(tex_dir, f"{cx}_{cz}.jpg"),
            quality=cfg["imagery"]["jpeg_quality"], optimize=True)
        return job

    done = 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for _ in ex.map(one, jobs):
            done += 1
            if done % 10 == 0 or done == len(jobs):
                print(f"    {done}/{len(jobs)}")


# ------------------------------------------------------------------------- OSM

OSM_QUERY = """[out:json][timeout:180];
(
  way["highway"]["highway"!~"^(footway|path|cycleway|steps|pedestrian|track|bridleway|corridor|proposed|construction|raceway)$"]({s},{w},{n},{e});
  way["building"]({s},{w},{n},{e});
  way["natural"="water"]({s},{w},{n},{e});
  way["waterway"="riverbank"]({s},{w},{n},{e});
  relation["natural"="water"]({s},{w},{n},{e});
);
out tags geom;
"""


def fetch_osm(frame):
    out = os.path.join(DATA, "osm.json")
    if os.path.exists(out):
        print("  osm.json exists, skipping")
        return
    w, s, e, n = frame.bbox_lonlat()
    q = OSM_QUERY.format(s=s, w=w, n=n, e=e)
    for ep in OVERPASS:
        try:
            print(f"  querying {ep.split('/')[2]} ...")
            r = requests.post(ep, data={"data": q}, headers=UA, timeout=300)
            if r.status_code == 200:
                d = r.json()
                with open(out, "w") as f:
                    json.dump(d, f)
                kinds = {}
                for el in d["elements"]:
                    t = el.get("tags", {})
                    k = "road" if "highway" in t else "building" if "building" in t else "water"
                    kinds[k] = kinds.get(k, 0) + 1
                print(f"  osm: {kinds}")
                return
            print(f"    HTTP {r.status_code}")
        except Exception as ex:  # noqa: BLE001
            print(f"    failed: {ex}")
    raise RuntimeError("all Overpass endpoints failed")


def main():
    cfg = load_config()
    frame = Frame(cfg)
    ensure_dirs()
    w, s, e, n = frame.bbox_lonlat()
    print(f"Mandarin box  {cfg['extent_m'] / 1000:g} km square")
    print(f"  bbox  W {w:.5f}  S {s:.5f}  E {e:.5f}  N {n:.5f}")
    which = sys.argv[1:] or ["dem", "imagery", "osm"]
    if "dem" in which:
        print("[dem]"); fetch_dem(cfg, frame)
    if "osm" in which:
        print("[osm]"); fetch_osm(frame)
    if "imagery" in which:
        print("[imagery]"); fetch_imagery(cfg, frame)
    print("done")


if __name__ == "__main__":
    main()
