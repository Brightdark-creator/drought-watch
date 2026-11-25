/**
 * visuals.js — the pictures that make the result readable in seconds,
 * even for people who can't read well or can't tell colours apart:
 *
 *   plantSvg()     a plant that stands up (healthy), bends (watch) or
 *                  wilts in cracked soil under a hot sun (drought stress)
 *   meterHtml()    a bar from "far below normal" to "above normal" with a
 *                  marker where the field is today
 *   timelineHtml() the whole season as bars: taller bar = bigger warning
 *
 * Every picture is drawn from code (SVG/HTML), so there are no image files
 * to download: good for slow internet.
 */
import { SYMBOLS, YELLOW_Z, RED_Z } from './analysis.js';

/* ---------- 1. The plant ---------- */

// A leaf pointing right from (0,0). It is rotated/mirrored into place.
const LEAF = 'M0 0 C9 -10 25 -10 33 0 C25 8 9 8 0 0Z';

// Shape and colour of the plant for each level.
// leaves: [x, y, angle] — negative angle = leaf points up, positive = hangs down.
const PLANTS = {
  green: {
    stem: 'M60 98 C60 78 60 52 60 26', stemColor: '#2e7d32', leafColor: '#43a047',
    leaves: [[60, 80, -38], [60, 60, -40]], tip: [60, 28, -62, 0.6], bg: '#e3f3e6',
  },
  yellow: {
    stem: 'M60 98 C60 78 62 56 72 38', stemColor: '#7b8a2a', leafColor: '#b3b23b',
    leaves: [[60, 80, -10], [61, 61, -6]], tip: [72, 38, -20, 0.55], bg: '#fcf1cf',
  },
  red: {
    stem: 'M60 98 C60 76 62 58 72 50 C82 42 90 50 88 64', stemColor: '#7a5a2a', leafColor: '#a8783c',
    leaves: [[60, 80, 52, 0.8], [62, 62, 60, 0.8]], tip: [88, 64, 80, 0.5], bg: '#fbe4e1', sun: true, cracks: true,
    leafStroke: '#fbe4e1', // thin outline so hanging leaves don't merge into one shape
  },
  off: {
    stem: 'M60 98 C60 94 60 92 60 88', stemColor: '#7d8a83', leafColor: '#97a59d',
    leaves: [], tip: [60, 90, -30, 0.45], bg: '#eef1ef',
  },
};
PLANTS.unknown = PLANTS.off;

function leafPair(x, y, angle, scale, color, stroke) {
  const s = scale ?? 1;
  const outline = stroke ? ` stroke="${stroke}" stroke-width="${1.6 / s}"` : '';
  return `<path d="${LEAF}" fill="${color}"${outline} transform="translate(${x} ${y}) rotate(${angle}) scale(${s})"/>`
    + `<path d="${LEAF}" fill="${color}"${outline} transform="translate(${x} ${y}) scale(-1 1) rotate(${angle}) scale(${s})"/>`;
}

/** SVG picture of a plant in the state of `level`. Decorative: the text says the same. */
export function plantSvg(level) {
  const p = PLANTS[level] || PLANTS.unknown;
  const sun = p.sun
    ? `<g fill="#f2a900"><circle cx="24" cy="24" r="10"/>${[0, 45, 90, 135, 180, 225, 270, 315]
      .map((a) => `<rect x="22.5" y="5" width="3" height="7" rx="1.5" transform="rotate(${a} 24 24)"/>`).join('')}</g>`
    : '';
  const cracks = p.cracks
    ? '<path d="M30 102 l6 4 -3 4 M58 101 l-3 5 4 4 M84 102 l5 3 -2 5" stroke="#4a331d" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
    : '';
  const soil = p.cracks ? '#a07a52' : '#7a5a3a';
  return `<svg class="plant" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <circle cx="60" cy="60" r="58" fill="${p.bg}"/>
    ${sun}
    <path d="M14 98 H106 V106 Q60 116 14 106Z" fill="${soil}"/>
    ${cracks}
    <path d="${p.stem}" stroke="${p.stemColor}" stroke-width="4" fill="none" stroke-linecap="round"/>
    ${p.leaves.map(([x, y, a, s]) => leafPair(x, y, a, s, p.leafColor, p.leafStroke)).join('')}
    ${leafPair(p.tip[0], p.tip[1], p.tip[2], p.tip[3], p.leafColor, p.leafStroke)}
  </svg>`;
}

/* ---------- 2. The anomaly meter ---------- */

const METER_MIN = -4; // the bar shows z from −4 …
const METER_MAX = 2;  // … to +2 standard deviations
const pos = (z) => ((Math.min(METER_MAX, Math.max(METER_MIN, z)) - METER_MIN) / (METER_MAX - METER_MIN)) * 100;

/**
 * One meter. `z` = standard deviations from normal (or null), `level` sets the
 * marker colour/shape, `inSeason` false greys the zones out.
 * The zone edges come from the same YELLOW_Z / RED_Z as the warning rule.
 */
export function meterHtml({ z, level, inSeason, head, ariaLabel, formatTick }) {
  const red = pos(RED_Z);
  const yellow = pos(YELLOW_Z);
  const marker = z == null ? '' : `<span class="marker lvl-${inSeason && level ? level : 'off'}${z < METER_MIN ? ' clipped' : ''}" style="left:${pos(z)}%;--zero:${pos(0)}%"></span>`;
  return `<div class="meter-row">
    <div class="meter-head">${head}</div>
    <div class="meter${inSeason ? '' : ' meter-off'}" role="img" aria-label="${ariaLabel}">
      <span class="zone zone-red" style="width:${red}%"></span>
      <span class="zone zone-yellow" style="left:${red}%;width:${yellow - red}%"></span>
      <span class="zone zone-green" style="left:${yellow}%;width:${100 - yellow}%"></span>
      <span class="zero" style="left:${pos(0)}%"></span>
      ${marker}
    </div>
    <div class="meter-scale" aria-hidden="true">
      ${[RED_Z, YELLOW_Z, 0].map((v) => `<span style="left:${pos(v)}%">${formatTick(v)}</span>`).join('')}
    </div>
  </div>`;
}

/* ---------- 3. The season timeline ---------- */

/**
 * One bar per 10-day period. Height AND colour show the level, so it also
 * works without colour vision: tall red ✕, middle yellow !, short green.
 * Periods after the selected date are faded (the "future" in the replay).
 */
export function timelineHtml(a, selected, monthLabel) {
  const cells = a.overall.map((level, p) => {
    const classes = ['bar', level ? `lvl-${level}` : 'empty'];
    if (selected != null && p > selected) classes.push('future');
    if (p === selected) classes.push('current');
    const symbol = level === 'yellow' || level === 'red' ? SYMBOLS[level] : '';
    return `<span class="${classes.join(' ')}" data-p="${p}" style="--i:${p}"><i>${symbol}</i></span>`;
  }).join('');
  const months = a.labels
    .map((d, p) => (p % 3 === 0 ? `<span style="grid-column:${p + 1} / span 3">${monthLabel(d)}</span>` : ''))
    .join('');
  return `<div class="bars">${cells}</div><div class="months" aria-hidden="true">${months}</div>`;
}
