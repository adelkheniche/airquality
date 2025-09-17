const calendarId = window.GCAL_CALENDAR_ID || 'sji17cho35m52lhecchvsfqn08@group.calendar.google.com';
const API_KEY = window.GCAL_BROWSER_KEY || '';
const TYPE_RULES = [
  { keyword: 'trotec', label: 'trotec' },
  { keyword: 'hpc', label: 'HPC' },
  { keyword: 'ceramique', label: 'céramique' },
];

const THRESHOLDS = {
  pm25: { warning: 15, alert: 35, unit: 'µg/m³', label: 'PM₂.₅' },
  co2: { warning: 1000, alert: 1400, unit: 'ppm', label: 'CO₂' },
};

const TIMEZONE = 'Europe/Paris';
const REFRESH_INTERVAL = 60_000;
const CALENDAR_TTL = 5 * 60_000;
const SERIES_TTL = 5 * 60_000;
const FETCH_TIMEOUT = 5000;

const cell = document.getElementById('cell-activite');
if (!cell) {
  console.warn('[Activité/Risque] cellule introuvable.');
} else {
  init();
}

function init() {
  if (!API_KEY) {
    setCellMessage('N/A', 'error');
    console.warn('[Activité/Risque] Google Calendar API key missing.');
    return;
  }

  cell.classList.add('is-loading');
  cell.dataset.state = 'loading';
  cell.setAttribute('aria-busy', 'true');

  refresh().finally(() => {
    setInterval(() => {
      refresh({ forceSeries: currentState === 'live' });
    }, REFRESH_INTERVAL);
  });
}

let isFetching = false;
let currentState = 'loading';

const calendarCache = { stamp: 0, value: null };
const seriesCache = new Map();

async function refresh({ forceSeries = false } = {}) {
  if (isFetching) return;
  isFetching = true;
  try {
    const now = new Date();
    const events = await fetchCalendarEvents(now, { force: false });
    if (!events.length) {
      setCellMessage('—', 'empty');
      currentState = 'empty';
      return;
    }

    const selected = selectRelevantEvent(events, now);
    if (!selected) {
      setCellMessage('—', 'empty');
      currentState = 'empty';
      return;
    }

    const state = getEventState(selected, now);
    currentState = state;

    let pm25Segment = [];
    let co2Segment = [];
    if (state !== 'upcoming') {
      const [pm25Series, co2Series] = await Promise.all([
        fetchSeries('pm25', { force: forceSeries }),
        fetchSeries('co2', { force: forceSeries }),
      ]);
      const endMs = state === 'live' ? now.getTime() : selected.endMs;
      const startMs = selected.startMs;
      pm25Segment = sliceSeries(pm25Series, startMs, endMs);
      co2Segment = sliceSeries(co2Series, startMs, endMs);
    }

    renderEvent({ event: selected, state, pm25Segment, co2Segment });
  } catch (error) {
    console.error('[Activité/Risque] Échec du rafraîchissement', error);
    setCellMessage('N/A', 'error');
  } finally {
    isFetching = false;
  }
}

function setCellMessage(message, state) {
  cell.classList.remove('is-loading');
  cell.dataset.state = state;
  cell.setAttribute('aria-busy', 'false');
  cell.textContent = message;
}

async function fetchCalendarEvents(now, { force = false } = {}) {
  const stamp = Date.now();
  if (!force && calendarCache.value && stamp - calendarCache.stamp < CALENDAR_TTL) {
    return calendarCache.value;
  }

  const timeMin = new Date(now.getTime() - 12 * 3600_000).toISOString();
  const timeMax = new Date(now.getTime() + 7 * 86400_000).toISOString();
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('key', API_KEY);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) {
    throw new Error(`Calendar request failed (${response.status})`);
  }
  const payload = await response.json();
  const items = Array.isArray(payload.items) ? payload.items : [];
  const events = items
    .filter((item) => item.status === 'confirmed' && item.start?.dateTime && item.end?.dateTime)
    .map((item) => {
      const summary = item.summary || '';
      const mappedType = resolveType(summary);
      return {
        id: item.id,
        title: summary,
        type: mappedType,
        start: item.start.dateTime,
        end: item.end.dateTime,
        startMs: Date.parse(item.start.dateTime),
        endMs: Date.parse(item.end.dateTime),
      };
    })
    .filter((event) => event.type && Number.isFinite(event.startMs) && Number.isFinite(event.endMs));

  calendarCache.value = events;
  calendarCache.stamp = stamp;
  return events;
}

