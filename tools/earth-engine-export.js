/**
 * earth-engine-export.js — Google Earth Engine Code Editor script.
 *
 * Makes a CSV for Drought Watch: one row per clear Sentinel-2 picture of one
 * field, with the columns date, year, NDVI, NDMI and .geo (the field outline,
 * so the app can show the field on the map).
 *
 * How to use it:
 *  1. Open https://code.earthengine.google.com (free for students and research).
 *  2. Paste this script. Change the field corners and the name below.
 *  3. Press Run. Check "Pictures found" and the first rows in the Console.
 *  4. Open the Tasks tab and press RUN next to the task. The CSV lands in your
 *     Google Drive.
 *  5. In Drought Watch press "Analyse your own CSV" (or drop the file on the page).
 *
 * NOTE: this script was written for the app but has not been run by its author.
 * Check the first rows in the Console before you trust the export. (Your own
 * Python export script works too, as long as it has date, NDVI and NDMI.)
 */

// ----- 1. Your field -------------------------------------------------------
// Corners as [longitude, latitude] (Earth Engine order!). The first corner is
// repeated at the end. Or draw the field with the polygon tool and use that.
var field = ee.Geometry.Polygon([[
  [10.6223, 52.9482], [10.6297, 52.9482], [10.6297, 52.9518],
  [10.6223, 52.9518], [10.6223, 52.9482]
]]);
var name = 'my_field';

// ----- 2. Time range --------------------------------------------------------
// The season you want to check PLUS at least 3 (better 5 or more) normal years.
// Use one collection for all years, so all values are comparable. Surface
// reflectance (S2_SR) starts in 2017 in Europe and in December 2018 worldwide.
var start = '2017-04-01';
var end = '2024-01-01';

// ----- 3. Keep only clear pixels -------------------------------------------
// Sentinel-2's Scene Classification (SCL) labels every pixel:
// 4 = vegetation, 5 = bare soil. Clouds, shadows, snow and water are dropped.
function clearOnly(img) {
  var scl = img.select('SCL');
  return img.updateMask(scl.eq(4).or(scl.eq(5)));
}

// ----- 4. One row per picture: the field's average NDVI and NDMI -------------
function toRow(img) {
  var ndvi = img.normalizedDifference(['B8', 'B4']).rename('NDVI');   // greenness: near-infrared vs red
  var ndmi = img.normalizedDifference(['B8', 'B11']).rename('NDMI');  // leaf water: near-infrared vs short-wave infrared
  var clear = ndvi.mask().rename('clear');                            // 1 = clear pixel, 0 = removed
  var stats = ndvi.addBands(ndmi).addBands(clear).reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: field,
    scale: 10,
    maxPixels: 1e9
  });
  return ee.Feature(field, stats).set({
    date: img.date().format('YYYY-MM-dd'),
    year: img.date().get('year')
  });
}

var pictures = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
  .filterBounds(field)
  .filterDate(start, end)
  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
  .map(clearOnly);

var rows = ee.FeatureCollection(pictures.map(toRow))
  .filter(ee.Filter.gt('clear', 0.8))            // at least 80 % of the field is clear
  .filter(ee.Filter.notNull(['NDVI', 'NDMI']))
  .sort('date');

// ----- 5. Check and export --------------------------------------------------
Map.centerObject(field, 15);
Map.addLayer(field, { color: 'yellow' }, 'Field');
print('Pictures found:', rows.size());
print('First rows:', rows.limit(5));

Export.table.toDrive({
  collection: rows,
  description: name,
  fileFormat: 'CSV',
  selectors: ['date', 'year', 'NDVI', 'NDMI', '.geo']
});
