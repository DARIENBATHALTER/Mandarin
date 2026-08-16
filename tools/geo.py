"""Shared geo helpers: config loading and the local ENU frame.

Everything downstream works in metres east/north of the config origin. Nothing
downstream ever sees a latitude. Feeding global coordinates into float32 vertex
buffers or a physics solver is what makes worlds jitter, so the conversion
happens once, here, and never again.
"""
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
WORLD = os.path.join(ROOT, "web", "world")


def load_config():
    with open(os.path.join(ROOT, "config.json")) as f:
        return json.load(f)


def meters_per_degree(lat_deg):
    """WGS84 metres per degree at a given latitude (series approximation)."""
    p = math.radians(lat_deg)
    m_lat = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p) - 0.0023 * math.cos(6 * p)
    m_lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)
    return m_lat, m_lon


class Frame:
    """Local east-north-up frame anchored at the config origin.

    Note the sign on north: three.js is right-handed with -Z pointing away from
    the default camera, so north maps to -Z and the world reads correctly when
    you look at it from above with +X to the right.
    """

    def __init__(self, cfg):
        self.lat0 = cfg["origin"]["lat"]
        self.lon0 = cfg["origin"]["lon"]
        self.m_lat, self.m_lon = meters_per_degree(self.lat0)
        self.half = cfg["extent_m"] / 2.0

    def to_xz(self, lat, lon):
        x = (lon - self.lon0) * self.m_lon
        z = -(lat - self.lat0) * self.m_lat
        return x, z

    def to_latlon(self, x, z):
        lon = self.lon0 + x / self.m_lon
        lat = self.lat0 - z / self.m_lat
        return lat, lon

    def bbox_lonlat(self):
        """(W, S, E, N) covering the whole extent."""
        dlat = self.half / self.m_lat
        dlon = self.half / self.m_lon
        return (self.lon0 - dlon, self.lat0 - dlat, self.lon0 + dlon, self.lat0 + dlat)

    def chunk_bbox_lonlat(self, cx, cz, chunk_m):
        """(W, S, E, N) for chunk (cx, cz), indexed from the NW corner."""
        x0 = -self.half + cx * chunk_m
        z0 = -self.half + cz * chunk_m
        n_lat, w_lon = self.to_latlon(x0, z0)
        s_lat, e_lon = self.to_latlon(x0 + chunk_m, z0 + chunk_m)
        return (w_lon, s_lat, e_lon, n_lat)


def ensure_dirs():
    for d in (DATA, WORLD, os.path.join(WORLD, "tex")):
        os.makedirs(d, exist_ok=True)
