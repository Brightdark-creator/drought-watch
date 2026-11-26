/**
 * charts-lite.js — a very small chart drawn as SVG, used in light mode.
 * It needs no library download (Chart.js is about 200 KB), so the app stays
 * fast on slow internet. It shows the same layers as charts.js:
 * grey normal band, dashed average, optional normal year, this season with
 * point shapes per level, shaded off-season and the selected date.
 * (No hover tooltips: the "Show the numbers" table has every value.)
 */

const C = {
  season: '#12251c', band: 'rgba(47,125,80,0.16)', mean: '#2f7d50', compare: '#2563eb',
  grid: 'rgba(0,0,0,0.07)', text: '#59645f', selected: '#12251c', off: 'rgba(28,35,33,0.045)',
};
const LEVEL = { green: '#1a7f37', yellow: '#f2b705', red: '#c62828', off: '#a3aca8', unknown: '#a3aca8' };

/**
 * Draw into `container` (a div). d is the same object charts.js gets,
 * plus d.monthLabel(date) and d.dates (first day of each period).
 */
export function drawLiteChart(container, d) {
  const width = Math.max(260, container.clientWidth || 600);
  const height = container.clientHeight || 210;
  const pad = { left: 34, right: 8, top: 8, bottom: 22 };
  const n = d.mean.length;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // y range from everything that can be shown (stays still while the slider moves)
  const upper = d.mean.map((m, i) => (m == null ? null : m + d.sd[i]));
  const lower = d.mean.map((m, i) => (m == null ? null : m - d.sd[i]));
  const all = [...d.valuesAll, ...upper, ...lower, ...(d.compare ? d.compare.values : [])].filter((v) => v != null);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const margin = (max - min) * 0.08 || 0.05;
  const y0 = min - margin;
  const y1 = max + margin;

  const x = (i) => pad.left + (plotW * (i + 0.5)) / n;
  const y = (v) => pad.top + plotH * (1 - (v - y0) / (y1 - y0));
  const pt = (i, v) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`;

  // A line through all non-empty values (gaps are bridged, like spanGaps in Chart.js)
  const line = (values, attrs) => {
    const pts = values.map((v, i) => (v == null ? null : pt(i, v))).filter(Boolean);
    return pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" ${attrs}/>` : '';
  };

  const parts = [];
  // off-season shading
  d.inSeason.forEach((inSeason, i) => {
    if (!inSeason) parts.push(`<rect x="${(x(i) - plotW / n / 2).toFixed(1)}" y="${pad.top}" width="${(plotW / n + 0.5).toFixed(1)}" height="${plotH}" fill="${C.off}"/>`);
  });
  // grid lines and y labels
  const step = niceStep((y1 - y0) / 4);
  const digits = Math.round(step * 100) % 10 === 0 ? 1 : 2; // 0.25 needs 2 decimals, 0.2 only 1
  for (let k = Math.ceil(y0 / step); k * step <= y1; k++) {
    const v = k * step; // whole-number counter avoids rounding drift
    parts.push(`<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.grid}"/>`);
    parts.push(`<text x="${pad.left - 5}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${d.format(v, digits)}</text>`);
  }
  // x labels: first day of every second month
  d.dates.forEach((date, i) => {
    if (i % 6 === 0) parts.push(`<text x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="middle">${d.monthLabel(date)}</text>`);
  });
  // normal band = upper edge forward, lower edge backward
  const idx = d.mean.map((m, i) => (m == null ? null : i)).filter((i) => i != null);
  if (idx.length > 1) {
    const band = [...idx.map((i) => pt(i, upper[i])), ...idx.slice().reverse().map((i) => pt(i, lower[i]))];
    parts.push(`<polygon points="${band.join(' ')}" fill="${C.band}"/>`);
  }
  parts.push(line(d.mean, `stroke="${C.mean}" stroke-width="1.5" stroke-dasharray="6 4"`));
  if (d.compare) parts.push(line(d.compare.values, `stroke="${C.compare}" stroke-width="2"`));
  // This season: each piece takes the colour of the level at its end (yellow/red where the warning is).
  const LINE = { yellow: '#c79300', red: LEVEL.red };
  let prev = null;
  d.values.forEach((v, i) => {
    if (v == null) return;
    if (prev != null) {
      const color = LINE[d.levels[i]] || C.season;
      parts.push(`<line x1="${x(prev).toFixed(1)}" y1="${y(d.values[prev]).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
    }
    prev = i;
  });
  // points: ● normal, ▲ below normal, ✕ far below normal
  d.values.forEach((v, i) => {
    if (v == null) return;
    const level = d.levels[i] || 'off';
    const cx = x(i);
    const cy = y(v);
    if (level === 'red') {
      parts.push(`<path d="M${cx - 5} ${cy - 5}L${cx + 5} ${cy + 5}M${cx + 5} ${cy - 5}L${cx - 5} ${cy + 5}" stroke="${LEVEL.red}" stroke-width="3" stroke-linecap="round"/>`);
    } else if (level === 'yellow') {
      parts.push(`<path d="M${cx} ${cy - 6}L${cx + 6} ${cy + 5}L${cx - 6} ${cy + 5}Z" fill="${LEVEL.yellow}" stroke="#7a5b00"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${level === 'green' ? 4 : 3}" fill="${LEVEL[level]}"/>`);
    }
  });
  // selected date
  if (d.selected != null) {
    parts.push(`<line x1="${x(d.selected)}" x2="${x(d.selected)}" y1="${pad.top}" y2="${pad.top + plotH}" stroke="${C.selected}" stroke-width="1.5" stroke-dasharray="3 3"/>`);
  }

  container.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" font-size="11" fill="${C.text}">${parts.join('')}</svg>`;
}

/** A round step for the y axis: 0.05, 0.1, 0.2, 0.25, 0.5 … */
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
}
