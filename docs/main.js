/* globals supabase, dayjs, Plotly, window, document */

const COLORS = {
  pm25: '#424341', // accent profond et contrasté pour le PM2.5
  pm10: '#AFA9B4', // lavande sourde pour le PM10
  pm1:  '#AAAFAF', // gris doux pour distinguer le PM1
  grid: '#C3C8C8',
  text: '#424341'
};

const WHO_LINE = 15; // µg/m³

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const HIGHLIGHT_FILL = 'rgba(255, 59, 48, 0.18)';
const HIGHLIGHT_BORDER = 'rgba(255, 59, 48, 0.8)';
const ACTIVITIES_CACHE_TTL = 60 * 1000;
const activitiesCache = Object.create(null);
let highlightDetail = null;
let activitiesActiveId = null;
let activitiesRequestToken = 0;

window.addEventListener('aq:highlight', (event) => {
  const normalized = normalizeHighlightDetail(event?.detail);
  highlightDetail = normalized;
  setActiveActivityRow(event?.detail?.eventId ?? null);
  applyChartHighlight();
});

// Limitation de la fréquence des requêtes
const MIN_INTERVAL_MS = 2 * 60 * 1000;   // ≤ 30 appels/h en exploration
const PASSIVE_INTERVAL_MS = 4 * 60 * 1000; // ≈15 appels/h en affichage passif
let lastReload = 0;

async function readingsExtent() {
  const { data, error } = await sb.rpc('readings_extent');
  if (error) throw error;
  // Supabase renvoie un array d'une ligne { min_ts, max_ts }
  const row = Array.isArray(data) ? data[0] : data;
  return { min: row.min_ts, max: row.max_ts };
}

async function series(startISO, endISO) {
  const pageSize = 1000;
  let from = 0;
  let results = [];
  while (true) {
    const { data, error } = await sb
      .from('readings')
      .select('ts, pm1, pm25, pm10')
      .gte('ts', startISO)
      .lte('ts', endISO)
      .order('ts')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    results = results.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return results;
}

async function kpis(startISO, endISO) {
  const { data, error } = await sb.rpc('kpis_peaks_range', {
    start_ts: startISO, end_ts: endISO
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    total: Number(row?.total_peaks ?? 0),
    pph:   Number(row?.peaks_per_hour ?? 0),
    pct:   Number(row?.percent_over15 ?? 0)
  };
}

async function peaksList(startISO, endISO) {
  const { data, error } = await sb.rpc('peaks_in_range', {
    start_ts: startISO, end_ts: endISO
  });
  if (error) throw error;
  return data || [];
}

/* ---------- helpers ---------- */

function formatKpiValue(value) {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : '–';
  }
  const str = String(value);
  const trimmed = str.trim();
  return trimmed.length ? trimmed : '–';
}

function setKpiValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = formatKpiValue(value);
}

function toParisISO(d) {
  // d = JS Date or ISO; we just pass through, RPC expects UTC ISO.
  // Inputs are already in local -> we create ISO UTC from date inputs.
  return new Date(d).toISOString();
}

function classifyPm25Severity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 12) return 'good';
  if (numeric < 15) return 'warn';
  return 'risk';
}

function applySeverityDataset(el, severity) {
  if (!el) return;
  if (severity) {
    el.dataset.severity = severity;
  } else {
    delete el.dataset.severity;
  }
}

function setPctPill(pct) {
  const pctPill = document.getElementById('kpi-pct-pill');
  const pctIcon = document.getElementById('kpi-pct-icon');
  let state = 'ok';
  if (pct > 20) {
    state = 'risk';
  } else if (pct > 10) {
    state = 'warn';
  } else {
    state = 'ok';
  }
  if (pctPill) {
    if (state === 'risk') {
      pctPill.className = 'status-pill status-pill--risk';
      pctPill.textContent = 'À risque';
    } else if (state === 'warn') {
      pctPill.className = 'status-pill status-pill--warn';
      pctPill.textContent = 'À surveiller';
    } else {
      pctPill.className = 'status-pill status-pill--ok';
      pctPill.textContent = 'OK';
    }
    pctPill.dataset.state = state;
  }
  if (pctIcon) {
    pctIcon.dataset.state = state;
  }
}

