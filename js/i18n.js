/**
 * i18n.js — translation and local formatting helpers.
 * All the words live in lang.js. This file only picks the right language
 * and formats dates, numbers and units (metric) for the reader's country.
 */
import { STRINGS } from './lang.js';

export const LANGUAGES = Object.keys(STRINGS); // ['en', 'de']
let current = 'en';

/**
 * The app always starts in English. Other languages are chosen in the
 * language menu, and that choice is remembered on the device.
 */
export const DEFAULT_LANGUAGE = 'en';
export function initialLanguage() {
  return DEFAULT_LANGUAGE;
}

export function setLanguage(lang) {
  current = LANGUAGES.includes(lang) ? lang : 'en';
  document.documentElement.lang = current;
}

export function getLanguage() {
  return current;
}

/** Translate a key. "{name}" in the text is replaced by params.name. */
export function t(key, params = {}) {
  const text = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

/** Text from a {en: "...", de: "..."} object (used for field names in fields.json). */
export function pick(texts) {
  if (!texts) return '';
  if (typeof texts === 'string') return texts;
  return texts[current] ?? texts.en ?? Object.values(texts)[0] ?? '';
}

/**
 * The locale used for dates and numbers. If the browser's language matches
 * the chosen one we use the browser's region (en-US writes "May 21, 2018",
 * en-GB "21 May 2018"); otherwise a sensible default.
 */
export function locale() {
  const browser = navigator.languages?.[0] || navigator.language || '';
  if (browser.toLowerCase().startsWith(current)) return browser;
  return current === 'de' ? 'de-DE' : 'en-GB';
}

/** Fill every element that has data-i18n="key" (and placeholder/title/aria-label variants). */
export function applyStaticTexts(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
  document.title = t('appTitle');
}

/* Dates are stored as UTC midnight, so they are always formatted in UTC. */
export function formatDate(date, options = { day: 'numeric', month: 'long', year: 'numeric' }) {
  return new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', ...options }).format(date);
}

export function formatShortDate(date) {
  return formatDate(date, { day: 'numeric', month: 'short' });
}

export function formatNumber(value, digits = 2, extra = {}) {
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, ...extra }).format(value);
}

/** e.g. "−2.4" or "+0.3" with the correct minus sign and decimal comma for German. */
export function formatSigned(value, digits = 1) {
  // Use a real minus sign (−), which is easier to read than a hyphen (-).
  return formatNumber(value, digits, { signDisplay: 'exceptZero' }).replace('-', '\u2212');
}

export function formatKm(km) {
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: 'kilometer', maximumFractionDigits: km < 10 ? 1 : 0 }).format(km);
}

export function formatHectares(ha) {
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: 'hectare', maximumFractionDigits: 1 }).format(ha);
}

export function formatList(items) {
  return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items.map(String));
}
