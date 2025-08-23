-- Air Quality Analysis Tool - Database Schema
-- PostgreSQL schema for Supabase

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- Drop existing objects (for clean reinstall)
DROP MATERIALIZED VIEW IF EXISTS mv_peaks CASCADE;
DROP MATERIALIZED VIEW IF EXISTS mv_baseline_hourly CASCADE;
DROP VIEW IF EXISTS vw_peaks_with_tags CASCADE;
DROP FUNCTION IF EXISTS summary_by_tag_range(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS peaks_in_range(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS get_hourly_heatmap_data(timestamptz, timestamptz);

-- Tables
DROP TABLE IF EXISTS activity_tags CASCADE;
DROP TABLE IF EXISTS activity_intervals CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
DROP TABLE IF EXISTS readings CASCADE;
DROP TABLE IF EXISTS device_tokens CASCADE;

-- Create tables
CREATE TABLE device_tokens (
    sensor_id text PRIMARY KEY,
    token_sha256 text NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE readings (
    ts timestamptz NOT NULL,
    sensor_id text NOT NULL,
    pm1 real,
    pm25 real,
    pm10 real,
    temp_c real,
    rh real,
    PRIMARY KEY (ts, sensor_id)
);

CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text UNIQUE NOT NULL,
    created_at timestamptz DEFAULT now()
);

CREATE TABLE activity_intervals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    start_ts timestamptz NOT NULL,
    end_ts timestamptz NOT NULL,
    note text,
    created_at timestamptz DEFAULT now(),
    CONSTRAINT valid_interval CHECK (end_ts > start_ts)
);

CREATE TABLE activity_tags (
    activity_id uuid REFERENCES activity_intervals(id) ON DELETE CASCADE,
    tag_id uuid REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (activity_id, tag_id)
);

-- Indexes for performance
CREATE INDEX idx_readings_ts ON readings(ts);
CREATE INDEX idx_readings_sensor_ts ON readings(sensor_id, ts);
CREATE INDEX idx_activity_intervals_start_end ON activity_intervals(start_ts, end_ts);
CREATE INDEX idx_activity_intervals_overlap ON activity_intervals USING gist (tstzrange(start_ts, end_ts));
CREATE INDEX idx_activity_tags_activity ON activity_tags(activity_id);
CREATE INDEX idx_activity_tags_tag ON activity_tags(tag_id);

-- Materialized View: Hourly baseline (14 days rolling)
CREATE MATERIALIZED VIEW mv_baseline_hourly AS
WITH recent_data AS (
    SELECT 
        EXTRACT(hour FROM ts AT TIME ZONE 'Europe/Paris') AS hod,
        pm25
    FROM readings 
    WHERE ts >= now() - interval '14 days'
        AND pm25 IS NOT NULL
),
hourly_medians AS (
    SELECT 
        hod,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY pm25) AS median_pm25
    FROM recent_data
    GROUP BY hod
),
hourly_mad AS (
    SELECT 
        rd.hod,
        hm.median_pm25,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ABS(rd.pm25 - hm.median_pm25)) AS mad_pm25
    FROM recent_data rd
    JOIN hourly_medians hm ON rd.hod = hm.hod
    GROUP BY rd.hod, hm.median_pm25
)
SELECT 
    hod::int,
    median_pm25::real,
    mad_pm25::real
FROM hourly_mad
ORDER BY hod;

CREATE UNIQUE INDEX idx_mv_baseline_hourly_hod ON mv_baseline_hourly(hod);

-- Materialized View: Peak detection
CREATE MATERIALIZED VIEW mv_peaks AS
WITH readings_with_baseline AS (
    SELECT 
        r.ts,
        r.sensor_id,
        r.pm25,
        EXTRACT(hour FROM r.ts AT TIME ZONE 'Europe/Paris') AS hod,
        b.median_pm25 AS baseline,
        b.mad_pm25,
        GREATEST(25.0, b.median_pm25 + 2 * b.mad_pm25) AS threshold
    FROM readings r
    LEFT JOIN mv_baseline_hourly b ON EXTRACT(hour FROM r.ts AT TIME ZONE 'Europe/Paris') = b.hod
    WHERE r.pm25 IS NOT NULL
),
peak_bins AS (
    SELECT 
        *,
        (r.pm25 > r.threshold) AS is_peak,
        EXTRACT(epoch FROM ts)::int / 900 AS bin_index
    FROM readings_with_baseline r
),
peak_groups AS (
    SELECT 
        sensor_id,
        bin_index,
        is_peak,
        COUNT(*) AS bin_count,
        MIN(ts) AS start_ts,
        MAX(ts) AS end_ts,
        MAX(pm25) AS pm25_max,
        AVG(baseline) AS baseline,
        SUM(GREATEST(0, pm25 - baseline)) * 15 AS auc_above_baseline
    FROM peak_bins
    WHERE is_peak = true
    GROUP BY sensor_id, bin_index, is_peak
),
contiguous_peaks AS (
    SELECT 
        sensor_id,
        start_ts,
        end_ts,
        pm25_max,
        baseline,
        auc_above_baseline,
        ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY start_ts) -
        ROW_NUMBER() OVER (PARTITION BY sensor_id, 
                          bin_index - ROW_NUMBER() OVER (PARTITION BY sensor_id ORDER BY start_ts)
                          ORDER BY start_ts) AS group_id
    FROM peak_groups
)
SELECT 
    gen_random_uuid() AS peak_id,
    sensor_id,
    MIN(start_ts) AS start_ts,
    MAX(end_ts) AS end_ts,
    MAX(pm25_max) AS pm25_max,
    AVG(baseline) AS baseline,
    SUM(auc_above_baseline) AS auc_above_baseline