function chip(text) {
  const el = document.createElement('span');
  el.className = 'chip';
  el.textContent = text;
  return el;
}

function renderSummary(id, serie) {
  const wrap = document.getElementById(id);
  wrap.innerHTML = '';
  if (!serie.length) {
    wrap.appendChild(chip('Données insuffisantes'));
    return;
  }
  const above = serie.filter(r => (r.pm25 ?? 0) > WHO_LINE).length;
  const max25 = Math.max(...serie.map(r => r.pm25 ?? 0));
  wrap.appendChild(chip(`Pics au-dessus du seuil : ${above}`));
  wrap.appendChild(chip(`PM₂.₅ maximum : ${Math.round(max25)} µg/m³`));
}

function updateKpiCards(stats) {
  const totalRaw = Number(stats?.total);
  const pctRaw = Number(stats?.pct);
  const totalValue = Number.isFinite(totalRaw) ? Math.round(totalRaw).toString() : '–';
  const pctValue = Number.isFinite(pctRaw) ? `${Math.round(pctRaw)}%` : '–';
  setKpiValue('kpi-peaks', totalValue);
  setKpiValue('kpi-pct', pctValue);
  setPctPill(Number.isFinite(pctRaw) ? pctRaw : 0);
}

function renderPeaksList(peaks, tz = 'Europe/Paris') {
  const ul = document.getElementById('list-peaks');
  if (!ul) return;
  ul.innerHTML = '';
  (peaks || []).forEach(p => {
    const li = document.createElement('li');
    const when = fmtTs(p.ts);
    const iso = dayjs(p.ts).tz(tz).format();
    li.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <time datetime="${iso}" class="tabular-nums">${when}</time>
      <span class="value tabular-nums">${Math.round(p.value || 0)} µg/m³</span>
    `;
    ul.appendChild(li);
  });
}

function plotOne(containerId, serie, title, xRange) {
  const x = serie.map(r => {
    const ts = r.ts || r.t || r.time || r.date || r['ts'];
    return dayjs(ts).tz('Europe/Paris').format();
  });
  const y1 = serie.map(r => r.pm1  != null ? Math.round(r.pm1)  : null);
  const y25= serie.map(r => r.pm25 != null ? Math.round(r.pm25) : null);
  const y10= serie.map(r => r.pm10 != null ? Math.round(r.pm10) : null);

  const traces = [
    { name:'PM₂.₅', x, y: y25, mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm25 } },
    { name:'PM₁₀',  x, y: y10, mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm10 } },
    { name:'PM₁',   x, y: y1,  mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm1  } },
  ];

  const allVals = [...y1, ...y25, ...y10].filter(v => v != null);
  const ymax = allVals.length
    ? Math.max(WHO_LINE, Math.ceil(Math.max(...allVals) / 5) * 5)
    : WHO_LINE;

  const layout = {
    title: { text:title, font:{ size:14 } },
    margin:{ t:48, r:24, b:36, l:48 },
    xaxis:{ showgrid:true, gridcolor:COLORS.grid },
    yaxis:{ showgrid:true, gridcolor:COLORS.grid, title:'µg/m³', range:[0, ymax], fixedrange:true },
    legend:{ orientation:'h', x:0, xanchor:'left', y:1.2 },
    shapes: [
      { type:'line', xref:'paper', x0:0, x1:1, y0:WHO_LINE, y1:WHO_LINE,
        line:{ dash:'dash', width:1, color:'#545858' } },
      { type:'rect', xref:'paper', x0:0, x1:1, y0:WHO_LINE, y1:ymax,
        fillcolor:COLORS.pm25, opacity:0.06, line:{ width:0 } }
    ]
  };

  if (xRange) {
    layout.xaxis.range = xRange;
  }

  const config = {
    displaylogo:false,
    responsive:true,
    modeBarButtons:[
      ['zoom2d', 'pan2d', 'zoomIn2d', 'zoomOut2d', 'resetScale2d']
    ],
    scrollZoom:true
  };

  const container = document.getElementById(containerId);
  if (!container) return;

  // remember initial max for reset
  container._initialYMax = ymax;

  Plotly.react(container, traces, layout, config);

  if (container.layout && Array.isArray(container.layout.shapes)) {
    container._baseShapes = cloneShapes(container.layout.shapes);
  }
  applyChartHighlight();

  // Adjust Y-axis on zoom/pan to fit visible data with 10% headroom
  if (container.removeAllListeners) container.removeAllListeners('plotly_relayout');
  container.on('plotly_relayout', ev => {
    // Reset to initial scale when autoranging (double click or reset button)
    if (ev['xaxis.autorange']) {
      Plotly.relayout(container, { 'yaxis.range': [0, container._initialYMax] });
      return;
    }

    // Only recompute when x-range changed
    if (ev['xaxis.range[0]'] !== undefined || ev['xaxis.range'] !== undefined) {
      const range = container.layout?.xaxis?.range;
      if (!range) return;
      const [x0, x1] = range.map(d => new Date(d).getTime());
      const ys = [];
      container.data.forEach(trace => {
        trace.x.forEach((xVal, i) => {
          const t = new Date(xVal).getTime();
          if (t >= x0 && t <= x1) {
            const yVal = trace.y[i];
            if (yVal != null) ys.push(yVal);
          }
        });
      });
      const max = ys.length ? Math.max(...ys) : container._initialYMax;
      const padded = Math.max(WHO_LINE, Math.ceil((max * 1.1) / 5) * 5);
      Plotly.relayout(container, { 'yaxis.range': [0, padded] });
    }
  });
}

function normalizeHighlightDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const startMs = Date.parse(detail.start);
  const endMs = Date.parse(detail.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs === endMs) return null;
  const start = new Date(Math.min(startMs, endMs));
  const end = new Date(Math.max(startMs, endMs));
  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

function applyChartHighlight() {
  const container = document.getElementById('chart-main');
  if (!container || !container.layout) return;

  const baseShapes = Array.isArray(container._baseShapes)
    ? cloneShapes(container._baseShapes)
    : cloneShapes(container.layout.shapes || []);
  container._baseShapes = baseShapes;

  const shapes = cloneShapes(baseShapes);
  if (highlightDetail) {
    shapes.push({
      type: 'rect',
      xref: 'x',
      yref: 'paper',
      x0: highlightDetail.startISO,
      x1: highlightDetail.endISO,
      y0: 0,
      y1: 1,
      fillcolor: HIGHLIGHT_FILL,
      line: { color: HIGHLIGHT_BORDER, width: 1 },
      opacity: 1,
      layer: 'above',
    });
  }

  Plotly.relayout(container, { shapes });
}

function cloneShapes(shapes = []) {
  return shapes.map((shape) => JSON.parse(JSON.stringify(shape)));
}

function setActiveActivityRow(eventId) {
  const normalizedId = eventId != null ? String(eventId) : null;
  activitiesActiveId = normalizedId;
  const rows = document.querySelectorAll('#cell-activite [data-event-id]');
  rows.forEach((row) => {
    const isActive = normalizedId != null && row.dataset.eventId === normalizedId;
    row.classList.toggle('is-active', isActive);
    row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

async function loadActivitiesForRange(range, { preferCache = true } = {}) {
  const container = document.getElementById('cell-activite');
  if (!container || !range) return;

  const cached = preferCache ? getCachedActivities(range) : null;
  if (cached) {
    renderActivitiesList(cached);
    return;
  }

  const token = ++activitiesRequestToken;
  container.textContent = 'Chargement…';

  try {
    const data = await fetchActivities(range);
    if (token !== activitiesRequestToken) {
      return;
    }
    activitiesCache[range] = { timestamp: Date.now(), data };
    renderActivitiesList(data);
  } catch (error) {
    if (token !== activitiesRequestToken) {
      return;
    }
    console.error('Impossible de charger les activités :', error);
    container.textContent = 'N/A';
  }
}

function getCachedActivities(range) {
  const entry = activitiesCache[range];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ACTIVITIES_CACHE_TTL) {
    return null;
  }
  return entry.data;
}

async function fetchActivities(range) {
  const url = `${window.SUPABASE_URL}/rest/v1/rpc/app.activities_site`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: window.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${window.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ range }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function renderActivitiesList(events) {
  const container = document.getElementById('cell-activite');
  if (!container) return;

  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'activities-list';

  const sorted = sortActivities(events || []);
  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'activities-message';
    empty.textContent = 'Aucune activité sur la période.';
    container.appendChild(empty);
    setActiveActivityRow(null);
    return;
  }

  const ids = new Set(
    sorted
      .map(evt => evt?.event_id ?? evt?.eventId)
      .filter(id => id != null)
      .map(id => String(id))
  );
  if (activitiesActiveId != null && !ids.has(activitiesActiveId)) {
    activitiesActiveId = null;
  }

  sorted.forEach(evt => {
    const row = createActivityRow(evt);
    list.appendChild(row);
  });

  container.appendChild(list);
  setActiveActivityRow(activitiesActiveId);
}

function sortActivities(events) {
  const now = dayjs();
  const ongoing = [];
  const finished = [];

  (events || []).forEach(evt => {
    const end = dayjs(evt?.end);
    if (end.isValid() && end.isAfter(now)) {
      ongoing.push(evt);
    } else if (!end.isValid()) {
      ongoing.push(evt);
    } else {
      finished.push(evt);
    }
  });

  ongoing.sort((a, b) => dayjs(a?.start).valueOf() - dayjs(b?.start).valueOf());
  finished.sort((a, b) => dayjs(b?.end).valueOf() - dayjs(a?.end).valueOf());

  return ongoing.concat(finished);
}

function createActivityRow(evt) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'activity-row';

  const eventIdRaw = evt?.event_id ?? evt?.eventId;
  if (eventIdRaw != null) {
    row.dataset.eventId = String(eventIdRaw);
  } else {
    delete row.dataset.eventId;
  }
  row.setAttribute('aria-pressed', 'false');

  const badge = document.createElement('span');
  badge.className = 'activity-badge';
  badge.textContent = (evt?.type || 'Activité').toString();

  const time = document.createElement('span');
  time.className = 'activity-time tabular-nums';
  time.textContent = formatActivityTimeRange(evt?.start, evt?.end);

  const titleWrap = document.createElement('span');
  titleWrap.className = 'activity-title';
  titleWrap.textContent = evt?.title || 'Sans titre';
  if (evt?.person) {
    const person = document.createElement('span');
    person.className = 'activity-person';
    person.textContent = `• ${evt.person}`;
    titleWrap.appendChild(person);
  }

  const sparklineWrap = document.createElement('span');
  sparklineWrap.className = 'activity-sparkline';

  const timeLabel = buildActivityTimeLabel(evt?.start, evt?.end);
  const pm25 = evt?.pm25 || {};
  const points = Array.isArray(pm25.points_sample)
    ? pm25.points_sample.map(Number).filter(v => Number.isFinite(v))
    : [];

  if (points.length) {
    const svg = createSparkline(points, pm25, timeLabel);
    sparklineWrap.appendChild(svg);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'activity-sparkline-placeholder activity-sparkline--empty';
    placeholder.textContent = '—';
    const aria = buildSparklineLabel(pm25, timeLabel);
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', aria);
    placeholder.title = aria;
    sparklineWrap.appendChild(placeholder);
  }

  const handleSelect = () => {
    if (eventIdRaw == null) return;
    const detail = {
      eventId: eventIdRaw,
      start: evt?.start,
      end: evt?.end,
      title: evt?.title,
      person: evt?.person,
      type: evt?.type,
      machine: evt?.machine,
    };
    activitiesActiveId = String(eventIdRaw);
    setActiveActivityRow(eventIdRaw);
    window.dispatchEvent(new CustomEvent('aq:highlight', { detail }));
    const chart = document.getElementById('chart-main');
    if (chart && typeof chart.scrollIntoView === 'function') {
      chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  row.addEventListener('click', handleSelect);

  row.appendChild(badge);
  row.appendChild(time);
  row.appendChild(titleWrap);
  row.appendChild(sparklineWrap);

  return row;
}

function buildActivityTimeLabel(start, end) {
  const range = formatActivityTimeRange(start, end);
  return range === '—' ? 'Heures inconnues' : `${range} (Europe/Paris)`;
}

const NUMBER_FORMAT_1 = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const NUMBER_FORMAT_0 = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function buildSparklineLabel(pm25 = {}, timeLabel = '') {
  const mean = formatNumberForLabel(pm25.mean, NUMBER_FORMAT_1);
  const max = formatNumberForLabel(pm25.max, NUMBER_FORMAT_1);
  const pct15 = formatNumberForLabel(pm25.pct_over_15, NUMBER_FORMAT_0);
  const pct35 = formatNumberForLabel(pm25.pct_over_35, NUMBER_FORMAT_0);
  const timePart = timeLabel ? `, fenêtre ${timeLabel}` : '';
  return `PM2.5 ${mean} µg/m³, max ${max}, >15 : ${pct15}% (>35 : ${pct35}%)${timePart}`;
}

function formatNumberForLabel(value, formatter) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return formatter.format(numeric);
}

function createSparkline(points, pm25, timeLabel) {
  const width = 72;
  const height = 24;
  const values = points.length > 1 ? points : points.concat(points);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'activity-sparkline-svg');
  svg.setAttribute('role', 'img');

  const aria = buildSparklineLabel(pm25, timeLabel);
  svg.setAttribute('aria-label', aria);
  svg.setAttribute('title', aria);

  const titleEl = document.createElementNS(svgNS, 'title');
  titleEl.textContent = aria;
  svg.appendChild(titleEl);

  const pathData = values.map((val, index) => {
    const x = index * step;
    const ratio = range === 0 ? 0.5 : (val - min) / range;
    const y = height - (ratio * (height - 4) + 2);
    const cmd = index === 0 ? 'M' : 'L';
    return `${cmd}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', COLORS.pm25);
  path.setAttribute('stroke-width', '1');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  svg.appendChild(path);
  return svg;
}

function formatActivityTimeRange(startISO, endISO) {
  const start = dayjs(startISO).tz('Europe/Paris');
  const end = dayjs(endISO).tz('Europe/Paris');
  const startValid = start.isValid();
  const endValid = end.isValid();

  if (!startValid && !endValid) return '—';
  const startStr = startValid ? start.format('HH:mm') : '—';
  const endStr = endValid ? end.format('HH:mm') : '—';
  return `${startStr}–${endStr}`;
}

const RANGE_TITLES = {
  '24h': 'Aujourd’hui (24 h)',
  '7j': '7 jours',
  '30j': '30 jours',
  'debut': 'Depuis le début'
};
let currentRange = '24h';
const DATASETS = {};

function setActiveRange(range) {
  document.querySelectorAll('[data-range]').forEach(btn => {
    if (btn.dataset.range === range) {
      btn.classList.add('tw-btn-primary');
      btn.classList.remove('tw-btn-outline');
      btn.classList.add('active');
    } else {
      btn.classList.add('tw-btn-outline');
      btn.classList.remove('tw-btn-primary');
      btn.classList.remove('active');
    }
  });
}

function plotRange(range) {
  const ds = DATASETS[range];
  if (!ds) return;
  currentRange = range;
  setActiveRange(range);
  document.getElementById('chart-title').textContent = RANGE_TITLES[range];
  renderSummary('chart-summary', ds.data);
  updateKpiCards(ds.kpis);
  renderPeaksList(ds.peaks);

  const drawChart = () => {
    plotOne('chart-main', ds.data, '', ds.xRange);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(drawChart);
  } else {
    setTimeout(drawChart, 0);
  }
}

function handleRangeChange(range) {
  plotRange(range);
  loadActivitiesForRange(range);
}

/* ---------- main flow ---------- */

async function loadAll() {
  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => handleRangeChange(btn.dataset.range));
  });
  setActiveRange(currentRange);

  await reloadDashboard();
  // Allow an immediate manual refresh by backdating lastReload
  lastReload = Date.now() - MIN_INTERVAL_MS;
}

