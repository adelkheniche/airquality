/* globals supabase, dayjs, Plotly, window, document */

function getThemeColors() {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return {
      pm25: '#FDCA40',
      pm10: '#811EEB',
      pm1: '#0047AB',
      grid: '#D9E0EE',
      text: '#080708',
      panel: '#FFFFFF'
    };
  }

  const styles = window.getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const value = styles.getPropertyValue(name);
    return value && value.trim() ? value.trim() : fallback;
  };

  return {
    pm25: read('--chart-pm25', read('--warning', '#FDCA40')),
    pm10: read('--chart-pm10', read('--secondary', '#811EEB')),
    pm1: read('--chart-pm1', '#0047AB'),
    grid: read('--border', '#D9E0EE'),
    text: read('--text', '#080708'),
    panel: read('--panel', '#FFFFFF')
  };
}

function getBodyFontFamily() {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  }
  const body = document.body;
  if (!body) {
    return "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
  }
  const fontFamily = window.getComputedStyle(body).fontFamily;
  return fontFamily && fontFamily.trim()
    ? fontFamily
    : "'Inter', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
}

const COLORS = getThemeColors();

const WHO_LINE = 15; // µg/m³

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const HIGHLIGHT_FILL = 'rgba(223, 41, 53, 0.16)';
const HIGHLIGHT_BORDER = 'rgba(223, 41, 53, 0.8)';
const ACTIVITIES_CACHE_TTL = 60 * 1000;
const activitiesCache = Object.create(null);
let highlightDetail = null;
let activitiesActiveId = null;
let activitiesRequestToken = 0;
const ACTIVITIES_FILTER_DEFAULT = 'all';
const ACTIVITIES_FILTER_SELECT_ID = 'activities-filter-mode';
const ACTIVITIES_LABEL_COLLATOR = new Intl.Collator('fr', {
  sensitivity: 'base',
  ignorePunctuation: true,
  numeric: true,
});
let activitiesFilterMode = ACTIVITIES_FILTER_DEFAULT;
let activitiesFilterOptions = [];
let activitiesLatestState = { range: null, events: [] };
const ACTIVITY_DAY_LABELS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

const ambientState = {
  last: { pm25: null, pct: null, severity: null },
  override: null,
};

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
  const maxParallelPages = 3;

  const { count, error: countError } = await sb
    .from('readings')
    .select('ts', { count: 'exact', head: true })
    .gte('ts', startISO)
    .lte('ts', endISO);
  if (countError) throw countError;
  const total = Number.isFinite(count) ? count : 0;
  if (!total) {
    return [];
  }

  const totalPages = Math.ceil(total / pageSize);
  const indices = Array.from({ length: totalPages }, (_, i) => i);
  const chunks = [];

  for (let i = 0; i < indices.length; i += maxParallelPages) {
    chunks.push(indices.slice(i, i + maxParallelPages));
  }

  const results = [];
  for (const chunk of chunks) {
    const pages = await Promise.all(
      chunk.map(async (pageIndex) => {
        const from = pageIndex * pageSize;
        const to = Math.min(total - 1, from + pageSize - 1);
        const { data, error } = await sb
          .from('readings')
          .select('ts, pm1, pm25, pm10')
          .gte('ts', startISO)
          .lte('ts', endISO)
          .order('ts', { ascending: true })
          .range(from, to);
        if (error) throw error;
        return data || [];
      })
    );
    for (const page of pages) {
      results.push(...page);
    }
  }

  return results.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
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

function updateAmbientQuality({ pm25, pct, severity }) {
  ambientState.last = {
    pm25: pm25 ?? null,
    pct: pct ?? null,
    severity: severity ?? null,
  };
  refreshAmbientParticles();
  syncAmbientDebugWithLiveValue();
}

function refreshAmbientParticles() {
  if (typeof window === 'undefined') return;
  const ambient = window.AmbientParticles;
  if (!ambient || typeof ambient.setQuality !== 'function') {
    return;
  }

  const base = ambientState.last || { pm25: null, pct: null, severity: null };
  let { pm25, pct, severity } = base;

  if (ambientState.override != null) {
    pm25 = ambientState.override;
    const overrideSeverity = classifyPm25Severity(pm25);
    if (overrideSeverity) {
      severity = overrideSeverity;
    }
  }

  ambient.setQuality({ pm25, pctOver: pct, severity });
  if (severity === 'risk' && typeof ambient.pulse === 'function') {
    ambient.pulse();
  }
}