FROM contiguous_peaks
GROUP BY sensor_id, group_id
ORDER BY start_ts;

CREATE INDEX idx_mv_peaks_start_end ON mv_peaks(start_ts, end_ts);
CREATE INDEX idx_mv_peaks_sensor ON mv_peaks(sensor_id);

-- View: Peaks with associated tags
CREATE VIEW vw_peaks_with_tags AS
SELECT 
    p.*,
    string_agg(t.slug, ',' ORDER BY t.slug) AS tags
FROM mv_peaks p
LEFT JOIN activity_intervals ai ON 
    ai.start_ts <= p.end_ts AND ai.end_ts >= p.start_ts
LEFT JOIN activity_tags at ON at.activity_id = ai.id
LEFT JOIN tags t ON t.id = at.tag_id
GROUP BY p.peak_id, p.sensor_id, p.start_ts, p.end_ts, p.pm25_max, p.baseline, p.auc_above_baseline;

-- Function: Get hourly heatmap data
CREATE OR REPLACE FUNCTION get_hourly_heatmap_data(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE(
    day_of_week text,
    hour_of_day int,
    median_pm25 real
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    WITH hourly_readings AS (
        SELECT 
            TO_CHAR(ts AT TIME ZONE 'Europe/Paris', 'Day') AS day_of_week,
            EXTRACT(hour FROM ts AT TIME ZONE 'Europe/Paris')::int AS hour_of_day,
            pm25
        FROM readings 
        WHERE ts >= from_ts AND ts <= to_ts
            AND pm25 IS NOT NULL
    )
    SELECT 
        TRIM(hr.day_of_week) AS day_of_week,
        hr.hour_of_day,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY hr.pm25)::real AS median_pm25
    FROM hourly_readings hr
    GROUP BY TRIM(hr.day_of_week), hr.hour_of_day
    HAVING COUNT(*) >= 3  -- Require at least 3 readings for reliable median
    ORDER BY 
        CASE TRIM(hr.day_of_week)
            WHEN 'Monday' THEN 1
            WHEN 'Tuesday' THEN 2
            WHEN 'Wednesday' THEN 3
            WHEN 'Thursday' THEN 4
            WHEN 'Friday' THEN 5
            WHEN 'Saturday' THEN 6
            WHEN 'Sunday' THEN 7
        END,
        hr.hour_of_day;
$$;

-- Function: Summary by tag and date range
CREATE OR REPLACE FUNCTION summary_by_tag_range(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE(
    tag text,
    hours_observed real,
    pm25_median real,
    pm25_p95 real,
    pct_over15 real,
    peaks_per_hour real,
    auc_per_hour real,
    control_pm25_median real,
    control_pct_over15 real,
    control_peaks_per_hour real
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    WITH activity_readings AS (
        -- Readings during tagged activities
        SELECT 
            t.slug AS tag,
            r.ts,
            r.pm25,
            EXTRACT(hour FROM r.ts AT TIME ZONE 'Europe/Paris') AS hod,
            EXTRACT(dow FROM r.ts AT TIME ZONE 'Europe/Paris') AS dow
        FROM readings r
        JOIN activity_intervals ai ON 
            r.ts >= ai.start_ts AND r.ts <= ai.end_ts
        JOIN activity_tags at ON at.activity_id = ai.id
        JOIN tags t ON t.id = at.tag_id
        WHERE r.ts >= from_ts AND r.ts <= to_ts
            AND r.pm25 IS NOT NULL
    ),
    control_readings AS (
        -- Readings outside any activity, same hour-of-day and day-of-week
        SELECT 
            r.ts,
            r.pm25,
            EXTRACT(hour FROM r.ts AT TIME ZONE 'Europe/Paris') AS hod,
            EXTRACT(dow FROM r.ts AT TIME ZONE 'Europe/Paris') AS dow
        FROM readings r
        WHERE r.ts >= from_ts AND r.ts <= to_ts
            AND r.pm25 IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM activity_intervals ai 
                WHERE r.ts >= ai.start_ts AND r.ts <= ai.end_ts
            )
    ),
    activity_stats AS (
        SELECT 
            tag,
            COUNT(*)::real / 4 AS hours_observed,  -- 15-min intervals
            percentile_cont(0.5) WITHIN GROUP (ORDER BY pm25)::real AS pm25_median,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY pm25)::real AS pm25_p95,
            (COUNT(*) FILTER (WHERE pm25 > 15)::real / COUNT(*) * 100) AS pct_over15
        FROM activity_readings
        GROUP BY tag
    ),
    activity_peaks AS (
        SELECT 
            ar.tag,
            COUNT(p.peak_id)::real / NULLIF(ast.hours_observed, 0) AS peaks_per_hour,
            COALESCE(SUM(p.auc_above_baseline) / NULLIF(ast.hours_observed, 0), 0) AS auc_per_hour
        FROM activity_readings ar
        JOIN activity_stats ast ON ar.tag = ast.tag
        LEFT JOIN mv_peaks p ON 
            ar.ts >= p.start_ts AND ar.ts <= p.end_ts
        GROUP BY ar.tag, ast.hours_observed
    ),
    control_stats_by_tag AS (
        SELECT 
            ar.tag,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cr.pm25)::real AS control_pm25_median,
            (COUNT(*) FILTER (WHERE cr.pm25 > 15)::real / COUNT(*) * 100) AS control_pct_over15,
            COUNT(DISTINCT p.peak_id)::real / NULLIF(COUNT(DISTINCT DATE_TRUNC('hour', cr.ts)), 0) AS control_peaks_per_hour
        FROM activity_readings ar
        JOIN control_readings cr ON ar.hod = cr.hod AND ar.dow = cr.dow
        LEFT JOIN mv_peaks p ON 
            cr.ts >= p.start_ts AND cr.ts <= p.end_ts
        GROUP BY ar.tag
    )
    SELECT 
        ast.tag,
        ast.hours_observed,
        ast.pm25_median,
        ast.pm25_p95,
        ast.pct_over15,
        COALESCE(ap.peaks_per_hour, 0) AS peaks_per_hour,
        COALESCE(ap.auc_per_hour, 0) AS auc_per_hour,
        COALESCE(cs.control_pm25_median, 0) AS control_pm25_median,
        COALESCE(cs.control_pct_over15, 0) AS control_pct_over15,
        COALESCE(cs.control_peaks_per_hour, 0) AS control_peaks_per_hour
    FROM activity_stats ast
    LEFT JOIN activity_peaks ap ON ast.tag = ap.tag
    LEFT JOIN control_stats_by_tag cs ON ast.tag = cs.tag
    ORDER BY ast.pct_over15 DESC;