function resolveType(summary) {
  if (typeof summary !== 'string' || !summary.trim()) return null;
  const normalized = normalizeCalendarText(summary);
  if (!/^(resa|reservation)\b/.test(normalized)) {
    return null;
  }
  for (const { keyword, label } of TYPE_RULES) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keywordPattern = new RegExp(`\\b${escaped}\\b`);
    if (keywordPattern.test(normalized)) {
      return label;
    }
  }
  return null;
}

function normalizeCalendarText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function fetchSeries(name, { force = false } = {}) {
  const stamp = Date.now();
  const entry = seriesCache.get(name);
  if (!force && entry && stamp - entry.stamp < SERIES_TTL) {
    return entry.value;
  }

  const url = new URL(`data/${name}.json`, window.location.href);
  if (force) {
    url.searchParams.set('_', String(Date.now()));
  }
  const response = await fetchWithTimeout(url.toString(), {
    cache: force ? 'no-store' : 'default',
  });

  if (!response.ok) {
    if (name === 'co2' && response.status === 404) {
      seriesCache.set(name, { stamp, value: null });
      return null;
    }
    throw new Error(`Failed to load series ${name} (${response.status})`);
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

  seriesCache.set(name, { stamp: Date.now(), value: parsed });
  return parsed;
}

function fetchWithTimeout(resource, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const opts = { ...options, signal: controller.signal };
  return fetch(resource, opts).finally(() => clearTimeout(timer));
}

function selectRelevantEvent(events, now) {
  const nowMs = now.getTime();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.endMs < nowMs) {
      return event;
    }
  }
  return null;
}

function getEventState(event, now) {
  const nowMs = now.getTime();
  if (nowMs < event.startMs) return 'upcoming';
  if (nowMs < event.endMs) return 'live';
  return 'final';
}

function sliceSeries(series, startMs, endMs) {
  if (!Array.isArray(series) || !series.length) return [];
  return series.filter(([ts]) => ts >= startMs && ts <= endMs);
}