function clampToSliderRange(slider, value) {
  if (!slider) return value;
  const min = Number(slider.min);
  const max = Number(slider.max);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return Math.min(Math.max(value, min), max);
  }
  if (Number.isFinite(min)) {
    return Math.max(value, min);
  }
  if (Number.isFinite(max)) {
    return Math.min(value, max);
  }
  return value;
}

function renderAmbientDebugState() {
  const slider = document.getElementById('ambient-debug-slider');
  const valueEl = document.getElementById('ambient-debug-value');
  const severityEl = document.getElementById('ambient-debug-severity');

  if (!valueEl || !severityEl) {
    return;
  }

  if (ambientState.override == null) {
    valueEl.textContent = 'Temps réel';
    severityEl.textContent = '';
    severityEl.dataset.severity = '';
    severityEl.hidden = true;
    if (slider) {
      const liveValue = Number(ambientState.last?.pm25);
      if (Number.isFinite(liveValue)) {
        slider.value = clampToSliderRange(slider, Math.round(liveValue));
      }
    }
    return;
  }

  const overrideValue = ambientState.override;
  const severity = classifyPm25Severity(overrideValue);
  valueEl.textContent = `${Math.round(overrideValue)} µg/m³`;
  severityEl.hidden = false;
  if (severity === 'risk') {
    severityEl.textContent = 'Risque';
  } else if (severity === 'warn') {
    severityEl.textContent = 'À surveiller';
  } else if (severity === 'good') {
    severityEl.textContent = 'Bonne qualité';
  } else {
    severityEl.textContent = 'Qualité inconnue';
  }
  severityEl.dataset.severity = severity || '';
}

function syncAmbientDebugWithLiveValue() {
  if (ambientState.override != null) {
    return;
  }
  renderAmbientDebugState();
}

function setAmbientOverride(value) {
  if (value == null || value === '') {
    ambientState.override = null;
    renderAmbientDebugState();
    refreshAmbientParticles();
    return;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return;
  }
  ambientState.override = numeric;
  renderAmbientDebugState();
  refreshAmbientParticles();
}

function clearAmbientOverride() {
  ambientState.override = null;
  renderAmbientDebugState();
  refreshAmbientParticles();
}

