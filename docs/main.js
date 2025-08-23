// Air Quality Dashboard - Main JavaScript

// Initialize Day.js plugins
dayjs.extend(dayjs_plugin_utc);
dayjs.extend(dayjs_plugin_timezone);
dayjs.extend(dayjs_plugin_customParseFormat);

// Global variables
let supabase;
let tags = [];
let selectedTags = new Set();
let currentData = null;

// Initialize the application
document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Initialize Supabase client
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        
        // Initialize Feather icons
        feather.replace();
        
        // Set default date range (last 7 days)
        const today = dayjs().tz('Europe/Paris');
        const weekAgo = today.subtract(7, 'day');
        
        document.getElementById('date-from').value = weekAgo.format('YYYY-MM-DD');
        document.getElementById('date-to').value = today.format('YYYY-MM-DD');
        
        // Load initial data
        await initializeApp();
        
    } catch (error) {
        console.error('Initialization error:', error);
        showError('Initialization error: ' + error.message);
    }
});

async function initializeApp() {
    try {
        showLoading(true);
        
        // Check if we have valid Supabase configuration
        if (SUPABASE_URL.includes('your-project-ref') || SUPABASE_ANON_KEY.includes('your-anon-public-key')) {
            // Demo mode - show interface with sample data
            await initializeDemoMode();
        } else {
            // Production mode - connect to Supabase
            await loadTags();
            await refreshData();
        }
        
        // Setup event listeners
        setupEventListeners();
        
        showLoading(false);
        document.getElementById('main-content').classList.remove('hidden');
        
    } catch (error) {
        console.error('App initialization error:', error);
        showError('Data loading error: ' + error.message);
        showLoading(false);
    }
}

async function initializeDemoMode() {
    // Set up demo tags
    tags = [
        { id: '1', slug: 'four_emaillage' },
        { id: '2', slug: 'four_biscuit' },
        { id: '3', slug: 'coulage_platre' },
        { id: '4', slug: 'prep_barbotine' },
        { id: '5', slug: 'impr3d_cera' },
        { id: '6', slug: 'presence' },
        { id: '7', slug: 'fenetre_ouverte' },
        { id: '8', slug: 'masque' }
    ];
    
    // Set up demo data
    currentData = [
        {
            tag: 'four_emaillage',
            hours_observed: 8.5,
            pm25_median: 28.4,
            pm25_p95: 65.2,
            pct_over15: 75,
            peaks_per_hour: 1.2,
            auc_per_hour: 245
        },
        {
            tag: 'four_biscuit',
            hours_observed: 4.5,
            pm25_median: 22.1,
            pm25_p95: 42.8,
            pct_over15: 60,
            peaks_per_hour: 0.8,
            auc_per_hour: 180
        },
        {
            tag: 'presence',
            hours_observed: 32.0,
            pm25_median: 12.6,
            pm25_p95: 28.4,
            pct_over15: 25,
            peaks_per_hour: 0.3,
            auc_per_hour: 85
        },
        {
            tag: 'fenetre_ouverte',
            hours_observed: 12.5,
            pm25_median: 8.9,
            pm25_p95: 18.2,
            pct_over15: 8,
            peaks_per_hour: 0.1,
            auc_per_hour: 32
        }
    ];
    
    renderTagFilters();
    renderActivityTags();
    updateKPIs();
    updateActivitiesTable();
    updateStatusPills();
    
    // Show demo heatmap
    updateHeatmap(generateDemoHeatmapData());
    
    // Show demo peaks
    updatePeaksList(generateDemoPeaks());
    
    // Show demo mode notice
    showToast('Demo Mode: Using sample data. Configure Supabase credentials in config.js for real data.', 'info');
}

function generateDemoHeatmapData() {
    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    const data = [];
    
    days.forEach(day => {
        for (let hour = 0; hour < 24; hour++) {
            // Simulate higher PM2.5 during work hours
            let baseValue = 8;
            if (hour >= 8 && hour <= 17) baseValue = 18;
            if (hour >= 18 && hour <= 20) baseValue = 12;
            
            const value = baseValue + Math.random() * 10;
            data.push({
                day_of_week: day,
                hour_of_day: hour,
                median_pm25: value
            });
        }
    });
    
    return data;
}