function renderEvent({ event, state, pm25Segment, co2Segment }) {
  cell.classList.remove('is-loading');
  cell.setAttribute('aria-busy', 'false');
  cell.dataset.state = state;
  cell.innerHTML = '';

  const row = document.createElement('div');
  row.className = 'activity-risk-row';

  const meta = document.createElement('div');
  meta.className = 'activity-risk-meta';
  const typeEl = document.createElement('span');
  typeEl.className = 'activity-risk-type';
  typeEl.textContent = formatType(event.type);
  if (event.title) {
    typeEl.title = event.title;
  }
  meta.appendChild(typeEl);

  const hoursEl = document.createElement('span');
  hoursEl.className = 'activity-risk-hours';
  hoursEl.textContent = formatRange(event.startMs, event.endMs);
  meta.appendChild(hoursEl);

  const statusEl = document.createElement('span');
  statusEl.className = 'activity-risk-status';
  statusEl.dataset.state = state;
  statusEl.textContent = state === 'upcoming'
    ? 'En attente de mesures'
    : state === 'live'
      ? 'Mesures en cours'
      : 'Mesures terminées';
  meta.appendChild(statusEl);

  row.appendChild(meta);

  const hasPm = Array.isArray(pm25Segment) && pm25Segment.length;
  const hasCo2 = Array.isArray(co2Segment) && co2Segment.length;
  const primarySegment = hasPm ? pm25Segment : co2Segment;
  const primaryMetric = hasPm ? 'pm25' : hasCo2 ? 'co2' : null;
  let statsTooltip = '';

  if (state !== 'upcoming') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'activity-risk-sparkline-btn';
    button.setAttribute('aria-label', 'Voir les mesures détaillées de la période');

    const spark = document.createElement('span');
    spark.className = 'activity-risk-sparkline';
    button.appendChild(spark);

    const hasData = renderSparkline(spark, primarySegment);
    if (!hasData) {
      button.disabled = true;
      button.textContent = 'N/A';
    } else {
      if (primaryMetric === 'co2') {
        button.style.color = '#5E5862';
      }
      button.addEventListener('click', () => {
        openModal({ event, state, pm25Segment, co2Segment });
      });
    }

    if (state === 'final') {
      const pmStats = computeStats(pm25Segment, THRESHOLDS.pm25.alert);
      const co2Stats = computeStats(co2Segment, THRESHOLDS.co2.alert);
      statsTooltip = buildTooltip(pmStats, co2Stats);
      if (statsTooltip) {
        button.title = statsTooltip;
      }
    } else if (state === 'live') {
      button.title = 'Cliquer pour explorer les mesures en direct';
    }

    row.appendChild(button);
  }

  cell.appendChild(row);

  const footnote = document.createElement('p');
  footnote.className = 'activity-risk-footnote';
  if (state === 'upcoming') {
    footnote.textContent = 'L’activité commencera bientôt. Les mesures s’afficheront dès les premières valeurs.';
  } else if (state === 'live') {
    footnote.textContent = 'Actualisation automatique toutes les 60 s. Cliquez pour ouvrir le graphe détaillé.';
  } else {
    footnote.textContent = 'Cliquez sur la sparkline pour consulter le détail des mesures enregistrées.';
    if (statsTooltip) {
      footnote.title = statsTooltip;
    }
  }
  cell.appendChild(footnote);
}

function formatType(type) {
  if (!type) return '—';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatRange(startMs, endMs) {
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  return `${fmt.format(new Date(startMs))}–${fmt.format(new Date(endMs))}`;
}

function renderSparkline(container, series) {
  container.innerHTML = '';
  if (!Array.isArray(series) || !series.length) {
    container.textContent = 'N/A';
    return false;
  }

  const data = downsample(series, 300);
  const values = data.map(([, value]) => value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    container.textContent = 'N/A';
    return false;
  }

  const width = 90;
  const height = 32;
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

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return true;
}

function downsample(series, maxPoints) {
  if (!Array.isArray(series) || series.length <= maxPoints) {
    return Array.isArray(series) ? series.slice() : [];
  }
  const bucketSize = Math.ceil(series.length / maxPoints);
  const result = [];
  for (let i = 0; i < series.length; i += bucketSize) {
    const bucket = series.slice(i, i + bucketSize);
    const last = bucket[bucket.length - 1];
    if (last) result.push(last);
  }
  return result;
}

function computeStats(series, alertThreshold) {
  if (!Array.isArray(series) || !series.length) return null;
  const values = series.map(([, value]) => value).filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const max = Math.max(...values);
  const pct = values.filter((value) => value > alertThreshold).length / values.length * 100;
  return { mean, max, pct };
}

function buildTooltip(pmStats, co2Stats) {
  const parts = [];
  if (pmStats) {
    parts.push(`PM₂.₅ moy ${pmStats.mean.toFixed(1)} ${THRESHOLDS.pm25.unit} · max ${pmStats.max.toFixed(1)} ${THRESHOLDS.pm25.unit} · >${THRESHOLDS.pm25.alert} ${THRESHOLDS.pm25.unit} ${pmStats.pct.toFixed(0)}%`);
  }
  if (co2Stats) {
    parts.push(`CO₂ moy ${co2Stats.mean.toFixed(0)} ${THRESHOLDS.co2.unit} · max ${co2Stats.max.toFixed(0)} ${THRESHOLDS.co2.unit} · >${THRESHOLDS.co2.alert} ${THRESHOLDS.co2.unit} ${co2Stats.pct.toFixed(0)}%`);
  }
  return parts.join('\n');
}

let modalEl = null;
let modalChartEl = null;
let modalTitleEl = null;
let modalSubtitleEl = null;
let modalLegendEl = null;
let modalPlot = null;
let uPlotLoader = null;

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement('div');
  modalEl.className = 'activity-modal';
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-hidden', 'true');
  modalEl.innerHTML = `
    <div class="activity-modal__backdrop" data-dismiss></div>
    <div class="activity-modal__dialog">
      <button type="button" class="activity-modal__close" aria-label="Fermer">×</button>
      <div class="activity-modal__header">
        <h4 class="activity-modal__title"></h4>
        <p class="activity-modal__subtitle"></p>
      </div>
      <div class="activity-modal__chart"></div>
      <div class="activity-modal__legend"></div>
    </div>
  `;
  document.body.appendChild(modalEl);

  modalChartEl = modalEl.querySelector('.activity-modal__chart');
  modalTitleEl = modalEl.querySelector('.activity-modal__title');
  modalSubtitleEl = modalEl.querySelector('.activity-modal__subtitle');
  modalLegendEl = modalEl.querySelector('.activity-modal__legend');

  const closeBtn = modalEl.querySelector('.activity-modal__close');
  const backdrop = modalEl.querySelector('[data-dismiss]');
  closeBtn.addEventListener('click', closeModal);
  backdrop.addEventListener('click', closeModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalEl.classList.contains('is-open')) {
      closeModal();
    }
  });
}

