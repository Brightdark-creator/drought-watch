# Drought Watch

A free drought early-warning web app. It uses Sentinel-2 satellite data to spot
crop stress before plants wilt. Plain HTML, CSS and JavaScript: no build step,
runs as a static site (GitHub Pages).

> **Sample data is simulated.** The three test fields (northern Germany 2018,
> Po Valley 2022, US Midwest 2023) use data made by `tools/make_sample_data.py`
> so the app works straight away. Replace them with your Earth Engine exports
> for real results.

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
│   ├── fields.json         list of fields: name, position, outline, file, years
│   ├── de-uelzen.csv       one CSV per field: date, year, NDVI, NDMI
│   ├── it-mantova.csv
│   └── us-illinois.csv
└── tools/
    └── make_sample_data.py makes the simulated sample CSVs
```

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

- **Warning card:** a plant that stands up (✓ healthy), bends (! watch) or
  wilts in dry soil (✕ drought stress), the level in one word, one sentence of
  advice, and two meters showing how many standard deviations NDMI and NDVI
  are from normal. The meter zones use the same −1/−2 limits as the rule.
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

## Tests

Open <http://localhost:8000/tests.html> while the local server runs. It checks
the calendar, the average/SD/z-score, every part of the warning rule (yellow,
red only twice in a row, cloudy gaps, SD minimum, too few normal years), the
lead time, the season summary, the confidence label, the CSV reader and the
distance formula with small examples whose answers are known. All 40 should pass.

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
