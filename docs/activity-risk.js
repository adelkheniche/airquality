const calendarId = window.GCAL_CALENDAR_ID || 'sji17cho35m52lhecchvsfqn08@group.calendar.google.com';
const API_KEY = window.GCAL_BROWSER_KEY || '';

const TIMEZONE = 'Europe/Paris';
const VALID_RANGES = new Set(['24h', '7j', '30j', 'debut']);
const FETCH_TIMEOUT = 5000;
const EVENTS_TTL = 5 * 60_000;
const PM25_TTL = 8 * 60_000;
const WARN_THRESHOLD = 15;
const ALERT_THRESHOLD = 35;
const PM25_ENDPOINT = '/airquality/data/pm25.json';

const cell = document.getElementById('cell-activite');
if (!cell) {
  console.warn('[Activités → Risque] cellule introuvable.');
} else {
  init();
}

let currentMode = '24h';
let currentBounds = computeWindow(currentMode);
let isRefreshing = false;
let queuedRefresh = null;

const eventsCache = new Map();
let pm25Cache = { stamp: 0, value: null };

function init() {
  if (!API_KEY) {
    setCellMessage('N/A', 'error');
    console.warn('[Activités → Risque] clé Google Calendar manquante.');
    return;
  }

  setupRangeButtons();
  refresh({ forceEvents: true, forceSeries: true });
}

function setupRangeButtons() {
  const buttons = Array.from(document.querySelectorAll('[data-range]'));
  if (!buttons.length) return;

  const validButtons = buttons.filter((btn) => VALID_RANGES.has(btn.dataset.range));
  if (!validButtons.length) return;

  const active = validButtons.find((btn) => btn.classList.contains('active'));
  const initial = active || validButtons[0];
  const initialMode = initial?.dataset.range;
  if (initialMode && VALID_RANGES.has(initialMode)) {
    currentMode = initialMode;
    currentBounds = computeWindow(currentMode);
  }
  setButtonsActive(currentMode);

  validButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.range;
      if (!mode || !VALID_RANGES.has(mode)) return;
      currentMode = mode;
      currentBounds = computeWindow(mode);
      setButtonsActive(mode);
      refresh({ mode, bounds: currentBounds, forceEvents: true });
    });
  });
}