function initAmbientDebugControls() {
  const slider = document.getElementById('ambient-debug-slider');
  const resetButton = document.getElementById('ambient-debug-reset');
  if (!slider) {
    return;
  }

  slider.addEventListener('input', (event) => {
    const target = event?.target;
    const value = target?.value;
    if (value == null) {
      return;
    }
    setAmbientOverride(Number(value));
  });

  if (resetButton) {
    resetButton.addEventListener('click', () => {
      clearAmbientOverride();
    });
  }

  renderAmbientDebugState();
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

  const fontFamily = getBodyFontFamily();
  const layout = {
    title: { text:title, font:{ size:14, family:fontFamily, color:COLORS.text } },
    margin:{ t:48, r:24, b:36, l:48 },
    paper_bgcolor: COLORS.panel,
    plot_bgcolor: COLORS.panel,
    font: { family: fontFamily, color: COLORS.text },
    xaxis:{
      showgrid:true,
      gridcolor:COLORS.grid,
      color: COLORS.text,
      linecolor: COLORS.grid,
      tickfont: { color: COLORS.text }
    },
    yaxis:{
      showgrid:true,
      gridcolor:COLORS.grid,
      title:{ text:'µg/m³', font:{ family: fontFamily, size: 12, color: COLORS.text } },
      range:[0, ymax],
      fixedrange:true,
      color: COLORS.text,
      tickfont: { color: COLORS.text }
    },
    legend:{ orientation:'h', x:0, xanchor:'left', y:1.2, font:{ color: COLORS.text, family: fontFamily }, bgcolor:'rgba(0,0,0,0)' },
    shapes: [
      { type:'line', xref:'paper', x0:0, x1:1, y0:WHO_LINE, y1:WHO_LINE,
        line:{ dash:'dash', width:1, color:COLORS.text } },
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

  const startInput = detail.start ?? null;
  const endInput = detail.end ?? null;
  if (startInput == null || endInput == null) return null;

  const start = dayjs(startInput);
  const end = dayjs(endInput);
  if (!start.isValid() || !end.isValid()) return null;

  const startValue = start.valueOf();
  const endValue = end.valueOf();
  if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) return null;
  if (startValue === endValue) return null;

  const [min, max] = startValue <= endValue ? [start, end] : [end, start];
  const tz = 'Europe/Paris';

  return {
    startISO: min.tz(tz).format(),
    endISO: max.tz(tz).format(),
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

function focusChartOnEventDay(chart, startISO, endISO) {
  if (!chart || typeof Plotly === 'undefined' || typeof Plotly.relayout !== 'function') return;

  const tz = 'Europe/Paris';
  const start = dayjs(startISO);
  const end = dayjs(endISO);
  const reference = start.isValid() ? start : end;
  if (!reference.isValid()) return;

  const dayStart = reference.tz(tz).startOf('day');
  const dayEnd = dayStart.endOf('day');

  Plotly.relayout(chart, {
    'xaxis.range': [dayStart.format(), dayEnd.format()]
  });
}

function scrollIntoViewIfNotVisible(element, options = {}) {
  if (!element || typeof element.getBoundingClientRect !== 'function' || typeof element.scrollIntoView !== 'function') {
    return;
  }

  const rect = element.getBoundingClientRect();
  const doc = typeof document !== 'undefined' ? document : null;
  const viewportHeight = typeof window !== 'undefined'
    ? (window.innerHeight || doc?.documentElement?.clientHeight || 0)
    : (doc?.documentElement?.clientHeight || 0);
  const viewportWidth = typeof window !== 'undefined'
    ? (window.innerWidth || doc?.documentElement?.clientWidth || 0)
    : (doc?.documentElement?.clientWidth || 0);

  const marginFromOptions = Number(options.margin);
  const marginY = Number.isFinite(options.marginY)
    ? Math.max(Number(options.marginY), 0)
    : (Number.isFinite(marginFromOptions) && marginFromOptions > 0 ? marginFromOptions : 0);
  const marginX = Number.isFinite(options.marginX)
    ? Math.max(Number(options.marginX), 0)
    : marginY;

  const completelyAbove = rect.bottom <= -marginY;
  const completelyBelow = rect.top >= viewportHeight + marginY;
  const completelyLeft = rect.right <= -marginX;
  const completelyRight = rect.left >= viewportWidth + marginX;

  if (!(completelyAbove || completelyBelow || completelyLeft || completelyRight)) {
    return;
  }

  const behavior = options.behavior || 'smooth';
  const block = options.block || 'nearest';
  const inline = options.inline || 'nearest';
  element.scrollIntoView({ behavior, block, inline });
}

async function loadActivitiesForRange(range, { preferCache = true } = {}) {
  const container = document.getElementById('cell-activite');
  if (!container || !range) return;

  const cached = preferCache ? getCachedActivities(range) : null;
  if (cached) {
    renderActivitiesList(cached, range);
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
    renderActivitiesList(data, range);
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
  const { data, error } = await sb.rpc('activities_site', { p_range: range });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function renderActivitiesList(events, range) {
  const container = document.getElementById('cell-activite');
  if (!container) return;

  const normalizedEvents = Array.isArray(events) ? events.slice() : [];
  activitiesLatestState = { range: range ?? null, events: normalizedEvents };

  activitiesFilterOptions = buildActivitiesFilterOptions(normalizedEvents);
  if (
    activitiesFilterMode !== ACTIVITIES_FILTER_DEFAULT &&
    !activitiesFilterOptions.some(option => option.value === activitiesFilterMode)
  ) {
    activitiesFilterMode = ACTIVITIES_FILTER_DEFAULT;
  }

  container.innerHTML = '';

  const controls = buildActivitiesControls(activitiesFilterOptions);
  if (controls) {
    container.appendChild(controls);
  }

  const filtered = filterActivitiesByLabel(normalizedEvents, activitiesFilterMode);
  const sorted = sortActivitiesByRecency(filtered);
  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'activities-message';
    empty.textContent = 'Aucune activité sur la période.';
    container.appendChild(empty);
    setActiveActivityRow(null);
    return;
  }

  const scroller = document.createElement('div');
  scroller.className = 'activities-scroller';

  const list = document.createElement('div');
  list.className = 'activities-list';
  scroller.appendChild(list);

  const ids = new Set(
    sorted
      .map(evt => evt?.event_id ?? evt?.eventId)
      .filter(id => id != null)
      .map(id => String(id))
  );
  if (activitiesActiveId != null && !ids.has(activitiesActiveId)) {
    activitiesActiveId = null;
  }

  const entries = [];
  sorted.forEach(evt => {
    const row = createActivityRow(evt);
    list.appendChild(row);
    entries.push({ row, event: evt });
  });

  container.appendChild(scroller);
  setActiveActivityRow(activitiesActiveId);
  enforceActivitiesScrollLimit(scroller, list);
  scrollActivitiesToRange(range, scroller, entries, list);
}

function buildActivitiesControls(options = []) {
  if (!Array.isArray(options) || !options.length) {
    return null;
  }

  const wrap = document.createElement('div');
  wrap.className = 'activities-controls';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'activities-filter-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'activities-filter-panel');

  const toggleIcon = document.createElement('span');
  toggleIcon.className = 'activities-filter-toggle-icon';
  toggleIcon.setAttribute('aria-hidden', 'true');
  toggleIcon.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 6h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M7 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      <path d="M10 18h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  `;
  toggle.appendChild(toggleIcon);

  const toggleText = document.createElement('span');
  toggleText.className = 'activities-filter-toggle-text';
  toggleText.textContent = 'Filtrer';
  toggle.appendChild(toggleText);

  wrap.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'activities-filter-panel';
  panel.className = 'activities-filter-panel';
  panel.setAttribute('aria-hidden', 'true');
  panel.hidden = true;
  panel.style.maxHeight = '0px';

  const fields = document.createElement('div');
  fields.className = 'activities-filter-fields';
  panel.appendChild(fields);

  const label = document.createElement('label');
  label.className = 'activities-sort-label';
  label.setAttribute('for', ACTIVITIES_FILTER_SELECT_ID);
  label.textContent = 'Filtrer par activité';
  fields.appendChild(label);

  const select = document.createElement('select');
  select.id = ACTIVITIES_FILTER_SELECT_ID;
  select.className = 'activities-sort-select';

  const values = [ACTIVITIES_FILTER_DEFAULT];

  const defaultOption = document.createElement('option');
  defaultOption.value = ACTIVITIES_FILTER_DEFAULT;
  defaultOption.textContent = 'Toutes activités';
  select.appendChild(defaultOption);

  options.forEach(option => {
    if (!option || typeof option !== 'object') return;
    const { value, label: optionLabel } = option;
    if (typeof value !== 'string') return;
    values.push(value);
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = optionLabel || value;
    select.appendChild(opt);
  });

  if (!values.includes(activitiesFilterMode)) {
    activitiesFilterMode = ACTIVITIES_FILTER_DEFAULT;
  }
  select.value = activitiesFilterMode;

  select.addEventListener('change', (event) => {
    const selected = event?.target?.value;
    activitiesFilterMode = values.includes(selected) ? selected : ACTIVITIES_FILTER_DEFAULT;
    renderActivitiesList(activitiesLatestState.events, activitiesLatestState.range);
  });

  fields.appendChild(select);
  wrap.appendChild(panel);

  let isOpen = false;

  const schedule = (fn) => {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(fn));
    } else {
      setTimeout(fn, 0);
    }
  };

  const setOpenState = (open) => {
    const nextState = Boolean(open);
    if (nextState === isOpen) {
      return;
    }

    isOpen = nextState;
    wrap.classList.toggle('is-open', isOpen);
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');

    if (isOpen) {
      panel.hidden = false;
      panel.style.maxHeight = '0px';
      schedule(() => {
        panel.style.maxHeight = `${panel.scrollHeight}px`;
      });
    } else {
      const currentHeight = panel.scrollHeight;
      panel.hidden = false;
      panel.style.maxHeight = `${currentHeight}px`;
      schedule(() => {
        panel.style.maxHeight = '0px';
      });
    }
  };

  toggle.addEventListener('click', () => {
    setOpenState(!isOpen);
  });

  panel.addEventListener('transitionend', (event) => {
    if (event?.propertyName !== 'max-height') {
      return;
    }
    if (isOpen) {
      panel.style.maxHeight = 'none';
    } else {
      panel.hidden = true;
      panel.style.maxHeight = '0px';
    }
  });

  if (activitiesFilterMode !== ACTIVITIES_FILTER_DEFAULT) {
    setOpenState(true);
  }

  return wrap;
}

function enforceActivitiesScrollLimit(scroller, list) {
  if (!scroller || !list) return;

  const apply = () => {
    const rows = Array.from(list.querySelectorAll('.activity-row'));
    if (!rows.length) {
      scroller.style.removeProperty('maxHeight');
      scroller.style.removeProperty('overflow-y');
      scroller.style.removeProperty('padding-right');
      return;
    }

    const maxVisible = 5;
    const sampleCount = Math.min(rows.length, maxVisible);

    let totalHeight = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      totalHeight += rows[i].getBoundingClientRect().height;
    }

    const styles = window.getComputedStyle(list);
    const gapRaw = styles.rowGap || styles.gap || '0';
    const gapValue = parseFloat(gapRaw) || 0;
    const totalGap = gapValue * Math.max(sampleCount - 1, 0);

    if (rows.length > maxVisible) {
      const maxHeight = Math.ceil(totalHeight + totalGap + 1);
      scroller.style.maxHeight = `${maxHeight}px`;
      scroller.style.overflowY = 'auto';
      scroller.style.paddingRight = '8px';
    } else {
      scroller.style.removeProperty('maxHeight');
      scroller.style.removeProperty('overflow-y');
      scroller.style.removeProperty('padding-right');
    }
  };

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(apply);
  } else {
    apply();
  }
}

