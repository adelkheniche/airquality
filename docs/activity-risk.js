const TIMEZONE = 'Europe/Paris';
const VALID_RANGES = new Set(['24h', '7j', '30j', 'debut']);
const FETCH_TIMEOUT = 5000;
const CACHE_TTL = 60_000;

const SUPABASE_URL = (window.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (window.SUPABASE_ANON_KEY || '').trim();

const cell = document.getElementById('cell-activite');

if (!cell) {
  console.warn('[Activités → Risque] cellule introuvable.');
} else if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[Activités → Risque] configuration Supabase manquante.');
  setCellState('N/A', 'error');
} else {
  init();
}

let currentRange = '24h';
let isFetching = false;
let pendingRequest = null;
let activeEventId = null;
const rowsRegistry = new Map();
const activitiesCache = new Map();

function init() {
  setupRangeButtons();
  window.addEventListener('aq:highlight', handleExternalHighlight);
  refresh({ range: currentRange, force: true });
}

function setupRangeButtons() {
  const buttons = Array.from(document.querySelectorAll('[data-range]'));
  if (!buttons.length) return;

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.range;
      if (!range || !VALID_RANGES.has(range)) return;
      refresh({ range });
    });
  });
}

async function refresh({ range = currentRange, force = false } = {}) {
  if (!cell) return;
  const targetRange = VALID_RANGES.has(range) ? range : currentRange;

  if (isFetching) {
    pendingRequest = { range: targetRange, force };
    return;
  }

  isFetching = true;
  currentRange = targetRange;
  showLoading();

  try {
    const activities = await loadActivities(targetRange, { force });
    renderActivities(activities);
  } catch (error) {
    console.error('[Activités → Risque] impossible de charger les activités', error);
    setCellState('N/A', 'error');
  } finally {
    isFetching = false;
    if (pendingRequest) {
      const next = pendingRequest;
      pendingRequest = null;
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

function setCellState(message, state) {
  cell.classList.remove('is-loading');
  cell.dataset.state = state;
  cell.setAttribute('aria-busy', 'false');
  cell.textContent = message;
}

async function loadActivities(range, { force = false } = {}) {
  const cacheEntry = activitiesCache.get(range);
  const now = Date.now();
  if (!force && cacheEntry && now - cacheEntry.stamp < CACHE_TTL) {
    return cacheEntry.value;
  }

  const rpcUrl = new URL(`/rest/v1/rpc/activities_site`, SUPABASE_URL);
  const response = await fetchWithTimeout(rpcUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ range }),
  });

  if (!response.ok) {
    throw new Error(`RPC activities_site failed (${response.status})`);
  }

  const payload = await response.json();
  const activities = Array.isArray(payload) ? payload : [];
  activitiesCache.set(range, { stamp: now, value: activities });
  return activities;
}

function renderActivities(list) {
  rowsRegistry.clear();

  const activities = Array.isArray(list) ? list : [];
  if (!activities.length) {
    setCellState('—', 'empty');
    return;
  }

  const nowMs = Date.now();
  const running = [];
  const finished = [];

  activities.forEach((activity) => {
    const startMs = Date.parse(activity.start);
    const endMs = Date.parse(activity.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
    const entry = { ...activity, startMs, endMs };
    if (startMs <= nowMs && nowMs <= endMs) {
      running.push(entry);
    } else if (endMs < nowMs) {
      finished.push(entry);
    }
  });

  running.sort((a, b) => a.startMs - b.startMs);
  finished.sort((a, b) => b.endMs - a.endMs);
  const ordered = [...running, ...finished];

  if (!ordered.length) {
    setCellState('—', 'empty');
    return;
  }

  cell.classList.remove('is-loading');
  cell.dataset.state = 'ready';
  cell.setAttribute('aria-busy', 'false');
  cell.innerHTML = '';

  ordered.forEach((activity) => {
    const row = buildRow(activity);
    rowsRegistry.set(String(activity.event_id), row);
    cell.appendChild(row);
  });

  syncActiveState();
}

function buildRow(activity) {
  const row = document.createElement('div');
  row.className = 'activity-risk-row';
  row.dataset.eventId = String(activity.event_id);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');

  const type = document.createElement('span');
  type.className = 'activity-risk-type';
  type.textContent = formatType(activity.type);
  row.appendChild(type);

  const hours = document.createElement('span');
  hours.className = 'activity-risk-hours';
  const hoursLabel = formatHours(activity.startMs, activity.endMs);
  hours.textContent = hoursLabel;
  row.appendChild(hours);

  const title = document.createElement('span');
  title.className = 'activity-risk-title';
  const titleText = formatTitle(activity);
  title.textContent = titleText;
  title.title = titleText;
  row.appendChild(title);

  const spark = document.createElement('span');
  spark.className = 'activity-risk-sparkline';
  spark.style.cursor = 'pointer';

  const stats = normalizeStats(activity.pm25);
  const tooltip = buildSparklineTooltip(stats, hoursLabel);
  if (tooltip) {
    spark.title = tooltip;
  }
  spark.setAttribute('aria-label', buildSparklineAria(stats));

  const hasSeries = renderSparkline(spark, activity.pm25?.points_sample);
  if (!hasSeries) {
    spark.textContent = '—';
  }

  spark.addEventListener('click', (event) => {
    event.stopPropagation();
    activateRow(activity, { scroll: true });
  });

  row.appendChild(spark);

  row.addEventListener('click', () => activateRow(activity, { scroll: true }));
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateRow(activity, { scroll: true });
    }
  });

  return row;
}

