/**
 * charts.js — draws one index (NDVI or NDMI) with Chart.js.
 *
 * Layers, from back to front:
 *   grey band     normal range = average of normal years ± 1 standard deviation
 *   dashed line   average of normal years
 *   blue line     one normal year (only when "compare" is switched on)
 *   dark line     this season, with a point shape per level
 *                 (● normal, ▲ below normal, ✕ far below normal)
 * A dotted vertical line marks the date chosen with the slider.
 */

const COLORS = {
  season: '#1c2321',
  band: 'rgba(110, 120, 116, 0.22)',
  mean: '#6e7874',
  compare: '#2563eb',
  grid: 'rgba(0, 0, 0, 0.07)',
  selected: '#1f6f50',
  offSeason: 'rgba(28, 35, 33, 0.045)',
};

export const LEVEL_COLORS = { green: '#1a7f37', yellow: '#f2b705', red: '#c62828', off: '#a3aca8', unknown: '#a3aca8' };
const POINT_BORDER = { ...LEVEL_COLORS, yellow: '#7a5b00' }; // dark edge so yellow shows on white
const POINT_STYLE = { green: 'circle', yellow: 'triangle', red: 'crossRot', off: 'circle', unknown: 'circle' };
const POINT_RADIUS = { green: 4, yellow: 6, red: 7, off: 3, unknown: 3 };

/** Small Chart.js plugin: vertical line at the selected period. */
const selectedLine = {
  id: 'selectedLine',
  // Before the lines are drawn: shade the periods outside the growing season.
  beforeDatasetsDraw(chart, _args, options) {
    const inSeasonList = options.inSeason;
    if (!inSeasonList) return;
    const { top, bottom } = chart.chartArea;
    const x = chart.scales.x;
    const half = (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = COLORS.offSeason;
    inSeasonList.forEach((inSeason, i) => {
      if (!inSeason) ctx.fillRect(x.getPixelForValue(i) - half, top, half * 2 + 0.5, bottom - top);
    });
    ctx.restore();
  },
  afterDatasetsDraw(chart, _args, options) {
    if (options.index == null) return;
    const x = chart.scales.x.getPixelForValue(options.index);
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
let chartJsLoading = null;

/** Download Chart.js only when it is needed (never in light mode). */
export function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (!chartJsLoading) {
    chartJsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = CHART_JS;
      script.onload = resolve;
      script.onerror = () => { chartJsLoading = null; reject(new Error('Chart.js could not be loaded')); };
      document.head.appendChild(script);
    });
  }
  return chartJsLoading;
}

export class IndexChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.chart = null;
  }

  /**
   * d = {
   *   labels: string[]            date labels on the x axis
   *   values, valuesAll: number[] this season (cut at the slider / complete)
   *   levels: string[]            level per point (green/yellow/red/off)
   *   mean, sd: number[]          normal years
   *   compare: { label, values } | null
   *   selected: number            period chosen with the slider
   *   texts: { season, mean, band }
   *   locale, format(value)       number formatting
   * }
   */
  update(d) {
    const upper = d.mean.map((m, i) => (m == null ? null : m + d.sd[i]));
    const lower = d.mean.map((m, i) => (m == null ? null : m - d.sd[i]));
    const levels = d.levels.map((l) => l || 'off');
    const common = { spanGaps: true, tension: 0.3 };

    const datasets = [
      {
        ...common,
        label: d.texts.season,
        data: d.values,
        borderColor: COLORS.season,
        borderWidth: 2.5,
        order: 0, // lowest order is drawn on top
        pointStyle: levels.map((l) => POINT_STYLE[l]),
        pointRadius: levels.map((l) => POINT_RADIUS[l]),
        pointHoverRadius: levels.map((l) => POINT_RADIUS[l] + 2),
        pointBackgroundColor: levels.map((l) => LEVEL_COLORS[l]),
        pointBorderColor: levels.map((l) => POINT_BORDER[l]),
        pointBorderWidth: levels.map((l) => (l === 'red' ? 3 : 1)),
      },
      {
        ...common,
        label: d.texts.mean,
        data: d.mean,
        borderColor: COLORS.mean,
        borderWidth: 1.5,
        borderDash: [6, 4],
        pointRadius: 0,
        order: 2,
        isMean: true,
      },
      // Upper and lower edge of the grey band; the lower one is filled up to the upper one.
      { ...common, label: 'upper', data: upper, borderWidth: 0, pointRadius: 0, fill: false, order: 3, hideInTooltip: true },
      { ...common, label: d.texts.band, data: lower, borderWidth: 0, pointRadius: 0, backgroundColor: COLORS.band, fill: '-1', order: 4, hideInTooltip: true },
    ];
    if (d.compare) {
      datasets.push({
        ...common,
        label: d.compare.label,
        data: d.compare.values,
        borderColor: COLORS.compare,
        borderWidth: 2,
        pointRadius: 0,
        order: 1,
      });
    }

    // Keep the y axis still while the slider moves: base it on ALL values.
    const all = [...d.valuesAll, ...upper, ...lower, ...(d.compare ? d.compare.values : [])].filter((v) => v != null);
    const min = Math.min(...all);
    const max = Math.max(...all);
    const pad = (max - min) * 0.08 || 0.05;

    const sd = d.sd;
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      locale: d.locale,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false }, // the page shows its own legend
        selectedLine: { index: d.selected, inSeason: d.inSeason },
        tooltip: {
          filter: (item) => !item.dataset.hideInTooltip && item.parsed.y != null,
          callbacks: {
            label: (item) => {
              const text = `${item.dataset.label}: ${d.format(item.parsed.y)}`;
              return item.dataset.isMean && sd[item.dataIndex] != null ? `${text} ± ${d.format(sd[item.dataIndex])}` : text;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
        y: { min: min - pad, max: max + pad, grid: { color: COLORS.grid }, ticks: { maxTicksLimit: 5, callback: (v) => d.format(v, 1) } },
      },
    };

    if (!this.chart) {
      this.chart = new window.Chart(this.canvas, { type: 'line', data: { labels: d.labels, datasets }, options, plugins: [selectedLine] });
    } else {
      this.chart.data.labels = d.labels;
      this.chart.data.datasets = datasets;
      this.chart.options = options;
      this.chart.update('none');
    }
  }
}
