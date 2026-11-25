#!/usr/bin/env python3
"""
fetch_sentinel2.py - downloads REAL Sentinel-2 NDVI/NDMI values for farm areas
from Microsoft's Planetary Computer (free, no account needed) and writes one
CSV per area into ../data (columns date, year, NDVI, NDMI, clear).

How it works (so you can explain it):
 1. Search the Sentinel-2 Level-2A catalogue (surface reflectance, i.e. the
    atmosphere is already corrected) for every picture of the area.
 2. For each picture, ask the Planetary Computer to compute, on its own
    servers, over the area:
      NDVI  = (B08 - B04) / (B08 + B04)   near-infrared vs red     -> greenness
      NDMI  = (B08 - B11) / (B08 + B11)   near-infrared vs SWIR    -> leaf water
    using only CLEAR pixels: the Scene Classification layer (SCL) says what
    each pixel is; 4 = vegetation and 5 = bare soil are kept, clouds, cloud
    shadows, snow and water are dropped.
 3. Pictures where less than 60 % of the area is clear are skipped.
 4. Pictures processed with baseline 04.00 or later (from January 2022) have
    +1000 added to every band; it is subtracted so all years are comparable.

Only the Python standard library is used. Run:
    python3 tools/fetch_sentinel2.py                # all areas
    python3 tools/fetch_sentinel2.py de-uelzen      # one area
It takes a few minutes per area (about one request per picture).

Data: Copernicus Sentinel-2 (ESA), processed by ESA/Microsoft, accessed via
the Microsoft Planetary Computer STAC and data APIs.
"""

import csv
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
STATS = "https://planetarycomputer.microsoft.com/api/data/v1/item/statistics"
OUT = Path(__file__).resolve().parent.parent / "data"
MIN_CLEAR = 0.6          # at least 60 % of the area must be clear
MAX_SCENE_CLOUD = 80     # skip pictures that are more than 80 % cloudy overall
WORKERS = 6              # requests at the same time (be kind to the free service)

# Farm areas: centre and size (km). Years: the drought year plus normal years.
AREAS = {
    "de-uelzen":    {"lat": 52.950, "lon": 10.626, "size_km": 1.0, "start": "2017-01-01", "end": "2024-12-31"},
    "it-mantova":   {"lat": 45.1224, "lon": 10.6757, "size_km": 1.0, "start": "2017-01-01", "end": "2024-12-31"},
    "us-illinois":  {"lat": 40.180, "lon": -88.4535, "size_km": 1.0, "start": "2017-01-01", "end": "2024-12-31"},
    "ar-pergamino": {"lat": -33.980, "lon": -60.700, "size_km": 1.0, "start": "2016-07-01", "end": "2024-06-30"},
    "ma-chaouia":   {"lat": 33.050, "lon": -7.550, "size_km": 1.0, "start": "2016-09-01", "end": "2024-08-31"},
    "au-temora":    {"lat": -34.395, "lon": 147.458, "size_km": 1.0, "start": "2016-01-01", "end": "2024-12-31"},
}


def square(lat, lon, size_km):
    """A square polygon around the centre, as GeoJSON ([lon, lat] order)."""
    half = size_km / 2
    dlat = half / 111.32
    dlon = half / (111.32 * math.cos(math.radians(lat)))
    ring = [[lon - dlon, lat - dlat], [lon + dlon, lat - dlat], [lon + dlon, lat + dlat],
            [lon - dlon, lat + dlat], [lon - dlon, lat - dlat]]
    return {"type": "Polygon", "coordinates": [[[round(x, 6), round(y, 6)] for x, y in ring]]}


def post_json(url, body, tries=4):
    data = json.dumps(body).encode()
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception:  # network hiccup or server busy: wait and retry
            if attempt == tries - 1:
                raise
            time.sleep(2 ** attempt * 2)


def search_pictures(geometry, start, end):
    """All Sentinel-2 L2A pictures of the area (follows the catalogue's page links)."""
    body = {"collections": ["sentinel-2-l2a"], "intersects": geometry, "datetime": f"{start}/{end}",
            "query": {"eo:cloud_cover": {"lt": MAX_SCENE_CLOUD}}, "limit": 500}
    items = []
    page = post_json(STAC, body)
    while True:
        items += page["features"]
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        if not nxt:
            return items
        page = post_json(nxt["href"], nxt.get("body", body))


def expression(baseline):
    """NDVI, NDMI and the clear share, counting only clear pixels."""
    off = 1000 if baseline >= "04.00" else 0
    b = lambda name: f"({name}-{off})" if off else name
    clear = "((SCL==4)|(SCL==5))"
    ndvi = f"where({clear},({b('B08')}-{b('B04')})/({b('B08')}+{b('B04')}),0)"
    ndmi = f"where({clear},({b('B08')}-{b('B11')})/({b('B08')}+{b('B11')}),0)"
    return f"{ndvi};{ndmi};where({clear},1,0)"


def picture_stats(item, feature):
    """Returns (date, ndvi, ndmi, clear) or None when the area was not clear enough."""
    baseline = item["properties"].get("s2:processing_baseline", "00.00")
    query = urllib.parse.urlencode({"collection": "sentinel-2-l2a", "item": item["id"],
                                    "expression": expression(baseline), "asset_as_band": "true"})
    try:
        result = post_json(f"{STATS}?{query}", feature)
    except Exception as error:
        print("  skipped", item["id"], error)
        return None
    s = list(result["properties"]["statistics"].values())
    clear = s[2]["mean"]
    if clear < MIN_CLEAR:
        return None
    # The averages include the masked pixels as 0, so divide by the clear share.
    return (item["properties"]["datetime"][:10], s[0]["mean"] / clear, s[1]["mean"] / clear, clear)


def fetch_area(name, cfg):
    geometry = square(cfg["lat"], cfg["lon"], cfg["size_km"])
    feature = {"type": "Feature", "properties": {}, "geometry": geometry}
    items = search_pictures(geometry, cfg["start"], cfg["end"])
    print(f"{name}: {len(items)} pictures in the catalogue, computing…", flush=True)
    with ThreadPoolExecutor(WORKERS) as pool:
        rows = [r for r in pool.map(lambda it: picture_stats(it, feature), items) if r]
    rows.sort()
    path = OUT / f"{name}.csv"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "year", "NDVI", "NDMI", "clear"])
        for date, ndvi, ndmi, clear in rows:
            w.writerow([date, date[:4], round(ndvi, 4), round(ndmi, 4), round(clear, 3)])
    print(f"{name}: wrote {len(rows)} clear pictures to {path.name}", flush=True)
    return geometry


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(AREAS)
    for name in wanted:
        fetch_area(name, AREAS[name])