function scrollActivitiesToRange(range, scroller, entries = [], list) {
  if (!scroller) return;

  const apply = () => {
    if (!range || range === '24h' || range === '7j') {
      setScrollerTop(scroller, 0);
      return;
    }

    if (range === '30j') {
      const boundary = dayjs().tz('Europe/Paris').startOf('day').subtract(7, 'day');
      const target = entries.find(({ event }) => {
        const start = dayjs(event?.start);
        const end = dayjs(event?.end);
        const reference = start.isValid() ? start : end;
        return reference.isValid() && reference.isBefore(boundary);
      });
      if (target?.row) {
        const listRect = list?.getBoundingClientRect();
        const rowRect = target.row.getBoundingClientRect();
        let offset = target.row.offsetTop;
        if (listRect && rowRect) {
          offset = Math.max(0, rowRect.top - listRect.top + scroller.scrollTop);
        }
        setScrollerTop(scroller, offset);
        return;
      }
    }

    setScrollerTop(scroller, 0);
  };

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(apply);
  } else {
    apply();
  }
}

function setScrollerTop(scroller, top) {
  if (!scroller) return;
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: 'auto' });
  } else {
    scroller.scrollTop = top;
  }
}

function buildActivitiesFilterOptions(events = []) {
  const seen = new Map();
  events.forEach(evt => {
    const { key, label } = getActivityLabelData(evt);
    if (!key || seen.has(key)) {
      return;
    }
    seen.set(key, { value: key, label });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const labelA = a?.label ?? '';
    const labelB = b?.label ?? '';
    return ACTIVITIES_LABEL_COLLATOR.compare(labelA, labelB);
  });
}