function generateDemoPeaks() {
    return [
        {
            peak_id: '1',
            sensor_id: 'esp32-atelier-01',
            start_ts: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
            end_ts: new Date(Date.now() - 3300000).toISOString(),   // 55 min ago
            pm25_max: 45.6,
            baseline: 12.3,
            auc_above_baseline: 892,
            tags: 'four_emaillage,presence'
        },
        {
            peak_id: '2',
            sensor_id: 'esp32-atelier-01',
            start_ts: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
            end_ts: new Date(Date.now() - 6900000).toISOString(),   // 1h55m ago
            pm25_max: 32.1,
            baseline: 9.8,
            auc_above_baseline: 445,
            tags: 'prep_barbotine'
        }
    ];
}

async function loadTags() {
    try {
        const { data, error } = await supabase
            .from('tags')
            .select('id, slug')
            .order('slug');
        
        if (error) throw error;
        
        tags = data || [];
        renderTagFilters();
        renderActivityTags();
        
    } catch (error) {
        console.error('Error loading tags:', error);
        throw new Error('Unable to load hashtags');
    }
}

function renderTagFilters() {
    const container = document.getElementById('tag-filters');
    container.innerHTML = '';
    
    tags.forEach(tag => {
        const button = document.createElement('button');
        button.className = `tag-chip ${selectedTags.has(tag.id) ? 'selected' : ''}`;
        button.textContent = `#${tag.slug}`;
        button.onclick = () => toggleTag(tag.id);
        container.appendChild(button);
    });
}

function renderActivityTags() {
    const container = document.getElementById('activity-tags');
    container.innerHTML = '';
    
    tags.forEach(tag => {
        const div = document.createElement('div');
        div.className = 'flex items-center';
        div.innerHTML = `
            <input type="checkbox" id="tag-${tag.id}" class="tag-checkbox mr-2" value="${tag.id}">
            <label for="tag-${tag.id}" class="text-sm text-gray-700">#${tag.slug}</label>
        `;
        container.appendChild(div);
    });
}

function toggleTag(tagId) {
    if (selectedTags.has(tagId)) {
        selectedTags.delete(tagId);
    } else {
        selectedTags.add(tagId);
    }
    renderTagFilters();
}

function setupEventListeners() {
    // Filter controls
    document.getElementById('apply-filters').addEventListener('click', refreshData);
    
    // Modal controls
    document.getElementById('add-activity-btn').addEventListener('click', openActivityModal);
    document.getElementById('cancel-activity').addEventListener('click', closeActivityModal);
    document.getElementById('save-activity').addEventListener('click', saveActivity);
    
    // Export heatmap button
    document.getElementById('export-heatmap').addEventListener('click', () => {
        const button = document.getElementById('export-heatmap');
        button.disabled = true;
        button.innerHTML = '<i data-feather="loader" class="h-4 w-4 mr-2 animate-spin"></i>Export en cours...';
        
        Plotly.downloadImage('heatmap', {
            format: 'png',
            filename: 'heatmap-pm25-' + new Date().toISOString().split('T')[0],
            height: 480,
            width: 800,
            scale: 2
        }).then(() => {
            button.disabled = false;
            button.innerHTML = '<i data-feather="download" class="h-4 w-4 mr-2"></i>Exporter en PNG';
            feather.replace();
        }).catch(() => {
            button.disabled = false;
            button.innerHTML = '<i data-feather="download" class="h-4 w-4 mr-2"></i>Exporter en PNG';
            feather.replace();
            showToast('Erreur lors de l\'export', 'error');
        });
    });
    
    // Close modals on backdrop click
    document.getElementById('activity-modal').addEventListener('click', (e) => {
        if (e.target.id === 'activity-modal') closeActivityModal();
    });
}

