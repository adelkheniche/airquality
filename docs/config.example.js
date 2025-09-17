// Configuration for Air Quality Dashboard
// Copy this file to config.js and update with your Supabase credentials

window.SUPABASE_URL = 'https://lzsrnaciqywpbdchgso.supabase.co/rest/v1/rpc/activities_site';
const ANON    = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6c3pybmFjaXF5d3BiZGNoZ3NvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4NzUyMDIsImV4cCI6MjA3MTQ1MTIwMn0.0AczSYj_8aAgVHh--jc0olbh3LVRMorO1MFilVR4dPY';
// Optional: Custom configuration
const CONFIG = {
    // Default date range in days (from today backwards)
    defaultDateRange: 7,
    
    // Timezone for display (data is always stored in UTC)
    displayTimezone: 'Europe/Paris',
    
    // Risk thresholds
    risk: {
        // % time over 15 µg/m³ thresholds
        over15_ok: 15,      // < 15% = OK
        over15_risk: 30,    // >= 30% = At Risk
        
        // Peaks per hour thresholds  
        peaks_ok: 0.5,      // < 0.5 = OK
        peaks_risk: 1.0     // >= 1.0 = At Risk
    },
    
    // WHO guidelines
    who: {
        pm25_24h_guideline: 15  // µg/m³
    },
    
    // Chart colors
    colors: {
        ok: '#10B981',      // Green
        monitor: '#F59E0B', // Amber
        risk: '#EF4444'     // Red
    }
};
