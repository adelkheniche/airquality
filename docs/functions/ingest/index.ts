// Supabase Edge Function for ESP32 Data Ingestion
// Deno runtime

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// CORS headers for preflight requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface DataPoint {
  ts: string;          // ISO 8601 timestamp
  pm1?: number;        // PM1.0 µg/m³
  pm25?: number;       // PM2.5 µg/m³
  pm10?: number;       // PM10 µg/m³
  temp_c?: number;     // Temperature °C
  rh?: number;         // Relative humidity %
}

interface IngestRequest {
  sensor_id: string;
  points: DataPoint[];
}

// SHA-256 hash function
async function sha256(message: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Validate data point
function validateDataPoint(point: DataPoint): string[] {
  const errors: string[] = [];
  
  // Validate timestamp
  if (!point.ts) {
    errors.push('Missing timestamp');
  } else {
    const date = new Date(point.ts);
    if (isNaN(date.getTime())) {
      errors.push('Invalid timestamp format');
    }
  }
  
  // Validate PM values (optional but must be valid if present)
  if (point.pm1 !== undefined && (isNaN(point.pm1) || point.pm1 < 0 || point.pm1 > 1000)) {
    errors.push('PM1 must be between 0 and 1000 µg/m³');
  }
  
  if (point.pm25 !== undefined && (isNaN(point.pm25) || point.pm25 < 0 || point.pm25 > 1000)) {
    errors.push('PM2.5 must be between 0 and 1000 µg/m³');
  }
  
  if (point.pm10 !== undefined && (isNaN(point.pm10) || point.pm10 < 0 || point.pm10 > 1000)) {
    errors.push('PM10 must be between 0 and 1000 µg/m³');
  }
  
  // Validate temperature (optional)
  if (point.temp_c !== undefined && (isNaN(point.temp_c) || point.temp_c < -50 || point.temp_c > 100)) {
    errors.push('Temperature must be between -50 and 100 °C');
  }
  
  // Validate humidity (optional)
  if (point.rh !== undefined && (isNaN(point.rh) || point.rh < 0 || point.rh > 100)) {
    errors.push('Relative humidity must be between 0 and 100 %');
  }
  
  return errors;
}

// Validate request payload
function validateRequest(body: any): { valid: boolean; errors: string[]; data?: IngestRequest } {
  const errors: string[] = [];
  
  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Invalid JSON body'] };
  }
  
  if (!body.sensor_id || typeof body.sensor_id !== 'string') {
    errors.push('Missing or invalid sensor_id');
  }
  
  if (!body.points || !Array.isArray(body.points)) {
    errors.push('Missing or invalid points array');
  } else {
    if (body.points.length === 0) {
      errors.push('Points array cannot be empty');
    }
    
    if (body.points.length > 100) {
      errors.push('Too many points (max 100 per request)');
    }
    
    // Validate each point
    body.points.forEach((point: any, index: number) => {
      const pointErrors = validateDataPoint(point);
      pointErrors.forEach(error => {
        errors.push(`Point ${index}: ${error}`);
      });
    });
  }
  
  return {
    valid: errors.length === 0,
    errors,
    data: errors.length === 0 ? body as IngestRequest : undefined
  };
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  
  // Only accept POST requests
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { 
        status: 405, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
  
  try {
    // Extract and validate Authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header' }),
        { 
          status: 401, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
    
    const deviceToken = authHeader.slice(7); // Remove 'Bearer ' prefix
    
    // Hash the provided token
    const hashedToken = await sha256(deviceToken);
    
    // Initialize Supabase client with service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    
    // Parse request body
    let requestData: IngestRequest;
    try {
      const body = await req.json();
      const validation = validateRequest(body);
      
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ 
            error: 'Validation failed', 
            details: validation.errors 
          }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      }
      
      requestData = validation.data!;
    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON body' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
    
    // Verify device token
    const { data: deviceData, error: deviceError } = await supabase
      .from('device_tokens')
      .select('sensor_id')
      .eq('sensor_id', requestData.sensor_id)
      .eq('token_sha256', hashedToken)
      .single();
    
    if (deviceError || !deviceData) {
      console.error('Device authentication failed:', {
        sensor_id: requestData.sensor_id,
        provided_hash: hashedToken,
        error: deviceError
      });
      
      return new Response(
        JSON.stringify({ error: 'Invalid device credentials' }),
        { 
          status: 403, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
    
    // Prepare readings for insertion
    const readings = requestData.points.map(point => ({
      ts: point.ts,
      sensor_id: requestData.sensor_id,
      pm1: point.pm1 ?? null,
      pm25: point.pm25 ?? null,
      pm10: point.pm10 ?? null,
      temp_c: point.temp_c ?? null,
      rh: point.rh ?? null,
    }));
    
    // Upsert readings (handle duplicates)
    const { error: insertError } = await supabase
      .from('readings')
      .upsert(readings, {
        onConflict: 'ts,sensor_id',
        ignoreDuplicates: false // Update existing records
      });
    
    if (insertError) {
      console.error('Database insertion error:', insertError);
      return new Response(
        JSON.stringify({ 
          error: 'Database error',
          details: insertError.message 
        }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }
    
    console.log(`Successfully ingested ${readings.length} readings for sensor ${requestData.sensor_id}`);
    
    // Return success response
    return new Response(
      JSON.stringify({ 
        message: 'Data ingested successfully',
        sensor_id: requestData.sensor_id,
        points_received: requestData.points.length,
        timestamp: new Date().toISOString()
      }),
      { 
        status: 202, // Accepted
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
    
  } catch (error) {
    console.error('Unexpected error in ingest function:', error);
    
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});

/* To test this function locally:

curl -X POST "http://localhost:54321/functions/v1/ingest" \
  -H "Authorization: Bearer my-secret-device-token-123" \
  -H "Content-Type: application/json" \
  -d '{
    "sensor_id": "esp32-atelier-01",
    "points": [
      {
        "ts": "2025-08-22T14:00:00Z",
        "pm1": 6.2,
        "pm25": 18.7,
        "pm10": 27.3,
        "temp_c": 26.1,
        "rh": 48.2
      },
      {
        "ts": "2025-08-22T14:15:00Z",
        "pm1": 5.9,
        "pm25": 22.1,
        "pm10": 30.4,
        "temp_c": 26.2,
        "rh": 48.0
      }
    ]
  }'

*/
