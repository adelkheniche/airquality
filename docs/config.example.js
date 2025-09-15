// Configuration for Air Quality Dashboard
// Copy this file to config.js and update with your Supabase credentials

const SUPABASE_URL = 'https://your-project-ref.supabase.co';
const SUPABASE_ANON_KEY = 'your-anon-public-key-here';

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