async function refreshData() {
    try {
        showLoading(true);
        
        const fromDate = document.getElementById('date-from').value;
        const toDate = document.getElementById('date-to').value;
        
        if (!fromDate || !toDate) {
            throw new Error('Please select a date range');
        }
        
        // Convert to UTC for database queries
        const fromTs = dayjs.tz(fromDate + ' 00:00:00', 'Europe/Paris').utc().format();
        const toTs = dayjs.tz(toDate + ' 23:59:59', 'Europe/Paris').utc().format();
        
        // Load all data
        await Promise.all([
            loadKPIsAndActivities(fromTs, toTs),
            loadHeatmapData(fromTs, toTs),
            loadPeaksData(fromTs, toTs)
        ]);
        
        // Announce filter change
        const statusElement = document.getElementById('heatmap-status');
        if (statusElement) {
            statusElement.textContent = `Données filtrées pour la période du ${fromDate} au ${toDate}.`;
        }
        
        showLoading(false);
        
    } catch (error) {
        console.error('Error refreshing data:', error);
        showError('Error during refresh: ' + error.message);
        showLoading(false);
    }
}

async function loadKPIsAndActivities(fromTs, toTs) {
    try {
        const { data, error } = await supabase
            .rpc('summary_by_tag_range', {
                from_ts: fromTs,
                to_ts: toTs
            });
        
        if (error) throw error;
        
        currentData = data || [];
        
        // Calculate overall KPIs
        updateKPIs();
        
        // Update activities table
        updateActivitiesTable();
        
        // Update status pills
        updateStatusPills();
        
    } catch (error) {
        console.error('Error loading KPIs and activities:', error);
        throw error;
    }
}

function updateKPIs() {
    if (!currentData || currentData.length === 0) {
        document.getElementById('kpi-median').textContent = 'Insufficient data';
        document.getElementById('kpi-over15').textContent = 'Insufficient data';
        document.getElementById('kpi-peaks').textContent = 'Insufficient data';
        return;
    }
    
    // Calculate weighted averages based on hours observed
    let totalHours = 0;
    let weightedMedian = 0;
    let weightedOver15 = 0;
    let weightedPeaks = 0;
    
    currentData.forEach(row => {
        if (row.hours_observed > 0) {
            totalHours += row.hours_observed;
            weightedMedian += row.pm25_median * row.hours_observed;
            weightedOver15 += row.pct_over15 * row.hours_observed;
            weightedPeaks += row.peaks_per_hour * row.hours_observed;
        }
    });
    
    if (totalHours > 0) {
        document.getElementById('kpi-median').textContent = (weightedMedian / totalHours).toFixed(1) + ' µg/m³';
        document.getElementById('kpi-over15').textContent = Math.round(weightedOver15 / totalHours) + '%';
        document.getElementById('kpi-peaks').textContent = (weightedPeaks / totalHours).toFixed(1);
    } else {
        document.getElementById('kpi-median').textContent = 'No data';
        document.getElementById('kpi-over15').textContent = 'No data';
        document.getElementById('kpi-peaks').textContent = 'No data';
    }
}

function updateStatusPills() {
    const container = document.getElementById('status-pills');
    container.innerHTML = '';
    
    if (!currentData || currentData.length === 0) {
        container.innerHTML = '<div class="status-pill status-monitor"><i data-feather="help-circle" class="mr-2"></i>Insufficient data</div>';
        feather.replace();
        return;
    }
    
    // Calculate overall risk
    let totalHours = 0;
    let weightedOver15 = 0;
    let weightedPeaks = 0;
    
    currentData.forEach(row => {
        if (row.hours_observed > 0) {
            totalHours += row.hours_observed;
            weightedOver15 += row.pct_over15 * row.hours_observed;
            weightedPeaks += row.peaks_per_hour * row.hours_observed;
        }
    });
    
    if (totalHours === 0) {
        container.innerHTML = '<div class="status-pill status-monitor"><i data-feather="help-circle" class="mr-2"></i>No data</div>';
        feather.replace();
        return;
    }
    
    const avgOver15 = weightedOver15 / totalHours;
    const avgPeaks = weightedPeaks / totalHours;
    
    let status, icon, text;
    
    if (avgOver15 >= 30 || avgPeaks >= 1) {
        status = 'status-risk';
        icon = 'alert-triangle';
        text = 'At Risk';
    } else if (avgOver15 < 15 && avgPeaks < 0.5) {
        status = 'status-ok';
        icon = 'check-circle';
        text = 'OK';
    } else {
        status = 'status-monitor';
        icon = 'eye';
        text = 'Monitor';
    }
    
    container.innerHTML = `<div class="status-pill ${status}"><i data-feather="${icon}" class="mr-2"></i>${text}</div>`;
    feather.replace();
}

