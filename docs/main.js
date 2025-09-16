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

const rollEasing = cubicBezier(0.2, 0.6, 0.2, 1);

const metricAnimator = createMetricAnimator();
metricAnimator.register('kpi-peaks', { baseDigits: 4 });
metricAnimator.register('kpi-last', { baseDigits: 3 });
metricAnimator.register('kpi-pct', { baseDigits: 3 });

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
  const rollers = [];
  const map = new Map();
  const reduceQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  let prefersReduced = !!(reduceQuery && reduceQuery.matches);
  const DEFAULT_ROLL_DURATION_RANGE_MS = [300, 500];
  const MAX_PENDING_ANIMATION_MS = 320;

  class MetricRoller {
    constructor(el, opts = {}) {
      this.el = el;
      const customRange = Array.isArray(opts.durationRange)
        ? opts.durationRange.slice(0, 2)
        : null;
      this.durationRange = customRange || DEFAULT_ROLL_DURATION_RANGE_MS;
      this.baseDigits = opts.baseDigits ?? 3;
      this.prefersReduced = prefersReduced;
      this.isAnimating = false;
      this.frame = null;
      this.pendingValue = null;
      this.displayedStamp = null;
      this.currentTargetSlot = null;
      this.prefix = '';
      this.suffix = '';
      this.digitsCount = 0;
      this.animationStart = null;
      this.currentValue = MetricRoller.normalizeValue(el.textContent || '–');

      this.track = document.createElement('span');
      this.track.className = 'kpi-roller-track';
      const slot = this.createSlot(this.currentValue);
      this.track.appendChild(slot);
      el.textContent = '';
      el.appendChild(this.track);
      this.updateFormatFromValue(this.currentValue, { preview: true });
      this.setImmediate(this.currentValue);
    }

    static normalizeValue(value) {
      if (value === null || value === undefined) return '–';
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '–';
        return value.toString();
      }
      const str = String(value);
      const trimmed = str.trim();
      return trimmed.length ? trimmed : '–';
    }

    updatePreference(reduce) {
      this.prefersReduced = reduce;
      if (reduce) {
        const text = this.pendingValue
          ?? (this.currentTargetSlot && this.currentTargetSlot.textContent)
          ?? this.currentValue;
        this.setImmediate(text);
      }
    }

    createSlot(text) {
      const slot = document.createElement('span');
      slot.className = 'kpi-roller-slot';
      slot.textContent = text;
      return slot;
    }

    updateFormatFromValue(value, { preview = false } = {}) {
      const str = MetricRoller.normalizeValue(value);
      const trimmed = str.trim();
      if (trimmed && /\d/.test(trimmed)) {
        const match = trimmed.match(/^([^\d]*)([\d\s.,]*)(.*)$/);
        if (match) {
          const [, prefix, digitsPart, suffix] = match;
          const digitsOnly = digitsPart.replace(/[^\d]/g, '');
          if (digitsOnly.length) {
            this.prefix = prefix;
            this.suffix = suffix;
            this.digitsCount = Math.max(digitsOnly.length, this.digitsCount || 0);
          }
        }
      }
      if (preview) this.updateMinWidth();
      return str;
    }

    updateMinWidth() {
      const digits = Math.max(this.baseDigits, this.digitsCount || 0);
      const prefixLen = this.prefix ? this.prefix.length : 0;
      const suffixLen = this.suffix ? this.suffix.length : 0;
      const widthCh = digits + prefixLen + suffixLen + 0.5;
      this.el.style.setProperty('--roller-min-width', `${widthCh}ch`);
    }

    runCycle() {
      if (this.prefersReduced || this.isAnimating) return;
      if (this.pendingValue == null) return;
      const value = this.pendingValue;
      this.pendingValue = null;
      this.animateTo(value, { isFinal: true });
    }

    animateTo(value, { isFinal }) {
      const slot = this.createSlot(value);
      slot.classList.add('is-rolling-in');
      this.track.appendChild(slot);
      const siblings = this.track.children;
      const prevSlot = siblings.length > 1 ? siblings[siblings.length - 2] : null;
      if (prevSlot) prevSlot.classList.add('is-rolling-out');

      const prevHeight = prevSlot ? prevSlot.getBoundingClientRect().height : 0;
      const slotHeight = slot.getBoundingClientRect().height;
      let distance = prevHeight || slotHeight || this.el.getBoundingClientRect().height || 0;
      if (!distance) distance = this.el.offsetHeight || 0;
      const [minDuration, maxDuration] = this.durationRange;
      const duration = Math.round(randomBetween(minDuration, maxDuration));
      const start = performance.now();
      this.isAnimating = true;
      this.animationStart = start;
      this.currentTargetSlot = slot;
      this.el.classList.add('is-rolling');

      const step = now => {
        const elapsed = now - start;
        const t = Math.min(Math.max(elapsed / duration, 0), 1);
        const eased = rollEasing(t);
        const translate = -distance * eased;
        const blur = (1 - Math.pow(eased, 0.6)) * 4;
        this.track.style.transform = `translateY(${translate}px)`;
        this.track.style.filter = `blur(${blur.toFixed(3)}px)`;
        if (t < 1) {
          this.frame = requestAnimationFrame(step);
        } else {
          this.finishCycle(value, slot, prevSlot, isFinal);
        }
      };
      this.frame = requestAnimationFrame(step);
    }

    finishCycle(value, slot, prevSlot) {
      this.track.style.transform = '';
      this.track.style.filter = '';
      if (prevSlot && prevSlot.parentNode === this.track) {
        this.track.removeChild(prevSlot);
      }
      slot.classList.remove('is-rolling-in');
      if (prevSlot) prevSlot.classList.remove('is-rolling-out');

      this.currentValue = value;
      this.currentTargetSlot = null;
      this.isAnimating = false;
      this.animationStart = null;
      this.el.classList.remove('is-rolling');
      this.updateFormatFromValue(value);
      this.updateMinWidth();

      if (this.pendingValue != null) {
        this.runCycle();
      }
    }

    stop() {
      if (this.frame) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.isAnimating = false;
      this.animationStart = null;
      this.pendingValue = null;
      this.currentTargetSlot = null;
      this.track.style.transform = '';
      this.track.style.filter = '';
      while (this.track.children.length > 1) {
        this.track.removeChild(this.track.firstElementChild);
      }
      this.el.classList.remove('is-rolling');
    }

    setImmediate(value) {
      const text = this.updateFormatFromValue(value, { preview: true });
      this.stop();
      this.track.innerHTML = '';
      const slot = this.createSlot(text);
      this.track.appendChild(slot);
      this.currentValue = text;
      this.updateMinWidth();
    }

    commit(value, stamp) {
      const text = this.updateFormatFromValue(value, { preview: true });
      if (this.prefersReduced) {
        this.displayedStamp = stamp;
        this.setImmediate(text);
        return;
      }
      if (stamp != null && this.displayedStamp === stamp) {
        if (this.currentValue !== text) {
          this.setImmediate(text);
        }
        return;
      }

      const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();

      if (this.isAnimating && this.animationStart != null) {
        const elapsed = now - this.animationStart;
        if (elapsed > MAX_PENDING_ANIMATION_MS) {
          this.displayedStamp = stamp;
          this.setImmediate(text);
          return;
        }
      }

      this.displayedStamp = stamp;

      if (!this.isAnimating && this.currentValue === text) {
        return;
      }

      this.pendingValue = text;

      if (this.currentTargetSlot) {
        this.currentTargetSlot.textContent = text;
      }

      if (!this.isAnimating) {
        this.runCycle();
      }
    }
  }

  if (reduceQuery) {
    const onChange = event => {
      prefersReduced = event.matches;
      rollers.forEach(roller => roller.updatePreference(prefersReduced));
    };
    if (typeof reduceQuery.addEventListener === 'function') {
      reduceQuery.addEventListener('change', onChange);
    } else if (typeof reduceQuery.addListener === 'function') {
      reduceQuery.addListener(onChange);
    }
  }

  function register(id, options) {
    const el = document.getElementById(id);
    if (!el) return null;
    const roller = new MetricRoller(el, options);
    rollers.push(roller);
    map.set(id, roller);
    return roller;
  }

  function beginCycle(stamp) {
    if (stamp == null) return;
  }

  function setValue(id, value, stamp) {
    const roller = map.get(id);
    if (!roller) return;
    roller.commit(value, stamp);
  }

  return { register, beginCycle, setValue };
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function cubicBezier(mX1, mY1, mX2, mY2) {
  const NEWTON_ITERATIONS = 4;
  const NEWTON_MIN_SLOPE = 0.001;
  const SUBDIVISION_PRECISION = 1e-7;
  const SUBDIVISION_MAX_ITERATIONS = 10;
  const kSplineTableSize = 11;
  const kSampleStepSize = 1 / (kSplineTableSize - 1);

  const sampleValues = new Float32Array(kSplineTableSize);
  if (!(mX1 === mY1 && mX2 === mY2)) {
    for (let i = 0; i < kSplineTableSize; ++i) {
      sampleValues[i] = calcBezier(i * kSampleStepSize, mX1, mX2);
    }
  }

  function calcBezier(t, a1, a2) {
    return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + (3 * a1) * t;
  }

  function getSlope(t, a1, a2) {
    return 3 * ((1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + (3 * a1));
  }

  function binarySubdivide(x, a, b) {
    let currentX;
    let currentT;
    let i = 0;
    do {
      currentT = a + (b - a) / 2;
      currentX = calcBezier(currentT, mX1, mX2) - x;
      if (currentX > 0) {
        b = currentT;
      } else {
        a = currentT;
      }
    } while (Math.abs(currentX) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
    return currentT;
  }

  function getTForX(x) {
    let intervalStart = 0;
    let currentSample = 1;
    const lastSample = kSplineTableSize - 1;

    for (; currentSample !== lastSample && sampleValues[currentSample] <= x; ++currentSample) {
      intervalStart += kSampleStepSize;
    }
    --currentSample;

    const sampleDelta = sampleValues[currentSample + 1] - sampleValues[currentSample];
    const dist = sampleDelta ? (x - sampleValues[currentSample]) / sampleDelta : 0;
    let guessForT = intervalStart + dist * kSampleStepSize;

    const initialSlope = getSlope(guessForT, mX1, mX2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      for (let i = 0; i < NEWTON_ITERATIONS; ++i) {
        const currentX = calcBezier(guessForT, mX1, mX2) - x;
        guessForT -= currentX / getSlope(guessForT, mX1, mX2);
      }
      return guessForT;
    }
    if (initialSlope === 0) {
      return guessForT;
    }
    return binarySubdivide(x, intervalStart, intervalStart + kSampleStepSize);
  }

  return function bezier(x) {
    if (mX1 === mY1 && mX2 === mY2) return x;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return calcBezier(getTForX(x), mY1, mY2);
  };
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
  '24h': 'Aujourd’hui (24 h)',
  '7d': '7 jours',
  '30d': '30 jours',
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
    '7d':  { start: clampStart(latest.subtract(7, 'day')),  end: latest },
    '30d': { start: clampStart(latest.subtract(30, 'day')), end: latest },
    'all': { start: earliest, end: latest }
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

  if (lastVal) {
    const val = lastVal.pm25 != null ? Math.round(lastVal.pm25) : null;
    const displayVal = val != null ? val.toString() : '–';
    metricAnimator.setValue('kpi-last', displayVal, datasetStamp);
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
    if (timeEl) timeEl.textContent = 'Pas de relevé';
    if (arrowEl) {
      arrowEl.textContent = '';
      arrowEl.className = 'kpi-trend-icon';
    }
  }

  plotRange(currentRange);

  const summaryRange = DATASETS['7d'] ?? DATASETS['all'];
  const summaryStartISO = summaryRange?.rangeStartISO ?? earliest.toISOString();
  const summaryEndISO = summaryRange?.rangeEndISO ?? latest.toISOString();
  const sum = await summaryByTag(summaryStartISO, summaryEndISO);
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