$$;

-- Function: Peaks in date range
CREATE OR REPLACE FUNCTION peaks_in_range(from_ts timestamptz, to_ts timestamptz)
RETURNS TABLE(
    peak_id uuid,
    sensor_id text,
    start_ts timestamptz,
    end_ts timestamptz,
    pm25_max real,
    baseline real,
    auc_above_baseline real,
    tags text
)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT 
        p.peak_id,
        p.sensor_id,
        p.start_ts,
        p.end_ts,
        p.pm25_max,
        p.baseline,
        p.auc_above_baseline,
        pt.tags
    FROM mv_peaks p
    LEFT JOIN vw_peaks_with_tags pt ON p.peak_id = pt.peak_id
    WHERE p.start_ts >= from_ts AND p.end_ts <= to_ts
    ORDER BY p.start_ts DESC;
$$;

-- Row Level Security (RLS)
ALTER TABLE readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_intervals ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policies - No direct access to raw tables for anon/authenticated users
-- Data access is only through views and RPC functions

-- Grant permissions to authenticated users for views and functions
GRANT SELECT ON mv_peaks TO authenticated;
GRANT SELECT ON vw_peaks_with_tags TO authenticated;
GRANT EXECUTE ON FUNCTION summary_by_tag_range(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION peaks_in_range(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION get_hourly_heatmap_data(timestamptz, timestamptz) TO authenticated;

-- Allow authenticated users to manage activities and tags
CREATE POLICY "Allow authenticated users to read tags" ON tags
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to manage activities" ON activity_intervals
    FOR ALL TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to manage activity tags" ON activity_tags
    FOR ALL TO authenticated USING (true);

-- Grant necessary permissions for tables that need direct access
GRANT SELECT ON tags TO authenticated;
GRANT ALL ON activity_intervals TO authenticated;
GRANT ALL ON activity_tags TO authenticated;

-- Schedule materialized view refreshes with pg_cron
-- Refresh baseline daily at 2 AM
SELECT cron.schedule('refresh-baseline-hourly', '0 2 * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_baseline_hourly;');

-- Refresh peaks hourly
SELECT cron.schedule('refresh-peaks', '0 * * * *', 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_peaks;');

-- Create service role for Edge Function (will be used with service key)
-- No additional policies needed as service key bypasses RLS