function updateActivitiesTable() {
    const tbody = document.getElementById('activities-tbody');
    tbody.innerHTML = '';
    
    if (!currentData || currentData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" class="px-6 py-4 text-center text-gray-500">No activity data available</td></tr>';
        return;
    }
    
    // Sort by % over 15 (descending)
    const sortedData = [...currentData].sort((a, b) => b.pct_over15 - a.pct_over15);
    
    sortedData.forEach(row => {
        if (row.hours_observed === 0) return;
        
        const tr = document.createElement('tr');
        
        // Calculate risk level
        let riskLevel, riskIcon, riskClass;
        if (row.pct_over15 >= 30 || row.peaks_per_hour >= 1) {
            riskLevel = 'At Risk';
            riskIcon = 'alert-triangle';
            riskClass = 'text-red-600';
        } else if (row.pct_over15 < 15 && row.peaks_per_hour < 0.5) {
            riskLevel = 'OK';
            riskIcon = 'check-circle';
            riskClass = 'text-green-600';
        } else {
            riskLevel = 'Monitor';
            riskIcon = 'eye';
            riskClass = 'text-amber-600';
        }
        
        // Generate recommendations
        let recommendations = '';
        if (row.pct_over15 > 20) {
            recommendations += '<span class="recommendation-icon mask" title="Wear a mask"><i data-feather="shield"></i></span>';
        }
        if (row.peaks_per_hour > 0.5) {
            recommendations += '<span class="recommendation-icon window" title="Open windows"><i data-feather="wind"></i></span>';
        }
        if (row.pm25_p95 > 30) {
            recommendations += '<span class="recommendation-icon night" title="Schedule at night"><i data-feather="moon"></i></span>';
        }
        
        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">#${row.tag}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${row.hours_observed.toFixed(1)}h</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${row.pm25_median.toFixed(1)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${row.pm25_p95.toFixed(1)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${Math.round(row.pct_over15)}%</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${row.peaks_per_hour.toFixed(1)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500 tabular-nums">${row.auc_per_hour.toFixed(0)}</td>
            <td class="px-6 py-4 whitespace-nowrap text-sm ${riskClass}">
                <i data-feather="${riskIcon}" class="inline mr-1"></i>${riskLevel}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${recommendations}</td>
        `;
        
        tbody.appendChild(tr);
    });
    
    feather.replace();
}

async function loadHeatmapData(fromTs, toTs) {
    try {
        // Get hourly medians for heatmap
        const { data, error } = await supabase
            .rpc('get_hourly_heatmap_data', {
                from_ts: fromTs,
                to_ts: toTs
            });
        
        if (error && error.message.includes('function get_hourly_heatmap_data')) {
            // Fallback to reading raw data if RPC doesn't exist
            const { data: readings, error: readingsError } = await supabase
                .from('readings')
                .select('ts, pm25')
                .gte('ts', fromTs)
                .lte('ts', toTs)
                .order('ts');
            
            if (readingsError) throw readingsError;
            
            updateHeatmap(processHeatmapData(readings));
        } else if (error) {
            throw error;
        } else {
            updateHeatmap(data);
        }
        
    } catch (error) {
        console.error('Error loading heatmap data:', error);
        document.getElementById('heatmap').innerHTML = '<div class="flex items-center justify-center h-full text-gray-500">Error loading heatmap data</div>';
    }
}

function processHeatmapData(readings) {
    const heatmapData = {};
    
    readings.forEach(reading => {
        const date = dayjs.utc(reading.ts).tz('Europe/Paris');
        const dayOfWeek = date.format('dddd');
        const hour = date.hour();
        
        const key = `${dayOfWeek}-${hour}`;
        if (!heatmapData[key]) {
            heatmapData[key] = [];
        }
        heatmapData[key].push(reading.pm25);
    });
    
    // Calculate medians
    const result = [];
    Object.keys(heatmapData).forEach(key => {
        const [dayOfWeek, hour] = key.split('-');
        const values = heatmapData[key].sort((a, b) => a - b);
        const median = values[Math.floor(values.length / 2)];
        
        result.push({
            day_of_week: dayOfWeek,
            hour_of_day: parseInt(hour),
            median_pm25: median
        });
    });
    
    return result;
}

function renderHeatmap(data) {
    if (!data || data.length === 0) {
        document.getElementById('heatmap').innerHTML = '<div class="flex items-center justify-center h-full text-gray-500">Données insuffisantes pour la carte de chaleur</div>';
        document.getElementById('busy-hours-summary').textContent = '';
        return;
    }
    
    // French day labels as required
    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
    
    // Hour labels every 2h: 00h, 02h, ..., 22h
    const hourLabels = [];
    const hourTicks = [];
    for (let i = 0; i < 24; i++) {
        if (i % 2 === 0) {
            hourLabels.push(`${i.toString().padStart(2, '0')}h`);
            hourTicks.push(i);
        }
    }
    
    // Create 7×24 matrix
    const z = Array(7).fill().map(() => Array(24).fill(null));
    const text = Array(7).fill().map(() => Array(24).fill(''));
    
    data.forEach(row => {
        const dayIndex = days.indexOf(row.day_of_week);
        const hourIndex = row.hour_of_day;
        
        if (dayIndex >= 0 && hourIndex >= 0 && hourIndex < 24) {
            // Clamp values to [5, 75] range
            const clampedValue = Math.max(5, Math.min(75, row.median_pm25));
            z[dayIndex][hourIndex] = clampedValue;
            
            // French tooltip format: "Mardi 14h — 22,3 µg/m³"
            const hourStr = `${hourIndex.toString().padStart(2, '0')}h`;
            text[dayIndex][hourIndex] = `${row.day_of_week} ${hourStr} — ${row.median_pm25.toFixed(1).replace('.', ',')} µg/m³`;
        }
    });
    
    const trace = {
        z: z,
        x: Array.from({length: 24}, (_, i) => i), // 0-23 for hour indices
        y: days,
        text: text,
        hovertemplate: '%{text}<extra></extra>',
        type: 'heatmap',
        colorscale: 'Viridis',
        zmin: 5,
        zmax: 75,
        colorbar: {
            title: {
                text: 'PM2.5 (µg/m³)',
                font: { size: 14, family: 'system-ui, sans-serif' }
            },
            titleside: 'right',
            tickmode: 'array',
            tickvals: [10, 15, 25, 50, 75],
            ticktext: ['10', '15', '25', '50', '75'],
            tickfont: { size: 12, family: 'system-ui, sans-serif' },
            len: 0.8
        },
        showscale: true
    };
    
    const layout = {
        xaxis: {
            title: {
                text: 'Heure de la journée',
                font: { size: 14, family: 'system-ui, sans-serif' }
            },
            tickmode: 'array',
            tickvals: hourTicks,
            ticktext: hourLabels,
            tickfont: { size: 12, family: 'system-ui, sans-serif' },
            side: 'bottom',
            showgrid: true,
            gridcolor: 'rgba(0,0,0,0.1)',
            gridwidth: 1
        },
        yaxis: {
            title: {
                text: 'Jour de la semaine',
                font: { size: 14, family: 'system-ui, sans-serif' }
            },
            tickfont: { size: 12, family: 'system-ui, sans-serif' },
            showgrid: true,
            gridcolor: 'rgba(0,0,0,0.1)',
            gridwidth: 1
        },
        margin: { t: 30, r: 120, b: 80, l: 120 },
        font: { 
            family: 'system-ui, sans-serif',
            variant: 'tabular-nums'
        },
        paper_bgcolor: 'white',
        plot_bgcolor: 'white'
    };
    
    const config = {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d', 'resetScale2d'],
        toImageButtonOptions: {
            format: 'png',
            filename: 'heatmap-pm25',
            height: 480,
            width: 800,
            scale: 2
        }
    };
    
    Plotly.newPlot('heatmap', [trace], layout, config);
    
    // Generate and display busy hours summary
    const busyHoursSummary = computeBusyHoursSummary(z);
    document.getElementById('busy-hours-summary').textContent = busyHoursSummary;
    
    // Announce the update for screen readers
    announceHeatmapUpdate(data.length);
}

function computeBusyHoursSummary(matrix7x24) {
    if (!matrix7x24 || matrix7x24.length === 0) return '';
    
    // Calculate average PM2.5 by hour across all days
    const hourlyAverages = [];
    for (let hour = 0; hour < 24; hour++) {
        const values = [];
        for (let day = 0; day < 7; day++) {
            if (matrix7x24[day][hour] !== null) {
                values.push(matrix7x24[day][hour]);
            }
        }
        
        if (values.length > 0) {
            const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
            hourlyAverages[hour] = avg;
        } else {
            hourlyAverages[hour] = null;
        }
    }
    
    // Find hours above 75th percentile
    const validAverages = hourlyAverages.filter(avg => avg !== null);
    if (validAverages.length === 0) return '';
    
    validAverages.sort((a, b) => a - b);
    const threshold = validAverages[Math.floor(validAverages.length * 0.75)];
    
    // Group consecutive busy hours into ranges
    const busyHours = [];
    for (let hour = 0; hour < 24; hour++) {
        if (hourlyAverages[hour] && hourlyAverages[hour] >= threshold) {
            busyHours.push(hour);
        }
    }
    
    if (busyHours.length === 0) return '';
    
    // Create ranges from consecutive hours
    const ranges = [];
    let start = busyHours[0];
    let end = busyHours[0];
    
    for (let i = 1; i < busyHours.length; i++) {
        if (busyHours[i] === end + 1) {
            end = busyHours[i];
        } else {
            ranges.push(start === end ? `${start}h` : `${start}–${end}h`);
            start = end = busyHours[i];
        }
    }
    ranges.push(start === end ? `${start}h` : `${start}–${end}h`);
    
    return `Heures les plus chargées cette période : ${ranges.join(', ')}.`;
}

function announceHeatmapUpdate(dataPointCount) {
    const statusElement = document.getElementById('heatmap-status');
    if (statusElement) {
        statusElement.textContent = `Carte de chaleur mise à jour avec ${dataPointCount} points de données.`;
    }
}

function updateHeatmap(data) {
    renderHeatmap(data);
}

async function loadPeaksData(fromTs, toTs) {
    try {
        const { data, error } = await supabase
            .rpc('peaks_in_range', {
                from_ts: fromTs,
                to_ts: toTs
            });
        
        if (error) throw error;
        
        updatePeaksList(data || []);
        
    } catch (error) {
        console.error('Error loading peaks data:', error);
        document.getElementById('peaks-list').innerHTML = '<div class="text-center text-gray-500 py-4">Error loading peaks</div>';
    }
}

function updatePeaksList(peaks) {
    const container = document.getElementById('peaks-list');
    
    if (!peaks || peaks.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-500 py-4">No peaks detected in selected period</div>';
        return;
    }
    
    const peaksHtml = peaks.map(peak => {
        const startTime = dayjs.utc(peak.start_ts).tz('Europe/Paris');
        const endTime = dayjs.utc(peak.end_ts).tz('Europe/Paris');
        const duration = endTime.diff(startTime, 'minute');
        const deltaBaseline = peak.pm25_max - peak.baseline;
        
        // Determine severity
        let severityClass;
        if (deltaBaseline >= 50) {
            severityClass = 'severity-high';
        } else if (deltaBaseline >= 25) {
            severityClass = 'severity-medium';
        } else {
            severityClass = 'severity-low';
        }
        
        // Format tags
        const tagsHtml = peak.tags ? 
            peak.tags.split(',').map(tag => `<span class="tag-chip">#${tag}</span>`).join('') : 
            '<span class="text-gray-400">No tags</span>'
        
        return `
            <div class="flex items-start p-4 border-b border-gray-200 last:border-b-0">
                <div class="peak-severity ${severityClass}"></div>
                <div class="flex-1">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <div class="font-medium text-gray-900">
                                ${startTime.format('DD/MM/YYYY HH:mm')} – ${endTime.format('HH:mm')}
                            </div>
                            <div class="text-sm text-gray-500">
                                Duration: ${duration} min
                            </div>
                        </div>
                        <div class="text-right">
                            <div class="font-semibold text-gray-900">${peak.pm25_max.toFixed(1)} µg/m³</div>
                            <div class="text-sm text-gray-500">+${deltaBaseline.toFixed(1)} vs baseline</div>
                        </div>
                    </div>
                    <div class="flex justify-between items-center">
                        <div class="text-sm">
                            <span class="text-gray-600">AUC:</span> 
                            <span class="font-medium">${peak.auc_above_baseline.toFixed(0)} µg·min/m³</span>
                        </div>
                        <div class="text-sm">
                            ${tagsHtml}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = peaksHtml;
}

// Modal functions
function openActivityModal() {
    document.getElementById('activity-modal').classList.remove('hidden');
    // Set default times to current time
    const now = dayjs().tz('Europe/Paris');
    document.getElementById('start-datetime').value = now.format('YYYY-MM-DDTHH:mm');
    document.getElementById('end-datetime').value = now.add(1, 'hour').format('YYYY-MM-DDTHH:mm');
}

function closeActivityModal() {
    document.getElementById('activity-modal').classList.add('hidden');
    document.getElementById('activity-form').reset();
}

async function saveActivity() {
    try {
        const startDatetime = document.getElementById('start-datetime').value;
        const endDatetime = document.getElementById('end-datetime').value;
        const note = document.getElementById('activity-note').value;
        
        if (!startDatetime || !endDatetime) {
            throw new Error('Please enter start and end times');
        }
        
        // Convert to UTC
        const startTs = dayjs.tz(startDatetime, 'Europe/Paris').utc().format();
        const endTs = dayjs.tz(endDatetime, 'Europe/Paris').utc().format();
        
        if (dayjs(endTs).isBefore(dayjs(startTs))) {
            throw new Error('End time must be after start time');
        }
        
        // Get selected tags
        const selectedTagIds = Array.from(document.querySelectorAll('#activity-tags input:checked'))
            .map(checkbox => checkbox.value);
        
        if (selectedTagIds.length === 0) {
            throw new Error('Please select at least one hashtag');
        }
        
        // Insert activity
        const { data: activity, error: activityError } = await supabase
            .from('activity_intervals')
            .insert([{
                start_ts: startTs,
                end_ts: endTs,
                note: note || null
            }])
            .select()
            .single();
        
        if (activityError) throw activityError;
        
        // Insert activity tags
        const activityTags = selectedTagIds.map(tagId => ({
            activity_id: activity.id,
            tag_id: tagId
        }));
        
        const { error: tagsError } = await supabase
            .from('activity_tags')
            .insert(activityTags);
        
        if (tagsError) throw tagsError;
        
        showToast('Activity added successfully', 'success');
        closeActivityModal();
        await refreshData();
        
    } catch (error) {
        console.error('Error saving activity:', error);
        showToast('Error saving: ' + error.message, 'error');
    }
}


// Utility functions
function showLoading(show) {
    document.getElementById('loading').classList.toggle('hidden', !show);
}

function showError(message) {
    document.getElementById('error').classList.remove('hidden');
    document.getElementById('error-message').textContent = message;
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const icons = {
        success: 'check-circle',
        error: 'x-circle',
        warning: 'alert-triangle',
        info: 'info'
    };
    
    toast.innerHTML = `
        <i data-feather="${icons[type]}" class="mr-2"></i>
        <span>${message}</span>
    `;
    
    container.appendChild(toast);
    feather.replace();
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        toast.remove();
    }, 5000);
}
