/**
 * geocode.js — turns a place name into coordinates.
 * Uses Nominatim, the free OpenStreetMap search. Its rules: at most one
 * search per second and no search-as-you-type, so we only search when the
 * user presses the Search button.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/** Returns { lat, lon, name } or null if nothing was found. */
export async function searchPlace(query, language) {
  const url = `${NOMINATIM}?format=jsonv2&limit=1&accept-language=${language}&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
  const results = await response.json();
  if (!results.length) return null;
  return { lat: Number(results[0].lat), lon: Number(results[0].lon), name: results[0].display_name };
}

/** Coordinates -> a short place name ("Uelzen, Lower Saxony, Germany"), or null. One request per click. */
export async function reversePlace(lat, lon, language) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=${language}&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const a = (await response.json()).address || {};
    const parts = [a.city || a.town || a.village || a.municipality || a.county, a.state, a.country].filter(Boolean);
    return parts.length ? [...new Set(parts)].join(', ') : null;
  } catch {
    return null; // the name is a nice-to-have; the coordinates are enough
  }
}
