-- Seed data for Air Quality Analysis Tool

-- Insert predefined tags
INSERT INTO tags (slug) VALUES 
('four_emaillage'),
('four_biscuit'),
('coulage_platre'),
('prep_barbotine'),
('impr3d_cera'),
('presence'),
('fenetre_ouverte'),
('masque')
ON CONFLICT (slug) DO NOTHING;

-- Insert sample device token
-- Token: "my-secret-device-token-123"
-- SHA-256: a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3
INSERT INTO device_tokens (sensor_id, token_sha256) VALUES 
('esp32-atelier-01', 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3')
ON CONFLICT (sensor_id) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256;

-- Note about generating SHA-256 tokens:
-- You can generate the SHA-256 hash of your device token using:
-- 1. Command line: echo -n "your-token-here" | sha256sum
-- 2. Online tools: https://emn178.github.io/online-tools/sha256.html
-- 3. Node.js: crypto.createHash('sha256').update('your-token-here').digest('hex')
-- 4. Python: hashlib.sha256(b'your-token-here').hexdigest()

-- Insert sample readings for testing (last 48 hours)
DO $$
DECLARE
    start_time timestamptz := now() - interval '48 hours';
    current_time timestamptz;
    pm25_base real;
    pm25_value real;
    temp_value real;
    rh_value real;
    hour_of_day int;
BEGIN
    current_time := start_time;
    
    WHILE current_time <= now() LOOP
        hour_of_day := EXTRACT(hour FROM current_time AT TIME ZONE 'Europe/Paris');
        
        -- Simulate daily pattern: higher PM2.5 during work hours (8-18)
        pm25_base := CASE 
            WHEN hour_of_day BETWEEN 8 AND 18 THEN 15 + random() * 20  -- Work hours: 15-35
            WHEN hour_of_day BETWEEN 19 AND 22 THEN 10 + random() * 15  -- Evening: 10-25
            ELSE 5 + random() * 10  -- Night/early morning: 5-15
        END;
        
        -- Add some random variation and occasional spikes
        pm25_value := pm25_base + (random() - 0.5) * 5;
        
        -- Simulate occasional high pollution events
        IF random() < 0.05 THEN  -- 5% chance of spike
            pm25_value := pm25_value + 20 + random() * 30;
        END IF;
        
        -- Ensure realistic bounds
        pm25_value := GREATEST(1, LEAST(100, pm25_value));
        
        -- Simulate temperature and humidity
        temp_value := 20 + random() * 10;  -- 20-30°C
        rh_value := 40 + random() * 30;    -- 40-70% RH
        
        INSERT INTO readings (ts, sensor_id, pm1, pm25, pm10, temp_c, rh) VALUES (
            current_time,
            'esp32-atelier-01',
            pm25_value * 0.7,  -- PM1 typically 70% of PM2.5
            pm25_value,
            pm25_value * 1.3,  -- PM10 typically 130% of PM2.5
            temp_value,
            rh_value
        );
        
        current_time := current_time + interval '15 minutes';
    END LOOP;
END $$;

-- Insert sample activities with realistic timing
WITH tag_ids AS (
    SELECT slug, id FROM tags
),
sample_activities AS (
    SELECT 
        gen_random_uuid() AS activity_id,
        start_ts,
        end_ts,
        note,
        tag_slug
    FROM (VALUES
        -- Yesterday morning - kiln firing
        (now()::date - 1 + time '08:00', now()::date - 1 + time '12:00', 'Cuisson émaillage vases', 'four_emaillage'),
        (now()::date - 1 + time '14:00', now()::date - 1 + time '16:30', 'Cuisson biscuit', 'four_biscuit'),
        
        -- Yesterday afternoon - presence and preparation
        (now()::date - 1 + time '09:00', now()::date - 1 + time '17:00', 'Présence atelier', 'presence'),
        (now()::date - 1 + time '15:00', now()::date - 1 + time '15:45', 'Préparation barbotine', 'prep_barbotine'),
        (now()::date - 1 + time '16:00', now()::date - 1 + time '16:30', 'Coulage plâtre moules', 'coulage_platre'),
        
        -- Today morning - 3D printing and window management
        (now()::date + time '07:30', now()::date + time '09:00', 'Impression 3D céramique', 'impr3d_cera'),
        (now()::date + time '08:00', now()::date + time '17:00', 'Fenêtre ouverte', 'fenetre_ouverte'),
        (now()::date + time '09:00', now()::date + time '16:00', 'Présence atelier', 'presence'),
        (now()::date + time '14:00', now()::date + time '14:30', 'Port du masque pendant ponçage', 'masque')
    ) AS t(start_ts, end_ts, note, tag_slug)
)
INSERT INTO activity_intervals (id, start_ts, end_ts, note)
SELECT activity_id, start_ts, end_ts, note
FROM sample_activities;

-- Insert activity tags
WITH tag_ids AS (
    SELECT slug, id FROM tags
),
sample_activities AS (
    SELECT 
        gen_random_uuid() AS activity_id,
        start_ts,
        end_ts,
        note,
        tag_slug
    FROM (VALUES
        -- Same data as above for consistency
        (now()::date - 1 + time '08:00', now()::date - 1 + time '12:00', 'Cuisson émaillage vases', 'four_emaillage'),
        (now()::date - 1 + time '14:00', now()::date - 1 + time '16:30', 'Cuisson biscuit', 'four_biscuit'),
        (now()::date - 1 + time '09:00', now()::date - 1 + time '17:00', 'Présence atelier', 'presence'),
        (now()::date - 1 + time '15:00', now()::date - 1 + time '15:45', 'Préparation barbotine', 'prep_barbotine'),
        (now()::date - 1 + time '16:00', now()::date - 1 + time '16:30', 'Coulage plâtre moules', 'coulage_platre'),
        (now()::date + time '07:30', now()::date + time '09:00', 'Impression 3D céramique', 'impr3d_cera'),
        (now()::date + time '08:00', now()::date + time '17:00', 'Fenêtre ouverte', 'fenetre_ouverte'),
        (now()::date + time '09:00', now()::date + time '16:00', 'Présence atelier', 'presence'),
        (now()::date + time '14:00', now()::date + time '14:30', 'Port du masque pendant ponçage', 'masque')
    ) AS t(start_ts, end_ts, note, tag_slug)
),
inserted_activities AS (
    SELECT 
        ai.id AS activity_id,
        sa.tag_slug
    FROM activity_intervals ai
    JOIN sample_activities sa ON ai.start_ts = sa.start_ts AND ai.end_ts = sa.end_ts
)
INSERT INTO activity_tags (activity_id, tag_id)
SELECT 
    ia.activity_id,
    ti.id
FROM inserted_activities ia
JOIN tag_ids ti ON ia.tag_slug = ti.slug;

-- Refresh materialized views to include sample data
REFRESH MATERIALIZED VIEW mv_baseline_hourly;
REFRESH MATERIALIZED VIEW mv_peaks;

-- Display setup completion message
DO $$
BEGIN
    RAISE NOTICE '=== Air Quality Analysis Tool - Setup Complete ===';
    RAISE NOTICE 'Tags created: %', (SELECT COUNT(*) FROM tags);
    RAISE NOTICE 'Sample readings: %', (SELECT COUNT(*) FROM readings);
    RAISE NOTICE 'Sample activities: %', (SELECT COUNT(*) FROM activity_intervals);
    RAISE NOTICE 'Device token: esp32-atelier-01';
    RAISE NOTICE 'Baseline hours: %', (SELECT COUNT(*) FROM mv_baseline_hourly);
    RAISE NOTICE 'Detected peaks: %', (SELECT COUNT(*) FROM mv_peaks);
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Deploy Edge Function: supabase functions deploy ingest';
    RAISE NOTICE '2. Update config.js with your Supabase credentials';
    RAISE NOTICE '3. Deploy frontend to GitHub Pages';
    RAISE NOTICE '';
    RAISE NOTICE 'Device token for ESP32: my-secret-device-token-123';
    RAISE NOTICE 'SHA-256: a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3';
END $$;
