# Drought Watch

A free drought early-warning web app. It uses Sentinel-2 satellite data to spot
crop stress before plants wilt. Plain HTML, CSS and JavaScript: no build step,
runs as a static site (GitHub Pages).

The app ships with **real Sentinel-2 measurements for six drought seasons on
five continents**: Germany 2018, Italy 2022, USA 2023, Argentina 2022/23,
Morocco 2021/22 and Australia 2019. They were downloaded with
`tools/fetch_sentinel2.py` from the Microsoft Planetary Computer (free, no
account) and checked against what really happened (see "Results with real
data" below).

## File structure

```
drought-watch/
├── index.html              page layout: map, warning card, timeline, charts
├── summary.html            results for all fields on one printable page (for the judges)
├── tests.html              automatic tests of the science code (open in the browser)
├── sw.js                   offline support (service worker)
├── manifest.webmanifest    lets phones install the app on the home screen
├── icons/                  app icon (SVG + PNG sizes for phones)
├── css/style.css           design (mobile first)
├── js/
│   ├── app.js              connects everything: input → data → analysis → screen
│   ├── data.js             THE ONLY place that loads data (swap for a live API later)
│   ├── analysis.js         the science: normal range, anomaly (z-score), traffic light
│   ├── visuals.js          wilting-plant picture, anomaly meters, season timeline
│   ├── charts.js           NDVI/NDMI line charts (Chart.js, downloaded only when needed)
│   ├── charts-lite.js      tiny SVG chart for light mode (no download)
│   ├── summary.js          builds the results page
│   ├── map.js              world map (Leaflet + OpenStreetMap), loaded only when shown
│   ├── geocode.js          place search (Nominatim)
│   ├── i18n.js             picks the language, formats dates/numbers/units
│   └── lang.js             ALL texts, English and German
├── data/
│   ├── fields.json         the six areas: name, position, outline, season, normal years, event
│   ├── <area>.csv          real Sentinel-2 values per picture: date, year, NDVI, NDMI, clear
│   ├── images/             "Seen from space" pictures (true colour + greenness map)
│   └── simulated/          the old simulated sample files (for teaching only)
└── tools/
    ├── fetch_sentinel2.py      downloads REAL Sentinel-2 NDVI/NDMI for any area (no account)
    ├── fetch_images.py         downloads the "Seen from space" pictures
    ├── make_sample_data.py     makes the simulated sample CSVs
    └── earth-engine-export.js  Earth Engine Code Editor script that exports a CSV for one field
```

## Results with real data

Each area is a 1 km × 1 km square of farmland (100 ha; several fields, so that
crop rotation from year to year averages out). Clear pixels only (Sentinel-2
Scene Classification: vegetation or bare soil); pictures with less than 60 %
of the area clear are skipped. Pictures processed since 2022 have a +1000
offset in every band, which the download script removes.

| Area | Drought season | Normal years used | Warning (yellow) | First red | Lead time* |
|---|---|---|---|---|---|
| Uelzen, Germany | 2018 | 2017, 2021, 2023, 2024 | 24 Jul | 18 Aug | 25 days |
| Mantua, Italy | 2022 | 2018–2021, 2023, 2024 | 30 Jul | 14 Aug | 15 days |
| Central Illinois, USA | 2023 | 2017, 2018, 2020–2022, 2024 | – | – | – |
| Pergamino, Argentina | 2022/23 (from July) | 2016/17, 2018/19–2020/21, 2023/24 | 6 Jan | 16 Jan | – |
| Chaouia, Morocco | 2021/22 (from Sept.) | 2016/17–2018/19, 2020/21 | 1 Jan | 26 Jan | 35 days |
| Temora, Australia | 2019 | 2016, 2020–2022 | 26 Aug | 15 Sep | 20 days |

\* days between leaf water (NDMI) dropping below normal and greenness (NDVI)
turning red.

**What this shows**
- 5 of 6 drought seasons got a red warning. Where greenness also fell far
  below normal (4 areas), leaf water warned **24 days earlier on average**.
- **Illinois 2023: no warning.** The flash drought hit in May–June while the
  crops were small (before the growing season the app judges), and rain came
  back in July. As far as I know Illinois still harvested a record maize crop
  in 2023, so "no damage visible from space" may be the right answer. Check
  this against USDA statistics before you use it in your report.
- **Argentina:** red for only one picture in mid-January, then green again
  (late-sown or replanted crops). The drought was real but the signal at this
  spot is short.
- **Australia:** z-scores down to −20 SD. The normal years (2016, 2020–2022)
  were all wet and very alike, so the normal range is extremely narrow. The
  warning is right, but the size of the number says more about the narrow
  normal range than about the drought. Confidence shows "low" there (only 3
  normal years with a picture at that date).
- **Germany and Italy warn in July/August**, not in spring: a 1 km² mix of
  crops (cereals, maize, beet…) is judged on its summer peak; early stress in
  cereals is diluted by the other crops.
- **Sensitivity check:** starting the growing season at 30 % instead of 50 %
  of the normal NDVI range changes no warning date and no lead time.
- **Normal-year check:** flags Morocco 2017/18, although that was a good
  harvest nationally; the area probably had a different land use or timing
  that year. This is what the check is for: a reason to look closer.

**Where the normal years come from:** known drought history (e.g. Germany was
also dry in 2019, 2020 and 2022; Italy in 2017; Argentina in 2017/18 and
2021/22; Morocco in 2019/20, 2022/23 and 2023/24; New South Wales in 2017–2018;
Illinois 2019 was left out because floods delayed planting by weeks). Please
confirm these with sources (national weather services, FAO/GIEWS, USDA) for
your report.

To refresh or add areas: edit `AREAS` in `tools/fetch_sentinel2.py`, run it,
add the area to `data/fields.json`, then run `tools/fetch_images.py`.

## How the warning works

1. **One value per 10-day period.** The season is split into 36 periods
   (1st–10th, 11th–20th, 21st–end of each month). Clouds make NDVI too low,
   never too high, so in each period we keep the picture with the highest NDVI
   ("maximum value composite") and its NDMI.
2. **Normal for this field on these dates.** For each period we take the same
   period in the field's normal years and compute the average and the standard
   deviation (SD). Short cloud gaps in normal years are filled with a straight line.
3. **Anomaly.** `z = (this year − average) / SD`: how many SDs the field is
   below (−) or above (+) its own normal.
4. **Traffic light** (per index, then the worse of NDVI and NDMI):
   - ✕ red: z < −2 in **this and the previous** period
   - ! yellow: z < −1 (or z < −2 only once)
   - ✓ green: otherwise
5. **Growing season** from the field's own data: periods where its average
   NDVI is in the upper half between its lowest and highest value. Outside it
   the app shows "–" and gives no warning.

There is no fixed NDVI threshold and no fixed calendar. The only fixed number is
a minimum SD of 0.02 (about Sentinel-2's measurement noise), so a lucky
near-zero SD from few years cannot create false alarms. All settings are at the
top of `js/analysis.js`.

**Early-warning lead time.** When greenness (NDVI) first turns red, the app
looks back to when leaf water (NDMI) started to be below normal and shows the
number of days in between. Leaves lose water before they lose colour, so this
is the head start the warning gives. In the sample fields it is about a month.

The **slider** (or a click on the season timeline) replays the season: the app only uses pictures up to the chosen
date, so it shows exactly what it would have said on that day. That lets you
measure how early the warning came.

## What the screen shows

- **Header:** search, "use my location", the six drought areas and "Analyse
  your own CSV". Each area opens at the worst moment of its drought season.
- **Map:** full-width satellite picture; the warning card floats over its edge.

- **Warning card:** a plant that stands up (✓ healthy), bends (! watch) or
  wilts in dry soil (✕ drought stress), the level in one word, one sentence of
  advice, and two meters showing how many standard deviations NDMI and NDVI
  are from normal. The meter zones use the same −1/−2 limits as the rule.
- **Seen from space:** real Sentinel-2 pictures of the area at the same time
  of year in a normal year and in the drought year, as true colour or as a
  greenness (NDVI) map. The white square is the 1 km area the app measures.
- **Season at a glance:** one bar per 10-day period. Taller bar = stronger
  warning, so it also works without colour vision. Click a bar to jump there.
- **Charts:** this season against the normal range; the growing season is
  unshaded, the rest is lightly shaded.
- **Confidence:** high / medium / low, with the reasons: how many normal years
  there are for that date (5+ is good, 3 is the minimum), how long ago the
  previous picture was (the red rule needs two pictures in a row), and whether
  the value sits right at a warning limit (within 0.25 SD = close call).
- **Show the numbers:** the same data as a table (screen readers, checking).
- **Map:** satellite picture (Sentinel-2 cloudless) or street map; your choice
  is remembered. The location button finds the test field nearest to you.

## Results page for the judges

`summary.html` (link at the bottom of the app) runs the same rule on every
field and lists, side by side: worst level, when the warning started, first
red, lead time, lowest leaf water and greenness, and the number of red
periods, plus each field's season timeline. The Print button gives a clean
handout.

It also runs a **normal-year check**: each normal year is compared with the
other normal years only (leave-one-out). The app takes the lower quarter
(25th percentile) of its anomalies over the growing season; below −3 SD for
one index and below −2 SD for the other, the year is marked "check": it may
have been a drought year itself (which would make "normal" too dry and
warnings too late) or a different crop was grown. Look it up in weather
records and remove it from `normalYears` if it was dry. The same check marks
years as "looks dry" in the settings for an uploaded file.

Why the lower quarter and not the median: a drought often hits only part of
the season (Uelzen 2018: May–July), which hardly moves the median. Tested on
the simulated fields with every possible season choice: the median caught
only some of the built-in drought years; the lower-quarter rule caught all 15
cases where a drought year was among the "normal" years, and gave 2 false
flags in 60 checks of truly normal years (both Uelzen 2017, whose random peak
came out about 0.05 lower). The limits were chosen on simulated data, so
check them with real data. With ~5 normal years it is a hint, not a verdict.

## Tests

Open <http://localhost:8000/tests.html> while the local server runs. It checks
the calendar, the average/SD/z-score, every part of the warning rule (yellow,
red only twice in a row, cloudy gaps, SD minimum, too few normal years), the
lead time, the season summary, the confidence label, the CSV reader and the
distance formula, the normal-year check and reading uploaded files (position
from `.geo`, clear errors), with small examples whose answers are known, plus keeping and restoring an uploaded file.
All 55 should pass.

## Accessibility

Checked with the axe-core accessibility checker (app in English and German,
phone and desktop width, light mode, results page): no violations. Colours
were measured: all text is at least 4.5:1, the yellow shapes have a dark edge
so they reach 3:1 on white, and every level also has its own symbol and bar
height, so nothing depends on colour alone.

## Run it on your computer

Browsers block loading files from `file://`, so start a tiny web server in the
project folder:

```bash
cd drought-watch
```

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Stop the server with Ctrl+C.

## Put it on GitHub Pages

1. Create a new **public** repository on GitHub, e.g. `drought-watch`.
2. Upload the files (keep the folder structure), or with git:

   ```bash
   git remote add origin https://github.com/<your-name>/drought-watch.git
   ```

   ```bash
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`, **Save**.
4. After a minute the app is live at `https://<your-name>.github.io/drought-watch/`.

All paths in the app are relative, so it works in a sub-folder like that.

## Use your own Earth Engine data

### Quick: drop the file on the page

Click **Analyse your own CSV** (or drag the file onto the page). The app reads
it in the browser, so the file never leaves your device. It is gone when you
reload, unless you tick **Keep this file on this device**: then it is saved in
the browser's storage (about 5–25 KB), comes back after a reload with its
settings, and also appears on the results page. Then use **Settings for your file**:

- **Season starts in:** January for most of the northern hemisphere; e.g. July
  for the southern hemisphere, where the season crosses New Year.
- **Season to check:** the year to judge (default: the latest in the file).
- **Normal years:** all other years with enough pictures are ticked. Years
  that look dry compared with the others are marked "looks dry": untick them
  if they were drought years. Years with too few pictures can't be used.

No export script yet? `tools/earth-engine-export.js` is a Google Earth Engine
Code Editor script (steps in the app under "How do I get data for my own
field?"). It uses Sentinel-2 surface reflectance, keeps only clear pixels
(Scene Classification: vegetation or bare soil), keeps pictures where at least
80 % of the field is clear, and exports date, year, NDVI, NDMI and the field
outline. **I wrote it for this app but could not run it**, so check the first
rows it prints before trusting the export.

If the CSV has Earth Engine's `.geo` column (a Point or the field Polygon) or
`lat`/`lon` columns, the field also appears on the map. The file needs at
least 30 pictures; the app explains what is wrong if a column is missing.

### Permanent: add it to the test fields

1. Export a CSV per field with your script. Required columns: `date`
   (`YYYY-MM-DD`), `NDVI`, `NDMI`. Extra columns (`year`, `system:index`,
   `.geo`) are ignored. Include the year you want to check plus at least 3
   normal years (5 or more is better).
2. Put the CSV into `data/`.
3. Add an entry to `data/fields.json`:

```json
{
  "id": "my-field",
  "name": { "en": "My field near X", "de": "Mein Feld bei X" },
  "short": { "en": "X · 2024", "de": "X · 2024" },
  "crop": "maize",
  "lat": 48.1, "lon": 11.5,
  "areaHa": 15,
  "polygon": [[48.099, 11.498], [48.101, 11.498], [48.101, 11.502], [48.099, 11.502]],
  "file": "my-field.csv",
  "season": 2024,
  "seasonStartMonth": 1,
  "normalYears": [2018, 2019, 2020, 2021, 2023]
}
```

- `season`: the year to check (default: the latest year in the file).
- `normalYears`: years used as "normal" (default: all other years). Leave out
  other drought years, or they make "normal" too dry.
- `seasonStartMonth`: use e.g. `7` for the southern hemisphere, where the
  season crosses New Year.
- `polygon` and `areaHa` are optional. `crop` must have a `crop_<name>` text in
  `js/lang.js` (add one for new crops).
- Remove `"simulated": true` for real data.

JSON instead of CSV also works: name the file `.json` and use
`[{ "date": "2024-05-01", "NDVI": 0.81, "NDMI": 0.33 }, …]`.

## Switch to a live data source later

Only `js/data.js` talks to the data. Replace the bodies of `listFields()`,
`loadSeries(field)` and `findField(fields, lat, lon)` with calls to your
backend (e.g. a small Python server that queries Copernicus Data Space or
Earth Engine) and return the same shapes described at the top of the file.
`findField` could then create a new field for any clicked point.

## Language

The app always starts in English. German is in the language menu; the choice
is remembered on that device.

## Add a language

Copy the `en` block in `js/lang.js`, rename it (e.g. `fr`) and translate the
right-hand side. Add the language to the `name`/`short` texts in
`fields.json`. The language menu shows it automatically.

## Offline and installing on a phone

`sw.js` saves the app and the field data on the device after the first visit,
so it opens without internet (the map pictures and place search still need
internet). It works on GitHub Pages and on `localhost`. When you change files,
raise `VERSION` at the top of `sw.js` so phones throw away the old copy.
On a phone, "Add to Home Screen" installs it like an app.

## Light mode

"Light mode (no map)" hides the map and draws the charts with the small SVG
chart, so it downloads no libraries and no map pictures at all: only the
app's own files and the field data. It turns on by itself when the browser reports "data saver" or a
2G connection; the choice is remembered on that device.

## Credits and limits

- Satellite map: Sentinel-2 cloudless 2020 by EOX IT Services GmbH
  (contains modified Copernicus Sentinel data 2020), licensed CC BY-NC-SA 4.0:
  free for non-commercial use such as a science fair, with attribution.
- Map © OpenStreetMap contributors. Place search: Nominatim (at most one search
  per second; the app only searches when you press Search).
- Libraries from CDNs: Chart.js 4.4.1 (jsDelivr), Leaflet 1.9.4 (unpkg).
- Satellite data: Copernicus Sentinel-2 (ESA), processed in Google Earth Engine.
- Limits: a low NDVI/NDMI can also come from pests, hail, flooding, an early
  harvest or a crop change. The warning means "look at this field", not proof
  of drought.
