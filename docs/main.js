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
let highlightDetail = null;

window.addEventListener('aq:highlight', (event) => {
  const normalized = normalizeHighlightDetail(event?.detail);
  highlightDetail = normalized;
  if (event?.detail?.source === 'activity-cell' && event?.detail?.scroll) {
    requestAnimationFrame(() => {
      const chart = document.getElementById('chart-main');
      if (chart && typeof chart.scrollIntoView === 'function') {
        chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
  applyChartHighlight();
});

const metricAnimator = createMetricAnimator();
metricAnimator.register('kpi-peaks');
metricAnimator.register('kpi-last');
metricAnimator.register('kpi-pct');

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

async function summaryByTag(startISO, endISO) {
  const { data, error } = await sb.rpc('summary_by_tag_range', {
    start_ts: startISO, end_ts: endISO
  });
  if (error) throw error;
  return data || [];
}

/* ---------- metric animation ---------- */

function createMetricAnimator() {
  const map = new Map();
  let activeStamp = null;

  function normalizeValue(value) {
    if (value === null || value === undefined) return '–';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toString() : '–';
    }
    const str = String(value);
    const trimmed = str.trim();
    return trimmed.length ? trimmed : '–';
  }

  function register(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const entry = {
      el,
      lastStamp: null,
      value: normalizeValue(el.textContent || '–')
    };
    el.textContent = entry.value;
    map.set(id, entry);
    return entry;
  }

  function beginCycle(stamp) {
    if (stamp == null) return;
    activeStamp = stamp;
  }

  function setValue(id, value, stamp) {
    const entry = map.get(id);
    if (!entry) return;
    if (stamp != null && activeStamp != null && stamp !== activeStamp) {
      return;
    }
    const text = normalizeValue(value);
    if (stamp != null && entry.lastStamp === stamp && entry.value === text) {
      return;
    }
    entry.lastStamp = stamp ?? activeStamp;
    if (entry.value !== text || stamp == null) {
      entry.value = text;
      entry.el.textContent = text;
    }
  }

  return { register, beginCycle, setValue };
}

/* ---------- helpers ---------- */

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

function updateKpiCards(stats, datasetStamp) {
  const totalRaw = Number(stats?.total);
  const pctRaw = Number(stats?.pct);
  const totalValue = Number.isFinite(totalRaw) ? Math.round(totalRaw).toString() : '–';
  const pctValue = Number.isFinite(pctRaw) ? `${Math.round(pctRaw)}%` : '–';
  metricAnimator.setValue('kpi-peaks', totalValue, datasetStamp);
  metricAnimator.setValue('kpi-pct', pctValue, datasetStamp);
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
  updateKpiCards(ds.kpis, ds.datasetStamp);
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

/* ---------- main flow ---------- */

async function loadAll() {
  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => plotRange(btn.dataset.range));
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
  const datasetStamp = latest.valueOf();
  const clampStart = candidate => (candidate.isBefore(earliest) ? earliest : candidate);

  metricAnimator.beginCycle(datasetStamp);

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
        datasetStamp
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
    metricAnimator.setValue('kpi-last', displayVal, datasetStamp);
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
    metricAnimator.setValue('kpi-last', '–', datasetStamp);
    applySeverityDataset(valueEl, null);
    if (timeEl) timeEl.textContent = 'Pas de relevé';
    if (arrowEl) {
      arrowEl.textContent = '';
      arrowEl.className = 'kpi-trend-icon';
    }
  }

  plotRange(currentRange);

  const summaryRange = DATASETS['7j'] ?? DATASETS['debut'];
  const summaryStartISO = summaryRange?.rangeStartISO ?? earliest.toISOString();
  const summaryEndISO = summaryRange?.rangeEndISO ?? latest.toISOString();
  const sum = await summaryByTag(summaryStartISO, summaryEndISO);
  const tbody = document.getElementById('tbl-acts');
  tbody.innerHTML = '';
  const filtered = sum.filter((row) => {
    const tag = typeof row.tag === 'string' ? row.tag.toLowerCase() : '';
    return tag && !tag.includes('example.csv');
  });
  filtered.sort((a,b)=>( (b.peaks/(b.duration||1)) - (a.peaks/(a.duration||1)) ));
  filtered.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.tag}</td>
      <td class="text-right tabular-nums">${Math.round(r.duration||0)}</td>
      <td class="text-right tabular-nums">${r.peaks||0}</td>
      <td class="text-right tabular-nums">${Math.round(((r.peaks||0) / (r.duration||1)))}</td>
    `;
    tbody.appendChild(tr);
  });

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