async function reloadDashboard() {
  const tz = 'Europe/Paris';
  const extent = await readingsExtent();
  if (!extent || !extent.max) {
    console.warn('Étendue de données indisponible, impossible de définir la période par défaut.');
    return;
  }
  const earliest = dayjs(extent.min ?? extent.max).utc();
  const latest = dayjs(extent.max).utc();
  const clampStart = candidate => (candidate.isBefore(earliest) ? earliest : candidate);

  const rangeBounds = {
    '24h': { start: clampStart(latest.subtract(24, 'hour')), end: latest },
    '7j':  { start: clampStart(latest.subtract(7, 'day')),  end: latest },
    '30j': { start: clampStart(latest.subtract(30, 'day')), end: latest },
    'debut': { start: earliest, end: latest }
  };

  const entries = await Promise.all(
    Object.entries(rangeBounds).map(async ([range, bounds]) => {
      const startISO = bounds.start.toISOString();
      const endISO = bounds.end.toISOString();
      const [serie, kpiData, peaksData] = await Promise.all([
        series(startISO, endISO),
        kpis(startISO, endISO),
        peaksList(startISO, endISO)
      ]);
      const sortedPeaks = (peaksData || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
      return [range, {
        data: serie,
        xRange: [bounds.start.tz(tz).format(), bounds.end.tz(tz).format()],
        kpis: kpiData,
        peaks: sortedPeaks,
        rangeStartISO: startISO,
        rangeEndISO: endISO,
      }];
    })
  );

  Object.keys(DATASETS).forEach(key => { delete DATASETS[key]; });
  entries.forEach(([range, ds]) => { DATASETS[range] = ds; });

  const s24 = DATASETS['24h']?.data ?? [];
  const lastVal = s24[s24.length - 1];
  const prevVal = s24[s24.length - 2];
  const timeEl = document.getElementById('kpi-last-time');
  const arrowEl = document.getElementById('kpi-last-arrow');
  const valueEl = document.getElementById('kpi-last');

  if (lastVal) {
    const val = lastVal.pm25 != null ? Math.round(lastVal.pm25) : null;
    const displayVal = val != null ? val.toString() : '–';
    setKpiValue('kpi-last', displayVal);
    applySeverityDataset(valueEl, classifyPm25Severity(lastVal.pm25));
    const measuredAt = dayjs(lastVal.ts).tz(tz);
    const measuredAtStr = measuredAt.format('HH:mm').replace(':', ' h ');
    if (timeEl) timeEl.textContent = `µg/m³ à ${measuredAtStr}`;

    if (prevVal && prevVal.pm25 != null && val != null) {
      const prev = Math.round(prevVal.pm25);
      if (val > prev) {
        if (arrowEl) {
          arrowEl.textContent = '▲';
          arrowEl.className = 'kpi-trend-icon is-up';
        }
      } else if (val < prev) {
        if (arrowEl) {
          arrowEl.textContent = '▼';
          arrowEl.className = 'kpi-trend-icon is-down';
        }
      } else {
        if (arrowEl) {
          arrowEl.textContent = '=';
          arrowEl.className = 'kpi-trend-icon is-flat';
        }
      }
    } else {
      if (arrowEl) {
        arrowEl.textContent = '';
        arrowEl.className = 'kpi-trend-icon';
      }
    }
  } else {
    setKpiValue('kpi-last', '–');
    applySeverityDataset(valueEl, null);
    if (timeEl) timeEl.textContent = 'Pas de relevé';
    if (arrowEl) {
      arrowEl.textContent = '';
      arrowEl.className = 'kpi-trend-icon';
    }
  }

  plotRange(currentRange);

  await loadActivitiesForRange(currentRange);

}

async function reloadThrottled() {
  if (Date.now() - lastReload < MIN_INTERVAL_MS) {
    console.warn('Requête ignorée pour respecter la limite de fréquence');
    return;
  }
  lastReload = Date.now();
  await reloadDashboard();
}

// kick
loadAll()
  .then(() => {
    setInterval(reloadThrottled, PASSIVE_INTERVAL_MS);
  })
  .catch(err => {
    console.error(err);
    alert('Erreur de chargement des données. Vérifiez vos RPC/permissions.');
  });