function setButtonsActive(mode) {
  document.querySelectorAll('[data-range]').forEach((btn) => {
    if (btn.dataset.range === mode) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function refresh({ mode = currentMode, bounds, forceEvents = false, forceSeries = false } = {}) {
  const effectiveBounds = Array.isArray(bounds) ? bounds.slice(0, 2) : computeWindow(mode);
  if (!cell) return;

  if (isRefreshing) {
    queuedRefresh = { mode, bounds: effectiveBounds, forceEvents, forceSeries };
    return;
  }

  isRefreshing = true;
  currentMode = mode;
  currentBounds = effectiveBounds;
  showLoading();

  try {
    const [timeMin, timeMax] = effectiveBounds;
    const [events, pm25Series] = await Promise.all([
      fetchCalendarEvents({ timeMin, timeMax, force: forceEvents }),
      fetchPm25Series({ force: forceSeries }),
    ]);
    renderEvents({ events, pm25Series, timeMin, timeMax });
  } catch (error) {
    console.error('[Activités → Risque] rafraîchissement impossible', error);
    setCellMessage('N/A', 'error');
  } finally {
    isRefreshing = false;
    if (queuedRefresh) {
      const next = queuedRefresh;
      queuedRefresh = null;
      refresh(next);
    }
  }
}

function showLoading() {
  cell.classList.add('is-loading');
  cell.dataset.state = 'loading';
  cell.setAttribute('aria-busy', 'true');
  cell.textContent = 'Chargement…';
}

function setCellMessage(message, state) {
  cell.classList.remove('is-loading');
  cell.dataset.state = state;
  cell.setAttribute('aria-busy', 'false');
  cell.textContent = message;
}

async function fetchCalendarEvents({ timeMin, timeMax, force = false } = {}) {
  const cacheKey = `${timeMin}|${timeMax}`;
  const stamp = Date.now();
  const cached = eventsCache.get(cacheKey);
  if (!force && cached && stamp - cached.stamp < EVENTS_TTL) {
    return cached.value;
  }

  let pageToken;
  const collected = [];
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('fields', 'items(id,summary,start,end,status),nextPageToken');
    if (timeMin) url.searchParams.set('timeMin', timeMin);
    if (timeMax) url.searchParams.set('timeMax', timeMax);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('key', API_KEY);

    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) {
      throw new Error(`Calendar request failed (${response.status})`);
    }
    const payload = await response.json();
    const items = Array.isArray(payload.items) ? payload.items : [];

    items.forEach((item) => {
      if (item.status !== 'confirmed') return;
      const start = item.start?.dateTime;
      const end = item.end?.dateTime;
      if (!start || !end) return;
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;

      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      collected.push({
        id: item.id,
        title: summary,
        type: resolveType(summary),
        start,
        end,
        startMs,
        endMs,
      });
    });

    pageToken = payload.nextPageToken;
  } while (pageToken);

  eventsCache.set(cacheKey, { stamp: Date.now(), value: collected });
  return collected;
}

async function fetchPm25Series({ force = false } = {}) {
  const stamp = Date.now();
  if (!force && pm25Cache.value && stamp - pm25Cache.stamp < PM25_TTL) {
    return pm25Cache.value;
  }

  let base = window.location.origin;
  if (!base || base === 'null') {
    base = window.location.href;
  }
  const url = new URL(PM25_ENDPOINT, base);
  if (force) {
    url.searchParams.set('_', String(stamp));
  }

  const response = await fetchWithTimeout(url.toString(), {
    cache: force ? 'no-store' : 'default',
  });
  if (!response.ok) {
    throw new Error(`PM2.5 request failed (${response.status})`);
  }

  const raw = await response.json();
  const parsed = Array.isArray(raw)
    ? raw.reduce((acc, point) => {
        if (!Array.isArray(point) || point.length < 2) return acc;
        const ts = Date.parse(point[0]);
        const value = Number(point[1]);
        if (!Number.isFinite(ts) || !Number.isFinite(value)) return acc;
        acc.push([ts, value]);
        return acc;
      }, [])
    : [];

  parsed.sort((a, b) => a[0] - b[0]);
  pm25Cache = { stamp: Date.now(), value: parsed };
  return parsed;
}

function renderEvents({ events, pm25Series, timeMin, timeMax }) {
  const now = new Date();
  const nowMs = now.getTime();
  const timeMinMs = Date.parse(timeMin);
  const timeMaxMs = Date.parse(timeMax);

  const running = [];
  const finished = [];

  events.forEach((event) => {
    if (!Number.isFinite(event.startMs) || !Number.isFinite(event.endMs)) return;
    if (event.endMs < timeMinMs || event.startMs > timeMaxMs) return;

    if (event.startMs <= nowMs && nowMs < event.endMs && event.startMs >= timeMinMs && event.startMs <= timeMaxMs) {
      running.push({ ...event, state: 'live' });
      return;
    }

    if (event.endMs <= nowMs && event.endMs >= timeMinMs && event.endMs <= timeMaxMs) {
      finished.push({ ...event, state: 'final' });
    }
  });

  running.sort((a, b) => a.endMs - b.endMs);
  finished.sort((a, b) => b.endMs - a.endMs);

  const ordered = [...running, ...finished];
  if (!ordered.length) {
    setCellMessage('—', 'empty');
    return;
  }

  cell.classList.remove('is-loading');
  cell.dataset.state = 'ready';
  cell.setAttribute('aria-busy', 'false');
  cell.innerHTML = '';

  const pmSeries = Array.isArray(pm25Series) ? pm25Series : [];

  ordered.forEach((event) => {
    const row = document.createElement('div');
    row.className = 'activity-risk-row';

    const meta = document.createElement('div');
    meta.className = 'activity-risk-meta';

    const badge = document.createElement('span');
    badge.className = 'activity-risk-type';
    badge.textContent = formatType(event.type);
    meta.appendChild(badge);

    const hours = document.createElement('span');
    hours.className = 'activity-risk-hours';
    hours.textContent = formatRange(event.startMs, event.endMs);
    meta.appendChild(hours);

    const status = document.createElement('span');
    status.className = 'activity-risk-status';
    status.dataset.state = event.state;
    status.textContent = event.state === 'live' ? 'En cours' : 'Terminé';
    meta.appendChild(status);

    row.appendChild(meta);

    const title = document.createElement('span');
    title.className = 'activity-risk-title';
    const displayTitle = event.title || 'Sans titre';
    title.textContent = displayTitle;
    title.title = displayTitle;
    row.appendChild(title);

    const spark = document.createElement('span');
    spark.className = 'activity-risk-sparkline';
    const endCut = Math.min(event.endMs, nowMs);
    const segment = sliceSeries(pmSeries, event.startMs, endCut);
    const stats = computeSnapshot(segment);
    const tooltip = stats ? buildSparklineTitle(stats) : null;
    const hasData = renderSparkline(spark, segment);
    if (tooltip) {
      spark.title = tooltip;
    } else {
      spark.title = 'Aucune mesure disponible';
    }
    if (!hasData) {
      spark.textContent = '—';
    }
    row.appendChild(spark);

    const snapshot = document.createElement('span');
    snapshot.className = 'activity-risk-snapshot';
    if (stats && tooltip) {
      snapshot.textContent = formatSnapshot(stats);
      snapshot.title = tooltip;
    } else {
      snapshot.textContent = 'N/A';
      snapshot.title = 'Aucune mesure disponible';
    }
    row.appendChild(snapshot);

    cell.appendChild(row);
  });
}

function sliceSeries(series, startMs, endMs) {
  if (!Array.isArray(series) || !series.length) return [];
  return series.filter(([ts]) => ts >= startMs && ts < endMs);
}

function computeSnapshot(segment) {
  if (!Array.isArray(segment) || !segment.length) return null;
  const values = segment
    .map(([, value]) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;

  const sum = values.reduce((acc, value) => acc + value, 0);
  const mean = sum / values.length;
  const max = Math.max(...values);
  const warnPct = (values.filter((value) => value > WARN_THRESHOLD).length / values.length) * 100;
  const alertPct = (values.filter((value) => value > ALERT_THRESHOLD).length / values.length) * 100;
  return { mean, max, warnPct, alertPct };
}

function renderSparkline(container, segment) {
  container.innerHTML = '';
  if (!Array.isArray(segment) || !segment.length) {
    return false;
  }

  const data = downsample(segment, 300);
  const values = data.map(([, value]) => Number(value));
  if (!values.length) {
    return false;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return false;
  }

  const width = 72;
  const height = 28;
  const pad = 2;
  const range = max - min;

  const path = data
    .map(([, value], index) => {
      const x = pad + (index * (width - pad * 2)) / Math.max(data.length - 1, 1);
      const ratio = range === 0 ? 0.5 : (value - min) / range;
      const y = height - pad - ratio * (height - pad * 2);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation" aria-hidden="true">
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"></path>
    </svg>
  `;
  return true;
}

function downsample(series, maxPoints) {
  if (!Array.isArray(series) || series.length <= maxPoints) {
    return Array.isArray(series) ? series.slice() : [];
  }
  const stride = Math.ceil(series.length / maxPoints);
  const result = [];
  for (let i = 0; i < series.length; i += stride) {
    result.push(series[i]);
  }
  const last = series[series.length - 1];
  if (result[result.length - 1] !== last) {
    result.push(last);
  }
  return result;
}

function formatSnapshot(stats) {
  return `moy ${stats.mean.toFixed(1)} µg/m³ · max ${stats.max.toFixed(1)} µg/m³ · >15 ${stats.warnPct.toFixed(0)}% · >35 ${stats.alertPct.toFixed(0)}%`;
}

function buildSparklineTitle(stats) {
  return `PM₂.₅ moy ${stats.mean.toFixed(1)} µg/m³ · max ${stats.max.toFixed(1)} µg/m³ · >15 µg/m³ ${stats.warnPct.toFixed(0)}% · >35 µg/m³ ${stats.alertPct.toFixed(0)}%`;
}

function formatType(type) {
  switch (type) {
    case 'laser':
      return 'Laser';
    case 'ouverture':
      return 'Ouverture';
    case 'fermeture':
      return 'Fermeture';
    default:
      return 'Autre';
  }
}

function formatRange(startMs, endMs) {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  return `${formatter.format(new Date(startMs))}–${formatter.format(new Date(endMs))}`;
}

function resolveType(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return 'autre';
  const normalized = normalize(summary);
  const simplified = normalized.replace(/[-_]+/g, ' ');
  const collapsed = simplified.replace(/\s+/g, ' ');
  if (/\b(trotec|lasersaur)\b/.test(collapsed)) return 'laser';
  if (/open\s*lab/.test(collapsed) || simplified.includes('openlab')) return 'ouverture';
  if (collapsed.includes('lab ferme')) return 'fermeture';
  return 'autre';
}

function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function computeWindow(mode) {
  const endISO = endOfTodayParisISO();
  const endMs = Date.parse(endISO);
  const day = 86400e3;
  if (mode === 'debut') {
    return [septFirstParisISO(), endISO];
  }
  const span = mode === '24h' ? day : mode === '7j' ? 7 * day : 30 * day;
  return [new Date(endMs - span).toISOString(), endISO];
}

function endOfTodayParisISO() {
  const nowParis = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const endParis = new Date(
    nowParis.getFullYear(),
    nowParis.getMonth(),
    nowParis.getDate(),
    23,
    59,
    59,
    0,
  );
  return new Date(endParis.getTime() - endParis.getTimezoneOffset() * 60000).toISOString();
}

function septFirstParisISO() {
  const nowParis = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const startParis = new Date(nowParis.getFullYear(), 8, 1, 0, 0, 0, 0);
  return new Date(startParis.getTime() - startParis.getTimezoneOffset() * 60000).toISOString();
}

function fetchWithTimeout(resource, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const opts = { ...options, signal: controller.signal };
  return fetch(resource, opts).finally(() => clearTimeout(timer));
}
