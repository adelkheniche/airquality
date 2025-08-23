# Air Quality Analysis Tool for Ceramics Workshop

A complete MVP for analyzing air quality in ceramics workshops, correlating sensor data with specific ceramic activities to assess health risks and provide recommendations.

## Features

- **Real-time air quality monitoring** with ESP32 sensors (PM1, PM2.5, PM10)
- **Activity annotation** with predefined hashtags for ceramic processes
- **Risk assessment** based on WHO guidelines and statistical analysis
- **Interactive visualizations** including day×hour heatmaps and trend analysis
- **Peak detection** with automated baseline calculation
- **Matched control analysis** comparing activity periods with non-activity periods

## Technology Stack

- **Frontend**: Static HTML/CSS/JavaScript hosted on GitHub Pages
- **Backend**: Supabase (PostgreSQL + Edge Functions)
- **Visualization**: Plotly.js for charts and heatmaps
- **Styling**: Tailwind CSS via CDN
- **Time handling**: Day.js with timezone support (Europe/Paris)

## Deployment Instructions

### 1. Setup Supabase Project

1. Go to the [Supabase dashboard](https://supabase.com/dashboard/projects)
2. Create a new project
3. Wait for the project to be fully provisioned

### 2. Configure Database Schema

1. In your Supabase project, go to the SQL Editor
2. Copy and paste the contents of `schema.sql` and execute it
3. Copy and paste the contents of `seed.sql` and execute it
4. Enable the `pg_cron` extension:
   - Go to Database → Extensions
   - Enable `pg_cron`

### 3. Deploy Edge Function

1. Install Supabase CLI: `npm install -g supabase`
2. Login: `supabase login`
3. Link your project: `supabase link --project-ref YOUR_PROJECT_REF`
4. Deploy the function: `supabase functions deploy ingest`

### 4. Configure Frontend

1. In your Supabase project dashboard, go to Settings → API
2. Copy your Project URL and anon/public key
3. Copy `config.example.js` to `config.js`
4. Update the values in `config.js`:
   ```javascript
   const SUPABASE_URL = 'your-project-url';
   const SUPABASE_ANON_KEY = 'your-anon-key';
   