function filterActivitiesByLabel(events = [], filterValue = ACTIVITIES_FILTER_DEFAULT) {
  const list = Array.isArray(events) ? events.slice() : [];
  if (filterValue === ACTIVITIES_FILTER_DEFAULT) {
    return list;
  }
  return list.filter(evt => {
    const { key } = getActivityLabelData(evt);
    return key === filterValue;
  });
}

function sortActivitiesByRecency(events = []) {
  const list = Array.isArray(events) ? events.slice() : [];
  return list.sort((a, b) => getActivityReferenceTime(b) - getActivityReferenceTime(a));
}

function getActivityReferenceTime(evt) {
  const start = dayjs(evt?.start);
  const end = dayjs(evt?.end);
  const hasStart = start.isValid();
  const hasEnd = end.isValid();
  if (hasStart && hasEnd) {
    return Math.max(start.valueOf(), end.valueOf());
  }
  if (hasStart) {
    return start.valueOf();
  }
  if (hasEnd) {
    return end.valueOf();
  }
  return Number.NEGATIVE_INFINITY;
}

function getActivityLabelData(evt) {
  const label = extractActivityLabel(evt);
  const key = normalizeActivityLabelKey(label);
  return { key, label };
}

function extractActivityLabel(evt) {
  if (!evt || typeof evt !== 'object') {
    return 'Autres';
  }

  const candidates = [];
  const pushCandidate = (value) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length) {
        candidates.push(trimmed);
      }
    }
  };

  pushCandidate(evt.type_label);
  pushCandidate(evt.typeLabel);
  pushCandidate(evt.type);
  pushCandidate(evt.label);
  pushCandidate(evt.machine_label);
  pushCandidate(evt.machine);

  if (Array.isArray(evt.tags)) {
    const tags = evt.tags
      .map(tag => (typeof tag === 'string' ? tag.trim() : ''))
      .filter(Boolean);
    if (tags.length) {
      candidates.push(tags.join(', '));
    }
  } else if (typeof evt.tags === 'string') {
    pushCandidate(evt.tags);
  }

  if (!candidates.length) {
    return 'Autres';
  }
  return candidates[0];
}

