/**
 * summary.js — the results page for the judges (summary.html).
 * Runs the same analysis as the app on every field and puts the key numbers
 * side by side: when the warning started, when it turned red, how many days
 * leaf water warned before greenness, and the lowest anomalies.
 */
import * as Data from './data.js';
import { analyseField, seasonSummary, checkNormalYears, SYMBOLS } from './analysis.js';
import { timelineHtml } from './visuals.js';
import { t, pick, setLanguage, applyStaticTexts, formatDate, formatSigned, formatList } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function init() {
  // Same language as the app (remembered on this device), English by default.
  let lang = 'en';
  try { lang = localStorage.getItem('dw.lang') || 'en'; } catch { /* private window */ }
  setLanguage(lang);
  applyStaticTexts();
  document.title = t('summaryTitle');
  $('print').addEventListener('click', () => window.print());

  // Test fields plus any uploaded files the user chose to keep on this device.
  const fields = [...(await Data.listFields()), ...Data.restoreKeptUploads()];
  const results = await Promise.all(fields.map(async (field) => {
    const a = analyseField(field, await Data.loadSeries(field));
    // Nearby spots: the same rule, season and normal years, 8–15 km away.
    const nearby = await Promise.all((field.replicates || []).map(async (r) => {
      try {
        const ra = analyseField({ ...field, ...r }, await Data.loadSeries({ ...field, ...r }));
        return { r, a: ra, s: seasonSummary(ra) };
      } catch { return null; } // file not downloaded yet
    }));
    return { field, a, s: seasonSummary(a), nearby: nearby.filter(Boolean) };
  }));

  const day = (a, p) => (p == null ? '–' : esc(formatDate(a.dates[p], { day: 'numeric', month: 'short' })));
  const zAt = (a, low) => (low == null ? '–' : `${esc(t('sdValue', { z: formatSigned(low.z) }))}<br><small>${day(a, low.period)}</small>`);

  // 1. One table comparing every field.
  $('overview').innerHTML = `<table>
    <thead><tr>
      <th scope="col">${esc(t('colField'))}</th>
      <th scope="col">${esc(t('colWorst'))}</th>
      <th scope="col">${esc(t('colWarningStart'))}</th>
      <th scope="col">${esc(t('colFirstRed'))}</th>
      <th scope="col">${esc(t('colLead'))}</th>
      <th scope="col">${esc(t('colLowestNdmi'))}</th>
      <th scope="col">${esc(t('colLowestNdvi'))}</th>
      <th scope="col">${esc(t('colRed'))}</th>
      <th scope="col">${esc(t('colNearby'))}</th>
    </tr></thead>
    <tbody>${results.map(({ field, a, s, nearby }) => `<tr>
      <th scope="row">${esc(pick(field.short))}</th>
      <td><span class="mini lvl-${s.worst}" aria-hidden="true">${SYMBOLS[s.worst]}</span> ${esc(t(`level_${s.worst}`))}</td>
      <td>${day(a, s.warningStart)}</td>
      <td>${day(a, s.firstRed)}</td>
      <td>${s.lead ? `<b>${esc(t('leadDays', { days: s.lead.days }))}</b>` : '–'}</td>
      <td>${zAt(a, s.lowestNdmi)}</td>
      <td>${zAt(a, s.lowestNdvi)}</td>
      <td>${s.redPeriods}</td>
      <td>${nearbyHtml(nearby, day)}</td>
    </tr>`).join('')}</tbody>
  </table>`;

  // 2. One card per field with its season timeline.
  const monthLabel = (d) => formatDate(d, { month: 'narrow' });
  $('fields').innerHTML = results.map(({ field, a, s }) => `
    <article class="field-card">
      <h3><span class="mini lvl-${s.worst}" aria-hidden="true">${SYMBOLS[s.worst]}</span> ${esc(pick(field.name))}</h3>
      <p class="meta">${esc(field.uploaded ? t('fromYourFile') : t(`crop_${field.crop}`))} · ${esc(t('season'))} ${a.season} · ${esc(t('comparedWith', { years: formatList(a.normalYears) }))}${field.simulated ? ` · <em>${esc(t('simulated'))}</em>` : ''}</p>
      ${field.event ? `<p class="event"><b>${esc(t('eventLabel'))}:</b> ${esc(pick(field.event))}</p>` : ''}
      ${field.sources?.length ? `<ul class="source-list">${field.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul>` : ''}
      <div class="timeline">${timelineHtml(a, null, monthLabel)}</div>
      <p>${s.lead
        ? esc(t('summaryLead', { ndmiDate: formatDate(a.dates[s.lead.ndmiStart]), ndviDate: formatDate(a.dates[s.lead.ndviRed]), days: s.lead.days }))
        : esc(t('summaryNoLead'))}</p>
      ${normalCheckHtml(checkNormalYears(a))}
      <p><a href="./?field=${encodeURIComponent(field.id)}">${esc(t('openInApp'))}</a></p>
    </article>`).join('');

  const leads = results.map((r) => r.s.lead?.days).filter((d) => d != null);
  const red = results.filter((r) => r.s.worst === 'red').length;
  const parts = [t('summaryDetected', { n: red, total: results.length })];
  const spots = results.flatMap((r) => r.nearby);
  if (spots.length) {
    const agree = results.reduce((n, r) => n + r.nearby.filter((x) => (x.s.worst === 'red') === (r.s.worst === 'red')).length, 0);
    parts.push(t('summaryNearby', { agree, total: spots.length }));
  }
  if (leads.length) {
    const avg = Math.round(leads.reduce((x, y) => x + y, 0) / leads.length);
    parts.push(t('summaryHeadline', { days: avg, count: leads.length }));
  }
  $('headline').textContent = parts.join(' ');
}

/** Result at the nearby spots: symbol + first red date for each. */
function nearbyHtml(nearby, day) {
  if (!nearby.length) return '–';
  return nearby.map(({ a, s }) => `<span class="nearby"><span class="mini lvl-${s.worst}" aria-hidden="true">${SYMBOLS[s.worst]}</span> ${s.firstRed != null ? day(a, s.firstRed) : esc(t(`level_${s.worst}`))}</span>`).join('<br>');
}

/** Small table: each normal year compared with the other normal years. */
function normalCheckHtml(checks) {
  if (!checks.length) return '';
  const fmt = (z) => (z == null ? '–' : esc(formatSigned(z)));
  const flagged = checks.filter((c) => c.suspicious).map((c) => c.year);
  return `<details class="normal-check"${flagged.length ? ' open' : ''}>
    <summary>${esc(t('normalCheckTitle'))}: ${esc(flagged.length ? t('normalCheckFlag', { years: formatList(flagged) }) : t('normalCheckOk'))}</summary>
    <p class="hint">${esc(t('normalCheckHelp'))}</p>
    <table>
      <thead><tr><th scope="col">${esc(t('season'))}</th><th scope="col">${esc(t('ndmiName'))}</th><th scope="col">${esc(t('ndviName'))}</th><th scope="col">${esc(t('tableLevel'))}</th></tr></thead>
      <tbody>${checks.map((c) => `<tr${c.suspicious ? ' class="flagged"' : ''}>
        <th scope="row">${c.year}</th><td>${fmt(c.ndmi)}</td><td>${fmt(c.ndvi)}</td>
        <td>${c.suspicious ? `<span class="mini lvl-yellow" aria-hidden="true">!</span> ${esc(t('normalCheckLook'))}` : `<span class="mini lvl-green" aria-hidden="true">✓</span>`}</td>
      </tr>`).join('')}</tbody>
    </table>
  </details>`;
}

init().catch((error) => {
  console.error(error);
  $('overview').textContent = t('loadError');
});
