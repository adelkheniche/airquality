// Initialize Supabase client (replace with your actual project URL and anon key)
const supabaseUrl = "https://YOUR_SUPABASE_PROJECT_ID.supabase.co";
const supabaseKey = "YOUR_SUPABASE_ANON_KEY";
const supabase = supabase.createClient(supabaseUrl, supabaseKey);

// Data history buffers for sparkline charts (to store recent values)
const dataHistory = {
  aqi: [],
  pm25: [],
  temp: [],
  hum: [],
  co2: [],
  press: []
};

// Color mapping for each sparkline (matching Tailwind accent colors used)
const sparklineColors = {
  aqi: "#ef4444", // red-500
  pm25: "#22c55e", // green-500
  temp: "#eab308", // yellow-500 (amber)
  hum: "#3b82f6", // blue-500
  co2: "#ec4899", // pink-500
  press: "#8b5cf6" // violet-500
};

// Function to draw a sparkline on a canvas element
function drawSparkline(canvasId, dataArray, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || dataArray.length === 0) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (dataArray.length === 1) {
    // Only one point - draw a dot in the middle
    const y = h / 2;
    ctx.moveTo(0, y);
    ctx.lineTo(0.01, y);
  } else {
    // Scale data to canvas
    const max = Math.max(...dataArray);
    const min = Math.min(...dataArray);
    const range = (max - min) || 1;
    dataArray.forEach((val, idx) => {
      const x = (idx / (dataArray.length - 1)) * (w - 2) + 1; // 1px padding
      const y = h - 1 - ((val - min) / range) * (h - 2);
      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
  }
  ctx.stroke();
}

// Update UI with latest values and redraw sparklines
function updateUI(latest) {
  if (!latest) return;
  if (latest.aqi !== undefined) {
    document.getElementById('aqi-value').textContent = latest.aqi;
    drawSparkline('sparkline-aqi', dataHistory.aqi, sparklineColors.aqi);
  }
  if (latest.pm25 !== undefined) {
    document.getElementById('pm25-value').textContent = latest.pm25;
    drawSparkline('sparkline-pm25', dataHistory.pm25, sparklineColors.pm25);
  }
  if (latest.temperature !== undefined) {
    document.getElementById('temp-value').textContent = latest.temperature;
    drawSparkline('sparkline-temp', dataHistory.temp, sparklineColors.temp);
  }
  if (latest.humidity !== undefined) {
    document.getElementById('hum-value').textContent = latest.humidity;
    drawSparkline('sparkline-hum', dataHistory.hum, sparklineColors.hum);
  }
  if (latest.co2 !== undefined) {
    document.getElementById('co2-value').textContent = latest.co2;
    drawSparkline('sparkline-co2', dataHistory.co2, sparklineColors.co2);
  }
  if (latest.pressure !== undefined) {
    document.getElementById('press-value').textContent = latest.pressure;
    drawSparkline('sparkline-press', dataHistory.press, sparklineColors.press);
  }
}

// On page load, fetch recent data for all metrics to populate charts
supabase
  .from('AirQualityData') // replace with your table name
  .select('timestamp, aqi, pm25, temperature, humidity, co2, pressure')
  .order('timestamp', { ascending: false })
  .limit(50)
  .then(response => {
    const { data, error } = response;
    if (error) {
      console.error("Initial data fetch error:", error);
    }
    if (data && data.length > 0) {
      // Reverse to chronological order
      data.reverse();
      // Fill history arrays
      data.forEach(row => {
        if (row.aqi !== undefined) dataHistory.aqi.push(row.aqi);
        if (row.pm25 !== undefined) dataHistory.pm25.push(row.pm25);
        if (row.temperature !== undefined) dataHistory.temp.push(row.temperature);
        if (row.humidity !== undefined) dataHistory.hum.push(row.humidity);
        if (row.co2 !== undefined) dataHistory.co2.push(row.co2);
        if (row.pressure !== undefined) dataHistory.press.push(row.pressure);
      });
      // Update UI with the latest record
      updateUI(data[data.length - 1]);
    }
  });

// Subscribe to real-time inserts on the Supabase table to update dashboard live
supabase
  .channel('realtime:airquality') // channel name can be anything unique
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'AirQualityData' }, payload => {
    const newRow = payload.new;
    // Push new values into history (and trim to max 50 points)
    if (newRow.aqi !== undefined) {
      dataHistory.aqi.push(newRow.aqi);
      if (dataHistory.aqi.length > 50) dataHistory.aqi.shift();
    }
    if (newRow.pm25 !== undefined) {
      dataHistory.pm25.push(newRow.pm25);
      if (dataHistory.pm25.length > 50) dataHistory.pm25.shift();
    }
    if (newRow.temperature !== undefined) {
      dataHistory.temp.push(newRow.temperature);
      if (dataHistory.temp.length > 50) dataHistory.temp.shift();
    }
    if (newRow.humidity !== undefined) {
      dataHistory.hum.push(newRow.humidity);
      if (dataHistory.hum.length > 50) dataHistory.hum.shift();
    }
    if (newRow.co2 !== undefined) {
      dataHistory.co2.push(newRow.co2);
      if (dataHistory.co2.length > 50) dataHistory.co2.shift();
    }
    if (newRow.pressure !== undefined) {
      dataHistory.press.push(newRow.pressure);
      if (dataHistory.press.length > 50) dataHistory.press.shift();
    }
    // Update the UI with the new reading
    updateUI(newRow);
  })
  .subscribe();