function normalizeActivityLabelKey(label) {
  const base = typeof label === 'string' && label.trim().length ? label.trim() : 'Autres';
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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

  const time = document.createElement('span');
  time.className = 'activity-time';
  const dateLabel = formatActivityDateLabel(evt?.start, evt?.end);
  if (dateLabel) {
    const dateEl = document.createElement('span');
    dateEl.className = 'activity-date';
    dateEl.textContent = dateLabel;
    time.appendChild(dateEl);
  }

  const hoursEl = document.createElement('span');
  hoursEl.className = 'activity-hours tabular-nums';
  hoursEl.textContent = formatActivityTimeRange(evt?.start, evt?.end);
  time.appendChild(hoursEl);

  const titleBlock = document.createElement('span');
  titleBlock.className = 'activity-title-block';

  const titleWrap = document.createElement('span');
  titleWrap.className = 'activity-title';
  titleWrap.textContent = evt?.title || 'Sans titre';
  titleBlock.appendChild(titleWrap);

  const sparklineWrap = document.createElement('span');
  sparklineWrap.className = 'activity-sparkline';

  const timeLabel = buildActivityTimeLabel(evt?.start, evt?.end);
  const pm25 = evt?.pm25 || {};
  const points = Array.isArray(pm25.points_sample)
    ? pm25.points_sample.map(Number).filter(v => Number.isFinite(v))
    : [];

  const metricsText = formatActivityMetrics(pm25, points);
  if (metricsText) {
    const metrics = document.createElement('span');
    metrics.className = 'activity-metrics tabular-nums';
    metrics.textContent = metricsText;
    titleBlock.appendChild(metrics);
  }

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
    const chartCard = chart?.closest('.card') || chart;
    scrollIntoViewIfNotVisible(chartCard, { behavior: 'smooth', block: 'nearest', inline: 'nearest', margin: 48 });
    focusChartOnEventDay(chart, detail.start, detail.end);
  };

  row.addEventListener('click', handleSelect);

  row.appendChild(time);
  row.appendChild(titleBlock);
  row.appendChild(sparklineWrap);

  return row;
}

