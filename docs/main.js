// Initialize Day.js with UTC and Timezone plugins (for timezone conversion)
dayjs.extend(dayjs_plugin_utc);
dayjs.extend(dayjs_plugin_timezone);

// Alpine.js component state and methods
function dashboard() {
  return {
    // State variables
    peakCount: 0,
    peaksPerHour: 0.0,
    percentOver15: 0.0,
    peaksPerHourStatus: 'green',
    percentStatus: 'green',
    peaksList: [],
    summaryList: [],
    startDate: '',
    endDate: '',
    // Initialize component: fetch initial data range and default range data
    async init() {
      // Create Supabase client (using global config variables from config.js)
      const { createClient } = supabase;
      this.supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
      // Fetch the overall available date range (min and max timestamps)
      let { data: extent, error: err } = await this.supabase.rpc('readings_extent');
      if (err) {
        console.error('Error fetching data extent:', err);
        return;
      }
      if (extent && Array.isArray(extent)) extent = extent[0]; // ensure object
      // Determine default range: last 7 days or full range if shorter
      const maxTs = extent.max_ts || extent.max || extent.max_time;
      const minTs = extent.min_ts || extent.min || extent.min_time;
      const end = dayjs.utc(maxTs);
      const start = dayjs.utc(maxTs).subtract(6, 'day');
      const minData = dayjs.utc(minTs);
      // If data range is less than 7 days, use full range
      const finalStart = start.isBefore(minData) ? minData : start;
      // Set date inputs (in local Paris time, formatted as YYYY-MM-DD)
      this.startDate = finalStart.tz('Europe/Paris').format('YYYY-MM-DD');
      this.endDate = end.tz('Europe/Paris').format('YYYY-MM-DD');
      // Fetch initial data for this range
      await this.updateData();
    },
    // Fetch and update data for the current date range
    async updateData() {
      if (!this.supabase) return;
      // Convert selected date range from local (Europe/Paris) to UTC ISO timestamps
      const startUtc = new Date(this.startDate + 'T00:00:00').toISOString();
      const endUtc = new Date(this.endDate + 'T23:59:59').toISOString();
      // Perform RPC calls to Supabase for KPIs, time series, peaks, and summary
      const { data: kpiData, error: err1 } = await this.supabase.rpc('kpis_peaks_range', { start_ts: startUtc, end_ts: endUtc });
      const { data: seriesData, error: err2 } = await this.supabase.rpc('time_series_bucketed', { start_ts: startUtc, end_ts: endUtc });
      const { data: peaksData, error: err3 } = await this.supabase.rpc('peaks_in_range', { start_ts: startUtc, end_ts: endUtc });
      const { data: summaryData, error: err4 } = await this.supabase.rpc('summary_by_tag_range', { start_ts: startUtc, end_ts: endUtc });
      if (err1 || err2 || err3 || err4) {
        console.error('Erreur lors du chargement des données:', err1 || err2 || err3 || err4);
        return;
      }
      // Update KPI values
      let kpis = kpiData;
      if (Array.isArray(kpis)) kpis = kpis[0];
      if (kpis) {
        this.peakCount = kpis.total_peaks ?? kpis.peak_count ?? 0;
        this.peaksPerHour = kpis.peaks_per_hour ?? kpis.peak_per_hour ?? 0;
        this.percentOver15 = kpis.percent_over_15 ?? kpis.percent_over15 ?? 0;
      }
      // Determine status indicators based on thresholds
      const pph = this.peaksPerHour;
      const perc = this.percentOver15;
      this.peaksPerHourStatus = (pph > 2 ? 'red' : pph > 1 ? 'yellow' : 'green');
      this.percentStatus = (perc > 20 ? 'red' : perc > 10 ? 'yellow' : 'green');
      // Update time series charts using Plotly
      const timestamps = seriesData.map(d => d.ts || d.time);
      // Plot PM1
      Plotly.newPlot('chart-pm1', [{
        x: timestamps,
        y: seriesData.map(d => d.pm1),
        type: 'scatter',
        mode: 'lines',
        line: { color: '#2563EB', width: 2 }
      }], {
        title: 'PM1 (µg/m³)',
        margin: { t: 40, r: 20, b: 40, l: 50 },
        xaxis: { title: 'Date/Heure' },
        yaxis: { title: 'µg/m³' }
      }, { responsive: true });
      // Plot PM2.5
      Plotly.newPlot('chart-pm25', [{
        x: timestamps,
        y: seriesData.map(d => d.pm25 ?? d.pm2_5),
        type: 'scatter',
        mode: 'lines',
        line: { color: '#7C3AED', width: 2 }
      }], {
        title: 'PM2.5 (µg/m³)',
        margin: { t: 40, r: 20, b: 40, l: 50 },
        xaxis: { title: 'Date/Heure' },
        yaxis: { title: 'µg/m³' }
      }, { responsive: true });
      // Plot PM10
      Plotly.newPlot('chart-pm10', [{
        x: timestamps,
        y: seriesData.map(d => d.pm10),
        type: 'scatter',
        mode: 'lines',
        line: { color: '#CA8A04', width: 2 }
      }], {
        title: 'PM10 (µg/m³)',
        margin: { t: 40, r: 20, b: 40, l: 50 },
        xaxis: { title: 'Date/Heure' },
        yaxis: { title: 'µg/m³' }
      }, { responsive: true });
      // Update peaks list (array of peak events)
      this.peaksList = Array.isArray(peaksData) ? peaksData : (peaksData ? [peaksData] : []);
      // Update activities summary list (array of tag summaries)
      this.summaryList = Array.isArray(summaryData) ? summaryData : (summaryData ? [summaryData] : []);
    }
  }
}