function openModal({ event, state, pm25Segment, co2Segment }) {
  ensureModal();
  modalTitleEl.textContent = `${formatType(event.type)} – ${state === 'live' ? 'En direct' : 'Bilan'}`;
  modalSubtitleEl.textContent = `${formatRange(event.startMs, event.endMs)}`;

  modalLegendEl.innerHTML = '';
  modalChartEl.innerHTML = '';

  const datasets = [];
  if (Array.isArray(pm25Segment) && pm25Segment.length) {
    datasets.push({ key: 'pm25', segment: pm25Segment, config: THRESHOLDS.pm25, color: '#424341' });
  }
  if (Array.isArray(co2Segment) && co2Segment.length) {
    datasets.push({ key: 'co2', segment: co2Segment, config: THRESHOLDS.co2, color: '#5E5862' });
  }

  if (!datasets.length) {
    modalChartEl.innerHTML = '<p style="text-align:center;color:var(--secondary);">Données indisponibles sur ce créneau.</p>';
    modalLegendEl.textContent = '';
  } else {
    const { timestamps, values } = alignSeries(datasets.map((d) => d.segment));
    const totalRange = (timestamps[timestamps.length - 1] || 0) - (timestamps[0] || 0);
    const formatter = createAxisFormatter(totalRange);

    const axes = [
      {
        stroke: 'rgba(84, 88, 88, 0.85)',
        grid: { stroke: 'rgba(84, 88, 88, 0.12)' },
        values: (u, ticks) => ticks.map((tick) => formatter(tick * 1000)),
      },
    ];
    const scales = { x: { time: true } };
    const series = [
      {},
    ];

    datasets.forEach((dataset, index) => {
      const scaleName = dataset.key;
      const axis = {
        scale: scaleName,
        stroke: index === 0 ? 'rgba(66, 67, 65, 0.8)' : 'rgba(94, 88, 98, 0.85)',
        grid: index === 0 ? { stroke: 'rgba(84, 88, 88, 0.08)' } : { show: false },
        values: (u, ticks) => ticks.map((tick) => `${Math.round(tick)}`),
      };
      if (index > 0) axis.side = 1;
      axes.push(axis);
      scales[scaleName] = { auto: true };

      series.push({
        label: dataset.config.label,
        stroke: dataset.color,
        width: 2,
        spanGaps: true,
        scale: scaleName,
        value: (u, value) => (value == null ? '—' : `${value.toFixed(scaleName === 'pm25' ? 1 : 0)} ${dataset.config.unit}`),
      });
    });

    const xValues = timestamps.map((ts) => ts / 1000);
    const data = [xValues, ...values];

    ensureUPlot().then((uPlot) => {
      if (!modalEl.classList.contains('is-open')) return;
      if (modalPlot) {
        modalPlot.destroy();
        modalPlot = null;
      }
      modalChartEl.innerHTML = '';
      const width = modalChartEl.clientWidth || modalChartEl.offsetWidth || 600;
      const height = modalChartEl.clientHeight || 320;
      modalPlot = new uPlot(
        {
          width,
          height,
          scales,
          axes,
          series,
          legend: { show: false },
          cursor: {
            drag: {
              x: true,
              y: false,
            },
          },
        },
        data,
        modalChartEl,
      );
    }).catch((error) => {
      console.error('[Activité/Risque] uPlot load failed', error);
      modalChartEl.innerHTML = '<p style="text-align:center;color:var(--secondary);">Impossible de charger le graphe.</p>';
    });

    modalLegendEl.innerHTML = datasets
      .map((dataset) => {
        const stats = computeStats(dataset.segment, dataset.config.alert);
        const statText = stats
          ? `moy ${formatStatValue(stats.mean, dataset.key)} · max ${formatStatValue(stats.max, dataset.key)} · >${dataset.config.alert} ${dataset.config.unit} ${stats.pct.toFixed(0)}%`
          : '';
        return `<span><i style="background:${dataset.color}"></i>${dataset.config.label}${statText ? ` · ${statText}` : ''}</span>`;
      })
      .join('');
  }

  modalEl.classList.add('is-open');
  modalEl.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  if (!modalEl) return;
  modalEl.classList.remove('is-open');
  modalEl.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (modalPlot) {
    modalPlot.destroy();
    modalPlot = null;
  }
}