function activateRow(activity, { scroll = false } = {}) {
  const eventId = String(activity.event_id);
  activeEventId = eventId;
  syncActiveState();
  dispatchHighlight(activity, { scroll });
}

function syncActiveState() {
  rowsRegistry.forEach((row, id) => {
    const isActive = activeEventId != null && id === activeEventId;
    row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    row.classList.toggle('is-active', isActive);
  });
}

function dispatchHighlight(activity, { scroll = false } = {}) {
  if (!activity) return;
  const detail = {
    eventId: activity.event_id,
    start: activity.start,
    end: activity.end,
    title: activity.title,
    person: activity.person,
    type: activity.type,
    machine: activity.machine,
    source: 'activity-cell',
    scroll,
  };
  window.dispatchEvent(new CustomEvent('aq:highlight', { detail }));
}

function handleExternalHighlight(event) {
  const eventId = event?.detail?.eventId;
  activeEventId = eventId != null ? String(eventId) : null;
  syncActiveState();
}

function formatType(type) {
  if (!type) return 'Autre';
  return String(type).trim();
}

function formatHours(startMs, endMs) {
  const formatter = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  return `${formatter.format(new Date(startMs))}–${formatter.format(new Date(endMs))}`;
}

function formatTitle(activity) {
  const title = typeof activity.title === 'string' && activity.title.trim()
    ? activity.title.trim()
    : 'Sans titre';
  const person = typeof activity.person === 'string' && activity.person.trim()
    ? activity.person.trim()
    : '';
  return person ? `${title} · ${person}` : title;
}

function normalizeStats(stats) {
  if (!stats || typeof stats !== 'object') {
    return {
      mean: null,
      max: null,
      pct15: null,
      pct35: null,
    };
  }
  return {
    mean: toNumber(stats.mean),
    max: toNumber(stats.max),
    pct15: toNumber(stats.pct_over_15),
    pct35: toNumber(stats.pct_over_35),
  };
}

function buildSparklineTooltip(stats, hoursLabel) {
  if (!stats) return '';
  const mean = formatNumber(stats.mean);
  const max = formatNumber(stats.max);
  const pct15 = formatPercent(stats.pct15);
  const pct35 = formatPercent(stats.pct35);
  return `${hoursLabel} · PM₂.₅ moy ${mean} µg/m³ · max ${max} µg/m³ · >15 µg/m³ ${pct15} · >35 µg/m³ ${pct35}`;
}

function buildSparklineAria(stats) {
  if (!stats) {
    return 'PM2.5 données indisponibles';
  }
  const mean = formatNumber(stats.mean);
  const max = formatNumber(stats.max);
  const pct15 = formatPercent(stats.pct15);
  const pct35 = formatPercent(stats.pct35);
  return `PM2.5 ${mean} µg/m³, max ${max} µg/m³, >15: ${pct15} (>35: ${pct35})`;
}

function renderSparkline(container, series) {
  container.innerHTML = '';
  const normalized = normalizeSeries(series);
  if (!normalized.length) {
    return false;
  }

  const width = 72;
  const height = 24;
  const pad = 2;
  const min = Math.min(...normalized);
  const max = Math.max(...normalized);
  const range = max - min;

  const points = normalized.map((value, index) => {
    const x = pad + (index * (width - pad * 2)) / Math.max(normalized.length - 1, 1);
    const ratio = range === 0 ? 0.5 : (value - min) / range;
    const y = height - pad - ratio * (height - pad * 2);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const path = points.join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'presentation');
  svg.setAttribute('aria-hidden', 'true');

  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', path);
  pathEl.setAttribute('fill', 'none');
  pathEl.setAttribute('stroke', 'currentColor');
  pathEl.setAttribute('stroke-width', '1');
  pathEl.setAttribute('stroke-linejoin', 'round');
  pathEl.setAttribute('stroke-linecap', 'round');

  svg.appendChild(pathEl);
  container.appendChild(svg);
  return true;
}

function normalizeSeries(series) {
  if (!Array.isArray(series)) return [];
  const values = [];
  series.forEach((point) => {
    if (Array.isArray(point)) {
      const value = toNumber(point[1]);
      if (Number.isFinite(value)) values.push(value);
      return;
    }
    if (point && typeof point === 'object') {
      const value = toNumber(point.value ?? point.pm25 ?? point.y ?? point[1]);
      if (Number.isFinite(value)) values.push(value);
      return;
    }
    const value = toNumber(point);
    if (Number.isFinite(value)) values.push(value);
  });
  return values;
}

function toNumber(value) {
  const num = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(num) ? num : null;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(1);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '—%';
  return `${Math.round(value)}%`;
}

function fetchWithTimeout(resource, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const opts = { ...options, signal: controller.signal };
  return fetch(resource, opts).finally(() => clearTimeout(timer));
}
