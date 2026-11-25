#!/usr/bin/env python3
"""
make_sample_data.py - creates the SIMULATED sample CSV files in ../data

IMPORTANT FOR THE SCIENCE FAIR
These files are NOT real satellite measurements. They are simulated so the
app works straight away without Google Earth Engine. Replace them with the
CSV files from your Earth Engine script for real results.

How the simulation works (so you can explain it):
1. Each crop has a typical season curve (a "double logistic" curve):
   low in winter, rising during green-up, high at peak, falling at harvest.
2. Every year gets small random changes (green-up a few days earlier or
   later, slightly higher or lower peak). That is the natural year-to-year
   variation that the app's "normal range" measures.
3. In the drought year a stress factor slowly grows. It lowers NDMI (leaf
   water) first and NDVI (greenness) about two weeks later, and the crop
   ripens early. This matches what is seen in real droughts.
4. Satellite pictures are taken every 5 days (every 10 days in 2016, when
   only Sentinel-2A was in orbit). Cloudy days are dropped, and a few
   pictures keep some haze, which makes the values a bit too low.

Output columns are the same as your Earth Engine export:
    date, year, NDVI, NDMI

Run:  python3 tools/make_sample_data.py
"""

import csv
import math
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data"


def s_curve(t, middle, width):
    """Smooth step from 0 to 1 around day `middle` (logistic function)."""
    return 1.0 / (1.0 + math.exp(-(t - middle) / width))


def clamp(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


# Typical season shape per crop.
# Index values: (winter level, peak level, level after harvest, autumn regrowth)
# sos/eos = day of year of green-up / senescence middle, w = how fast (days)
CROPS = {
    "winter_wheat": {
        "NDVI": (0.45, 0.86, 0.24, 0.16),
        "NDMI": (0.12, 0.44, -0.06, 0.12),
        "sos": 92, "w1": 9, "eos": 190, "w2": 6, "aut": 285, "w3": 14,
    },
    "maize": {
        "NDVI": (0.22, 0.86, 0.26, 0.0),
        "NDMI": (-0.10, 0.42, -0.05, 0.0),
        "sos": 162, "w1": 8, "eos": 255, "w2": 7, "aut": 300, "w3": 10,
    },
}


def season_curve(t, crop, year_shift, index):
    """Value of one index on day-of-year t for a normal (unstressed) year."""
    winter, peak, after, autumn = crop[index]
    peak += year_shift["peak"] * (1.0 if index == "NDVI" else 0.8)
    up = s_curve(t, crop["sos"] + year_shift["sos"], crop["w1"])
    down = s_curve(t, crop["eos"] + year_shift["eos"], crop["w2"])
    regrow = s_curve(t, crop["aut"] + year_shift["sos"], crop["w3"])
    return winter + (peak - winter) * up - (peak - after) * down + autumn * regrow


def stress(t, drought):
    """Drought stress from 0 (none) to 1 (full) on day-of-year t."""
    if not drought:
        return 0.0
    s = clamp((t - drought["onset"]) / drought["ramp"])
    if drought.get("recover"):  # rain later in the season (partial recovery)
        start, length, share = drought["recover"]
        s *= 1.0 - share * clamp((t - start) / length)
    return s


def picture_dates(year, rng, cloud, drought_year):
    """Days with a usable (not cloudy) Sentinel-2 picture."""
    revisit = 10 if year < 2017 else 5
    d = date(year, 1, 1) + timedelta(days=rng.randrange(revisit))
    while d.year == year:
        p_cloud = cloud[d.month - 1]
        if drought_year and 5 <= d.month <= 8:
            p_cloud *= 0.6  # droughts have more sunny days
        if rng.random() > p_cloud:
            yield d
        d += timedelta(days=revisit)


def make_field(cfg):
    rng = random.Random(cfg["seed"])  # fixed seed: same files every time
    crop = CROPS[cfg["crop"]]
    rows = []
    for year in cfg["years"]:
        drought = cfg["drought"] if year == cfg["target"] else None
        shift = {
            "sos": rng.gauss(0, 5),
            "eos": rng.gauss(0, 4) - (drought["early_end"] if drought else 0),
            "peak": rng.gauss(0, 0.02),
        }
        winter, peak, after, _ = crop["NDVI"]
        lowest = min(winter, after)
        for d in picture_dates(year, rng, cfg["cloud"], drought is not None):
            t = d.timetuple().tm_yday
            ndvi = season_curve(t, crop, shift, "NDVI")
            ndmi = season_curve(t, crop, shift, "NDMI")
            canopy = clamp((ndvi - lowest) / (peak - lowest))  # stress needs leaves
            if drought:
                ndmi -= drought["ndmi"] * stress(t, drought) * canopy
                ndvi -= drought["ndvi"] * stress(t - drought["lag"], drought) * canopy
            ndvi += rng.gauss(0, 0.012)  # sensor and atmosphere noise
            ndmi += rng.gauss(0, 0.015)
            if rng.random() < 0.06:  # thin haze the cloud mask missed
                ndvi -= rng.uniform(0.04, 0.15)
                ndmi -= rng.uniform(0.03, 0.10)
            rows.append((d.isoformat(), year, round(ndvi, 4), round(ndmi, 4)))
    path = OUT / cfg["file"]
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "year", "NDVI", "NDMI"])
        w.writerows(rows)
    print(f"wrote {path.name}: {len(rows)} pictures")


# Monthly chance that a picture is cloudy (Jan..Dec), roughly like the region.
FIELDS = [
    {   # Lower Saxony, northern Germany: drought spring/summer 2018
        "file": "de-uelzen.csv", "crop": "winter_wheat", "seed": 18,
        "years": range(2016, 2022), "target": 2018,
        "cloud": [.78, .74, .62, .52, .46, .42, .42, .42, .50, .62, .75, .80],
        "drought": {"onset": 118, "ramp": 30, "ndmi": 0.13, "ndvi": 0.13,
                    "lag": 14, "early_end": 14},
    },
    {   # Po Valley near Mantua, Italy: drought and water shortage summer 2022
        "file": "it-mantova.csv", "crop": "maize", "seed": 22,
        "years": range(2017, 2023), "target": 2022,
        "cloud": [.70, .60, .55, .50, .42, .30, .22, .25, .38, .55, .70, .75],
        "drought": {"onset": 158, "ramp": 28, "ndmi": 0.14, "ndvi": 0.15,
                    "lag": 12, "early_end": 12},
    },
    {   # Central Illinois, US Midwest: flash drought June 2023, rain in July
        "file": "us-illinois.csv", "crop": "maize", "seed": 23,
        "years": range(2018, 2024), "target": 2023,
        "cloud": [.65, .62, .58, .52, .45, .38, .35, .33, .35, .42, .55, .65],
        "drought": {"onset": 150, "ramp": 25, "ndmi": 0.16, "ndvi": 0.11,
                    "lag": 10, "early_end": 0, "recover": (196, 22, 0.85)},
    },
]

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for cfg in FIELDS:
        make_field(cfg)