function buildActivityTimeLabel(start, end) {
  const range = formatActivityTimeRange(start, end);
  const dateLabel = formatActivityDateLabel(start, end);
  if (range === '—' && !dateLabel) {
    return 'Heures inconnues';
  }
  const rangePart = range === '—' ? 'Heures inconnues' : `${range} (Europe/Paris)`;
  return dateLabel ? `${dateLabel}, ${rangePart}` : rangePart;
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

function formatActivityDateLabel(startISO, endISO) {
  const start = dayjs(startISO).tz('Europe/Paris');
  const end = dayjs(endISO).tz('Europe/Paris');
  const reference = start.isValid() ? start : end;
  if (!reference.isValid()) {
    return '';
  }
  const dayIndex = reference.day();
  const dayLabel = ACTIVITY_DAY_LABELS[dayIndex] || reference.format('ddd');
  const dateLabel = reference.format('DD/MM');
  return `${dayLabel} ${dateLabel}`;
}

function formatActivityMetrics(pm25 = {}, points = []) {
  const pointValues = Array.isArray(points) ? points : [];
  const numericPoints = pointValues.filter(value => Number.isFinite(value));

  const minCandidates = [pm25.min, pm25.min_value, pm25.minimum, pm25.pm25_min];
  const maxCandidates = [pm25.max, pm25.max_value, pm25.maximum, pm25.pm25_max];
  const meanCandidates = [pm25.mean, pm25.avg, pm25.average, pm25.pm25_mean];

  const minValue = firstFinite(minCandidates);
  const maxValue = firstFinite(maxCandidates);
  const meanValue = firstFinite(meanCandidates);

  const fallbackMin = numericPoints.length ? Math.min(...numericPoints) : null;
  const fallbackMax = numericPoints.length ? Math.max(...numericPoints) : null;
  const fallbackMean = numericPoints.length
    ? numericPoints.reduce((sum, value) => sum + value, 0) / numericPoints.length
    : null;

  const minFormatted = formatMetricValue(minValue ?? fallbackMin);
  const meanFormatted = formatMetricValue(meanValue ?? fallbackMean);
  const maxFormatted = formatMetricValue(maxValue ?? fallbackMax);

  return `Min ${minFormatted} · Moy ${meanFormatted} · Max ${maxFormatted} µg/m³`;
}

function firstFinite(values = []) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function formatMetricValue(value) {
  if (!Number.isFinite(value)) {
    return '—';
  }
  return NUMBER_FORMAT_1.format(value);
}

const RANGE_TITLES = {
  '24h': 'Aujourd’hui (24 h)',
  '7j': '7 jours',
  '30j': '30 jours',
  'debut': 'Depuis le début'
};
let currentRange = '24h';
const DATASETS = {};
const RANGE_FETCHES = Object.create(null);
let RANGE_BOUNDS = {};
let rangeSelectionToken = 0;
let currentReloadPromise = Promise.resolve();

function clearChartLoading() {
  const chart = document.getElementById('chart-main');
  if (!chart) return;
  delete chart.dataset.state;
  chart.removeAttribute('aria-busy');
}

function showChartLoading(range) {
  if (range) {
    currentRange = range;
    setActiveRange(range);
    const title = document.getElementById('chart-title');
    if (title && RANGE_TITLES[range]) {
      title.textContent = RANGE_TITLES[range];
    }
  }
  const summary = document.getElementById('chart-summary');
  if (summary) {
    summary.textContent = 'Chargement…';
  }
  const chart = document.getElementById('chart-main');
  if (chart) {
    chart.dataset.state = 'loading';
    chart.setAttribute('aria-busy', 'true');
  }
}

function showChartError(range, message) {
  if (range) {
    currentRange = range;
    setActiveRange(range);
    const title = document.getElementById('chart-title');
    if (title && RANGE_TITLES[range]) {
      title.textContent = RANGE_TITLES[range];
    }
  }
  const summary = document.getElementById('chart-summary');
  if (summary) {
    summary.textContent = message;
  }
  const chart = document.getElementById('chart-main');
  if (chart) {
    chart.dataset.state = 'error';
    chart.removeAttribute('aria-busy');
  }
}

async function fetchRangeDataset(range, bounds) {
  if (!bounds) {
    throw new Error(`Aucune borne disponible pour la plage ${range}`);
  }
  const tz = 'Europe/Paris';
  const startISO = bounds.start.toISOString();
  const endISO = bounds.end.toISOString();

  const [serie, kpiData, peaksData] = await Promise.all([
    series(startISO, endISO),
    kpis(startISO, endISO),
    peaksList(startISO, endISO)
  ]);

  const sortedPeaks = (peaksData || []).slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));

  return {
    data: serie,
    xRange: [bounds.start.tz(tz).format(), bounds.end.tz(tz).format()],
    kpis: kpiData,
    peaks: sortedPeaks,
    rangeStartISO: startISO,
    rangeEndISO: endISO,
  };
}

async function ensureRangeDataset(range) {
  if (DATASETS[range]) {
    return DATASETS[range];
  }
  if (RANGE_FETCHES[range]) {
    return RANGE_FETCHES[range];
  }
  const bounds = RANGE_BOUNDS[range];
  if (!bounds) {
    throw new Error(`Plage inconnue : ${range}`);
  }
  const promise = fetchRangeDataset(range, bounds)
    .then(ds => {
      DATASETS[range] = ds;
      return ds;
    })
    .finally(() => {
      delete RANGE_FETCHES[range];
    });
  RANGE_FETCHES[range] = promise;
  return promise;
}

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
  clearChartLoading();
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
    drawChart();
  }
}