function alignSeries(segments) {
  const stamps = new Set();
  segments.forEach((segment) => {
    if (Array.isArray(segment)) {
      segment.forEach(([ts]) => {
        stamps.add(ts);
      });
    }
  });
  const timestamps = Array.from(stamps).sort((a, b) => a - b);
  const values = segments.map((segment) => {
    if (!Array.isArray(segment) || !segment.length) {
      return timestamps.map(() => null);
    }
    const map = new Map(segment.map(([ts, value]) => [ts, value]));
    return timestamps.map((ts) => (map.has(ts) ? map.get(ts) : null));
  });
  return { timestamps, values };
}

function createAxisFormatter(rangeMs) {
  if (rangeMs > 36 * 3600_000) {
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: TIMEZONE,
    });
    return (valueMs) => fmt.format(new Date(valueMs));
  }
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE,
  });
  return (valueMs) => fmt.format(new Date(valueMs));
}

function ensureUPlot() {
  if (window.uPlot) {
    return Promise.resolve(window.uPlot);
  }
  if (!uPlotLoader) {
    uPlotLoader = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://cdn.jsdelivr.net/npm/uplot@1.6.27/dist/uPlot.min.css';
      document.head.appendChild(css);

      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/uplot@1.6.27/dist/uPlot.iife.min.js';
      script.async = true;
      script.onload = () => resolve(window.uPlot);
      script.onerror = () => reject(new Error('uPlot failed to load'));
      document.head.appendChild(script);
    });
  }
  return uPlotLoader;
}

function formatStatValue(value, key) {
  if (!Number.isFinite(value)) return '—';
  if (key === 'pm25') {
    return `${value.toFixed(1)} ${THRESHOLDS.pm25.unit}`;
  }
  return `${Math.round(value)} ${THRESHOLDS.co2.unit}`;
}
