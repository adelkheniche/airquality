/* globals supabase, dayjs, Plotly, window, document */

const COLORS = {
  pm25: '#E11D48', // rouge principal
  pm10: '#2563EB', // bleu
  pm1:  '#7C3AED', // violet pour distinguer visuellement la 3e trace
  grid: '#E5E7EB',
  text: '#0F172A'
};

const WHO_LINE = 15; // µg/m³

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

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
    total: row?.total_peaks ?? 0,
    pph:   row?.peaks_per_hour ?? 0,
    pct:   row?.percent_over15 ?? 0
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

/* ---------- helpers ---------- */

function toParisISO(d) {
  // d = JS Date or ISO; we just pass through, RPC expects UTC ISO. 
  // Inputs are already in local -> we create ISO UTC from date inputs.
  return new Date(d).toISOString();
}

function setPctPill(pct) {
  const pctPill = document.getElementById('kpi-pct-pill');
  if (!pctPill) return;
  if (pct > 20) {
    pctPill.className = 'status-pill status-pill--risk';
    pctPill.textContent = 'À risque';
  } else if (pct > 10) {
    pctPill.className = 'status-pill status-pill--warn';
    pctPill.textContent = 'À surveiller';
  } else {
    pctPill.className = 'status-pill status-pill--ok';
    pctPill.textContent = 'OK';
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
  wrap.appendChild(chip(`Pics (PM2.5>15) : ${above}`));
  wrap.appendChild(chip(`Max PM2.5 : ${Math.round(max25)} µg/m³`));
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
    { name:'PM2.5', x, y: y25, mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm25 } },
    { name:'PM10',  x, y: y10, mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm10 } },
    { name:'PM1',   x, y: y1,  mode:'lines', type:'scatter', line:{ width:4, color:COLORS.pm1  } },
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
        line:{ dash:'dash', width:1, color:'#475569' } },
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

const RANGE_TITLES = {
  '24h': 'Aujourd’hui (24 h)',
  '7d': '7 derniers jours',
  '30d': '30 derniers jours',
  'all': 'Depuis le début'
};
let currentRange = '24h';
const DATASETS = {};

function setActiveRange(range) {
  document.querySelectorAll('[data-range]').forEach(btn => {
    if (btn.dataset.range === range) {
      btn.classList.add('tw-btn-primary');
      btn.classList.remove('tw-btn-outline');
    } else {
      btn.classList.add('tw-btn-outline');
      btn.classList.remove('tw-btn-primary');
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
  plotOne('chart-main', ds.data, '', ds.xRange);
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
  const minValue = extent.min ?? extent.max;
  const endLocal = dayjs(extent.max).tz(tz).endOf('day');
  const minLocal = dayjs(minValue).tz(tz).startOf('day');
  let startLocal = dayjs(extent.max).tz(tz).subtract(7, 'day').startOf('day');
  if (startLocal.isBefore(minLocal)) startLocal = minLocal;
  const startISO = startLocal.utc().toISOString();
  const endISO = endLocal.utc().toISOString();

  // KPIs
  const k = await kpis(startISO, endISO);
  document.getElementById('kpi-peaks').textContent = k.total.toString();
  document.getElementById('kpi-pct').textContent   = (k.pct ?? 0).toFixed(0) + '%';
  setPctPill(k.pct ?? 0);

  // Séries pour les différentes fenêtres
  const nowUtc = dayjs.utc();
  const start24 = nowUtc.subtract(24, 'hour');
  const start7  = nowUtc.subtract(7, 'day');
  const start30 = nowUtc.subtract(30, 'day');
  const s24 = await series(start24.toISOString(), nowUtc.toISOString());

  // Dernière mesure à partir de la série 24h
  const lastVal = s24[s24.length - 1];
  const prevVal = s24[s24.length - 2];
  const valEl = document.getElementById('kpi-last');
  const timeEl = document.getElementById('kpi-last-time');
  const arrowEl = document.getElementById('kpi-last-arrow');

  if (lastVal) {
    const val = lastVal.pm25 != null ? Math.round(lastVal.pm25) : null;
    valEl.textContent = val != null ? val.toString() : '–';
    const measuredAt = dayjs(lastVal.ts).tz(tz).format('HH:mm');
    timeEl.textContent = `Relevé à ${measuredAt}`;

    if (prevVal && prevVal.pm25 != null && val != null) {
      const prev = Math.round(prevVal.pm25);
      if (val > prev) {
        arrowEl.textContent = '▲';
        arrowEl.className = 'kpi-trend-icon is-up';
      } else if (val < prev) {
        arrowEl.textContent = '▼';
        arrowEl.className = 'kpi-trend-icon is-down';
      } else {
        arrowEl.textContent = '=';
        arrowEl.className = 'kpi-trend-icon is-flat';
      }
    } else {
      arrowEl.textContent = '';
      arrowEl.className = 'kpi-trend-icon';
    }
  } else {
    valEl.textContent = '–';
    timeEl.textContent = 'Pas de relevé';
    arrowEl.textContent = '';
    arrowEl.className = 'kpi-trend-icon';
  }

  const s7  = await series(start7.toISOString(),  nowUtc.toISOString());
  const s30 = await series(start30.toISOString(), nowUtc.toISOString());

  // All time = extent
  const allStart = extent.min ?? extent.max;
  const sall = await series(allStart, extent.max);

  DATASETS['24h'] = { data: s24, xRange: [start24.tz(tz).format(), nowUtc.tz(tz).format()] };
  DATASETS['7d']  = { data: s7,  xRange: [start7.tz(tz).format(),  nowUtc.tz(tz).format()] };
  DATASETS['30d'] = { data: s30, xRange: [start30.tz(tz).format(), nowUtc.tz(tz).format()] };
  DATASETS['all'] = { data: sall, xRange: [dayjs(allStart).tz(tz).format(), dayjs(extent.max).tz(tz).format()] };

  plotRange(currentRange);



  // Table activités
  const sum = await summaryByTag(startISO, endISO);
  const tbody = document.getElementById('tbl-acts');
  tbody.innerHTML = '';
  sum.sort((a,b)=>( (b.peaks/(b.duration||1)) - (a.peaks/(a.duration||1)) ));
  sum.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.tag}</td>
      <td class="text-right tabular-nums">${Math.round(r.duration||0)}</td>
      <td class="text-right tabular-nums">${r.peaks||0}</td>
      <td class="text-right tabular-nums">${Math.round(((r.peaks||0) / (r.duration||1)))}</td>
    `;
    tbody.appendChild(tr);
  });

  // Liste des pics
  const peaks = await peaksList(startISO, endISO);
  peaks.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const ul = document.getElementById('list-peaks');
  ul.innerHTML = '';
  peaks.forEach(p=>{
    const li = document.createElement('li');
    const when = fmtTs(p.ts);
    const iso = dayjs(p.ts).tz(tz).format();
    li.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <time datetime="${iso}" class="tabular-nums">${when}</time>
      <span class="value tabular-nums">${Math.round(p.value||0)} µg/m³</span>
    `;
    ul.appendChild(li);
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
