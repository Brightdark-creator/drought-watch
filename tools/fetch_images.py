#!/usr/bin/env python3
"""
fetch_images.py - small Sentinel-2 pictures for the "Seen from space" panel.

For every area in data/fields.json that has real data (no "simulated" flag):
 1. find the clear picture in the drought season where NDVI was furthest
    below the same time of year in the normal years;
 2. find a clear picture from about the same day of the year in the most
    typical normal year;
 3. download both as a true-colour picture (what your eyes would see) and as
    an NDVI map (green = lush, yellow/red = little green), 1.6 km wide;
 4. write their file names and dates into data/fields.json ("images").

Uses the Microsoft Planetary Computer (free, no account) and only the Python
standard library. Run after fetch_sentinel2.py:  python3 tools/fetch_images.py
"""

import csv
import json
import math
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
IMAGES = DATA / "images"
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
TILE = "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox"
VIEW_KM = 1.6      # picture width; the 1 km area sits in the middle
MIN_CLEAR = 0.95   # only nearly cloud-free pictures


def post_json(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def season_of(d, start_month):
    return d.year if d.month >= start_month else d.year - 1


def day_in_season(d, start_month):
    start = date(season_of(d, start_month), start_month, 1)
    return (d - start).days


def read_rows(path):
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            rows.append({"date": date.fromisoformat(r["date"]), "ndvi": float(r["NDVI"]),
                         "clear": float(r.get("clear") or 1)})
    return rows


def normal_ndvi(rows, normals, start_month, day, window=12):
    """Average NDVI of the normal years within ±window days of this day of the season."""
    vals = [r["ndvi"] for r in rows if season_of(r["date"], start_month) in normals
            and abs(day_in_season(r["date"], start_month) - day) <= window]
    return sum(vals) / len(vals) if vals else None


def pick_pictures(field, rows):
    start_month = field.get("seasonStartMonth", 1)
    season = field["season"]
    normals = field["normalYears"]
    clear = [r for r in rows if r["clear"] >= MIN_CLEAR]
    if field.get("imageDate"):
        # 1. drought picture: the clearest picture close to the date the app
        #    found as the worst point of the season (imageDate in fields.json)
        wanted = date.fromisoformat(field["imageDate"])
        near = [r for r in rows if abs((r["date"] - wanted).days) <= 12 and r["clear"] >= 0.9]
        if not near:
            return None
        drought = min(near, key=lambda r: (abs((r["date"] - wanted).days) // 6, -r["clear"]))
        return drought, normal_picture(rows, clear, normals, start_month, drought)
    # Without imageDate: the largest NDVI deficit against the normal years
    best = None
    for r in clear:
        if season_of(r["date"], start_month) != season:
            continue
        normal = normal_ndvi(rows, normals, start_month, day_in_season(r["date"], start_month))
        if normal is None or normal < 0.35:  # outside the growing season
            continue
        deficit = normal - r["ndvi"]
        if best is None or deficit > best[0]:
            best = (deficit, r)
    if best is None:
        return None
    drought = best[1]
    return drought, normal_picture(rows, clear, normals, start_month, drought)


def normal_picture(rows, clear, normals, start_month, drought):
    """2. normal picture: same time of year, NDVI closest to the normal average."""
    day = day_in_season(drought["date"], start_month)
    target = normal_ndvi(rows, normals, start_month, day)
    candidates = [r for r in clear if season_of(r["date"], start_month) in normals
                  and abs(day_in_season(r["date"], start_month) - day) <= 15]
    if not candidates or target is None:
        return None
    return min(candidates, key=lambda r: abs(r["ndvi"] - target))


def find_item(day, bbox):
    body = {"collections": ["sentinel-2-l2a"], "bbox": bbox,
            "datetime": f"{day.isoformat()}T00:00:00Z/{(day + timedelta(days=1)).isoformat()}T00:00:00Z",
            "sortby": [{"field": "eo:cloud_cover", "direction": "asc"}], "limit": 5}
    items = post_json(STAC, body)["features"]
    return items[0] if items else None


def download(item, bbox, kind, path):
    b = ",".join(f"{x:.6f}" for x in bbox)
    if kind == "rgb":
        params = {"collection": "sentinel-2-l2a", "item": item["id"], "assets": "visual", "max_size": 400,
                  "dst_crs": "epsg:3857"}  # square pixels on the ground (no stretching)
    else:
        off = 1000 if item["properties"].get("s2:processing_baseline", "00.00") >= "04.00" else 0
        b8, b4 = (f"(B08-{off})", f"(B04-{off})") if off else ("B08", "B04")
        params = {"collection": "sentinel-2-l2a", "item": item["id"], "asset_as_band": "true",
                  "expression": f"({b8}-{b4})/({b8}+{b4})", "rescale": "0,0.9",
                  "colormap_name": "rdylgn", "max_size": 400, "dst_crs": "epsg:3857"}
    url = f"{TILE}/{b}.jpg?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=180) as r:
        path.write_bytes(r.read())


def main():
    fields_path = DATA / "fields.json"
    doc = json.loads(fields_path.read_text())
    IMAGES.mkdir(exist_ok=True)
    for field in doc["fields"]:
        if field.get("simulated") or not (DATA / field["file"]).exists():
            continue
        rows = read_rows(DATA / field["file"])
        picked = pick_pictures(field, rows)
        if not picked or None in picked:
            print(field["id"], "no clear pictures found")
            continue
        half = VIEW_KM / 2
        dlat = half / 111.32
        dlon = half / (111.32 * math.cos(math.radians(field["lat"])))
        bbox = [field["lon"] - dlon, field["lat"] - dlat, field["lon"] + dlon, field["lat"] + dlat]
        images = {}
        for role, row in zip(("drought", "normal"), picked):
            item = find_item(row["date"], bbox)
            if not item:
                continue
            entry = {"date": row["date"].isoformat(), "ndviValue": round(row["ndvi"], 3)}
            for kind in ("rgb", "ndvi"):
                name = f"{field['id']}-{role}-{kind}.jpg"
                download(item, bbox, kind, IMAGES / name)
                entry[kind] = f"images/{name}"
            images[role] = entry
            print(field["id"], role, row["date"], f"NDVI {row['ndvi']:.2f}")
        field["images"] = images
    fields_path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
