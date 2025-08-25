/* globals supabase, dayjs, Plotly, window, document */

const COLORS = {
  pm25: '#DC2626', // rouge principal
  pm10: '#2563EB', // bleu
  pm1:  '#7C3AED', // violet pour distinguer visuellement la 3e trace
  grid: '#E5E7EB',
  text: '#0B0B0C'
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
  const { data, error } = await sb
    .from('readings')
    .select('ts, pm1, pm25, pm10')
    .gte('ts', startISO)
    .lte('ts', endISO)
    .order('ts', { ascending: true });
  if (error) throw error;
  return data || [];
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

function setKpiPills(pph, pct) {
  const pphPill = document.getElementById('kpi-pph-pill');
  const pctPill = document.getElementById('kpi-pct-pill');

  if (pph > 2) { pphPill.className = 'badge risk'; pphPill.textContent = 'À risque'; }
  else if (pph > 1) { pphPill.className = 'badge warn'; pphPill.textContent = 'À surveiller'; }
  else { pphPill.className = 'badge ok'; pphPill.textContent = 'OK'; }

  if (pct > 20) { pctPill.className = 'badge risk'; pctPill.textContent = 'À risque'; }
  else if (pct > 10) { pctPill.className = 'badge warn'; pctPill.textContent = 'À surveiller'; }
  else { pctPill.className = 'badge ok'; pctPill.textContent = 'OK'; }
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

  const ymax = 30;

  const layout = {
    title: { text:title, font:{ size:14 } },
    margin:{ t:48, r:24, b:36, l:48 },
    xaxis:{ showgrid:true, gridcolor:COLORS.grid },
    yaxis:{ showgrid:true, gridcolor:COLORS.grid, title:'µg/m³', range:[0, ymax], fixedrange:true },
    legend:{ orientation:'h', x:0, xanchor:'left', y:1.2 },
    shapes: [
      { type:'line', xref:'paper', x0:0, x1:1, y0:WHO_LINE, y1:WHO_LINE,
        line:{ dash:'dash', width:1, color:'#6B7280' } },
      { type:'rect', xref:'paper', x0:0, x1:1, y0:WHO_LINE, y1:ymax,
        fillcolor:'#DC2626', opacity:0.06, line:{ width:0 } }
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

  Plotly.react(container, traces, layout, config);
}

/* ---------- main flow ---------- */

async function loadAll() {
  // 1) plage par défaut = aujourd’hui locale
  const tz = 'Europe/Paris';
  const extent = await readingsExtent();
  const endMax = dayjs.utc(extent.max);
  const startDefault = endMax.subtract(7, 'day');

  // champs date (Paris)
  const $from = document.getElementById('from');
  const $to = document.getElementById('to');
  $from.value = startDefault.tz(tz).format('YYYY-MM-DD');
  $to.value = endMax.tz(tz).format('YYYY-MM-DD');

  // handler
  document.getElementById('apply').onclick = () => reloadThrottled();
  document.getElementById('reset').onclick = () => {
    $from.value = startDefault.tz(tz).format('YYYY-MM-DD');
    $to.value = endMax.tz(tz).format('YYYY-MM-DD');
    reloadThrottled();
  };

  await reloadThrottled();
}

async function reloadForInputs() {
  const tz = 'Europe/Paris';
  const f = document.getElementById('from').value;
  const t = document.getElementById('to').value;
  const startISO = dayjs.tz(`${f} 00:00`, tz).utc().toISOString();
  const endISO   = dayjs.tz(`${t} 23:59`, tz).utc().toISOString();

  // KPIs
  const k = await kpis(startISO, endISO);
  document.getElementById('kpi-peaks').textContent = k.total.toString();
  document.getElementById('kpi-pph').textContent   = Math.round(k.pph ?? 0).toString();
  document.getElementById('kpi-pct').textContent   = (k.pct ?? 0).toFixed(0) + '%';
  setKpiPills(k.pph ?? 0, k.pct ?? 0);

  // Séries pour 4 fenêtres (données brutes)
  const nowUtc = dayjs.utc();
  const start24 = nowUtc.subtract(24,'hour');
  const start7  = nowUtc.subtract(7,'day');
  const start30 = nowUtc.subtract(30,'day');
  const s24 = await series(start24.toISOString(), nowUtc.toISOString());
  const s7  = await series(start7.toISOString(),  nowUtc.toISOString());
  const s30 = await series(start30.toISOString(), nowUtc.toISOString());

  // All time = extent
  const ext = await readingsExtent();
  const sall = await series(ext.min, ext.max);

  renderSummary('sum-24h', s24);
  renderSummary('sum-7d',  s7);
  renderSummary('sum-30d', s30);
  renderSummary('sum-all', sall);

  // Charts
  plotOne('chart-24h', s24, "", [start24.tz(tz).format(), nowUtc.tz(tz).format()]);
  plotOne('chart-7d',  s7,  "", [start7.tz(tz).format(),  nowUtc.tz(tz).format()]);
  plotOne('chart-30d', s30, "", [start30.tz(tz).format(), nowUtc.tz(tz).format()]);
  plotOne('chart-all', sall, "", [dayjs(ext.min).tz(tz).format(), dayjs(ext.max).tz(tz).format()]);



  // Table activités
  const sum = await summaryByTag(startISO, endISO);
  const tbody = document.getElementById('tbl-acts');
  tbody.innerHTML = '';
  sum.sort((a,b)=>( (b.peaks/(b.duration||1)) - (a.peaks/(a.duration||1)) ));
  sum.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="py-2 pr-4">${r.tag}</td>
      <td class="py-2 px-4 text-right tabular-nums">${Math.round(r.duration||0)}</td>
      <td class="py-2 px-4 text-right tabular-nums">${r.peaks||0}</td>
      <td class="py-2 pl-4 text-right tabular-nums">${Math.round(( (r.peaks||0) / (r.duration||1) ))}</td>
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
    li.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="inline-block w-1.5 h-4 rounded bg-[${COLORS.pm25}]"></span>
        <span class="tabular-nums">${when}</span>
        <span class="ml-auto font-medium tabular-nums">${Math.round(p.value||0)} µg/m³</span>
      </div>`;
    ul.appendChild(li);
  });
}

async function reloadThrottled() {
  if (Date.now() - lastReload < MIN_INTERVAL_MS) {
    console.warn('Requête ignorée pour respecter la limite de fréquence');
    return;
  }
  lastReload = Date.now();
  await reloadForInputs();
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