async function handleRangeChange(range) {
  if (!range) return;

  const token = ++rangeSelectionToken;
  if (DATASETS[range]) {
    plotRange(range);
    loadActivitiesForRange(range);
    return;
  }

  showChartLoading(range);
  loadActivitiesForRange(range);

  await currentReloadPromise.catch(() => {});

  try {
    await ensureRangeDataset(range);
    if (token === rangeSelectionToken && DATASETS[range]) {
      plotRange(range);
    }
  } catch (error) {
    console.error(`Impossible de charger la plage ${range}`, error);
    if (token === rangeSelectionToken) {
      showChartError(range, 'Données indisponibles');
    }
  }
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
  const task = (async () => {
    showChartLoading(currentRange);
    const tz = 'Europe/Paris';
    const extent = await readingsExtent();
    if (!extent || !extent.max) {
      console.warn('Étendue de données indisponible, impossible de définir la période par défaut.');
      showChartError(currentRange, 'Données indisponibles');
      return;
    }
    const earliest = dayjs(extent.min ?? extent.max).utc();
    const latest = dayjs(extent.max).utc();
    const clampStart = candidate => (candidate.isBefore(earliest) ? earliest : candidate);

    RANGE_BOUNDS = {
      '24h': { start: clampStart(latest.subtract(24, 'hour')), end: latest },
      '7j':  { start: clampStart(latest.subtract(7, 'day')),  end: latest },
      '30j': { start: clampStart(latest.subtract(30, 'day')), end: latest },
      'debut': { start: earliest, end: latest }
    };

    const rangesToUpdate = Array.from(new Set([
      ...Object.keys(DATASETS),
      currentRange,
      '24h'
    ])).filter(range => RANGE_BOUNDS[range]);

    const refreshedEntries = await Promise.all(rangesToUpdate.map(async (range) => {
      try {
        const ds = await fetchRangeDataset(range, RANGE_BOUNDS[range]);
        return [range, ds];
      } catch (error) {
        console.error(`Impossible de rafraîchir la plage ${range}`, error);
        return null;
      }
    }));

    refreshedEntries.forEach(entry => {
      if (!entry) return;
      const [range, ds] = entry;
      DATASETS[range] = ds;
    });

    const stats24 = DATASETS['24h']?.kpis || null;
    const s24 = DATASETS['24h']?.data ?? [];
    const lastVal = s24[s24.length - 1];
    const prevVal = s24[s24.length - 2];
    const timeEl = document.getElementById('kpi-last-time');
    const arrowEl = document.getElementById('kpi-last-arrow');
    const valueEl = document.getElementById('kpi-last');

    let severity = null;
    if (lastVal) {
      const val = lastVal.pm25 != null ? Math.round(lastVal.pm25) : null;
      const displayVal = val != null ? val.toString() : '–';
      setKpiValue('kpi-last', displayVal);
      severity = classifyPm25Severity(lastVal.pm25);
      applySeverityDataset(valueEl, severity);
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

    updateAmbientQuality({
      pm25: lastVal?.pm25 ?? null,
      pct: stats24?.pct ?? null,
      severity,
    });

    if (DATASETS[currentRange]) {
      plotRange(currentRange);
    } else {
      showChartError(currentRange, 'Données indisponibles');
    }

    await loadActivitiesForRange(currentRange, { preferCache: false });
  })();

  currentReloadPromise = task;
  return task;
}

async function reloadThrottled() {
  if (Date.now() - lastReload < MIN_INTERVAL_MS) {
    console.warn('Requête ignorée pour respecter la limite de fréquence');
    return;
  }
  lastReload = Date.now();
  await reloadDashboard();
}

initAmbientDebugControls();

// kick
loadAll()
  .then(() => {
    setInterval(reloadThrottled, PASSIVE_INTERVAL_MS);
  })
  .catch(err => {
    console.error(err);
    alert('Erreur de chargement des données. Vérifiez vos RPC/permissions.');
  });
