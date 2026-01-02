/**
 * Vercel Serverless Function: Vision Analysis
 * Analyzes images using OpenAI Responses API
 * 
 * POST /api/vision
 * Body: { photos: Array<{filename: string, data: string (base64), mimeType?: string}> }
 */

import OpenAI from 'openai';

// Rate limiting: Simple in-memory store (for production, use Redis/Upstash)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX_REQUESTS = 30;

function getRateLimitKey(ip: string | null): string {
  return ip || 'unknown';
}

function checkRateLimit(ip: string | null): { allowed: boolean; remaining: number } {
  const key = getRateLimitKey(ip);
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0 };
  }

  record.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - record.count };
}

/**
 * Safe JSON parsing with fallback
 */
function safeParseJSON(jsonString: string, fallback: any): any {
  try {
    // Remove markdown code blocks if present
    const cleaned = jsonString.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('[VISION] JSON parse error:', error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/**
 * Create fallback analysis object
 */
function createFallbackAnalysis(filename: string): any {
  return {
    filename,
    subject: 'unknown',
    composition: { framing: 'medium', symmetry: 'medium', leading_lines: false, negative_space: 'medium' },
    light: { key: 'mid-key', contrast: 'medium', directionality: 'ambient' },
    mood: [],
    visual_energy: 5,
    emotion_vector: { calm: 0.5, tension: 0.5, mystery: 0.5, intimacy: 0.5, awe: 0.5 },
    motion_safe_zones: { center: true, left: true, right: true, top: true, bottom: true },
    recommended_move_types: ['hold'],
    do_not: [],
    best_role: []
  };
}

/**
 * Analyze a single image using OpenAI Responses API
 */
async function analyzeImage(
  imageBase64: string,
  filename: string,
  mimeType: string,
  openai: OpenAI,
  modelName: string
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout per image
  
  try {
    // Build the prompt with image reference
    const prompt = `You are a professional cinematographer and video editor analyzing images for a cinematic memory video.

Your task is to analyze the provided image and output structured JSON with:
- subject: what the image is "about" (architecture/person/object/landscape/abstract)
- composition: framing (wide/medium/close), symmetry (high/medium/low), leading_lines (yes/no), negative_space (high/medium/low)
- light: key (high-key/low-key/mid-key), contrast (high/medium/low), directionality (front/side/back/ambient)
- mood: array of 3-5 mood tags (e.g., ["solitude", "tension", "calm", "awe"])
- visual_energy: 1-10 (1=very still, 10=very dynamic)
- emotion_vector: object with values 0-1 for {calm, tension, mystery, intimacy, awe}
- motion_safe_zones: object with {center: boolean, left: boolean, right: boolean, top: boolean, bottom: boolean} indicating safe areas for pan/zoom
- recommended_move_types: array of allowed moves (e.g., ["slow_push_in", "drift_left", "hold", "reveal"])
- do_not: array of forbidden moves (e.g., ["fast_zoom", "random_direction", "heavy_shake", "excessive_rotation"])
- best_role: array of roles with scores (e.g., [{"role": "opener", "score": 0.8}, {"role": "bridge", "score": 0.3}])

CRITICAL RULES:
- Do not suggest motion not supported by composition. Motion must serve emotion.
- If important subject near frame edge, prohibit pans toward that edge.
- If text/signage exists, movement must be slow enough to not blur it.
- If composition has high symmetry, prefer straight push/pull (no sideways drift).
- If no depth exists, do not suggest parallax moves.

Output ONLY valid JSON, no markdown, no code fences. Analyze the image and provide the structured JSON.`;

    // Note: Responses API structure - using input with image data URL
    const response = await (openai as any).responses.create({
      model: modelName,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: prompt
            },
            {
              type: 'input_image',
              image_url: `data:${mimeType};base64,${imageBase64}`
            }
          ]
        }
      ],
      max_output_tokens: 800,
      temperature: 0.3
    }, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    // Responses API returns output_text instead of choices[0].message.content
    const content = (response.output_text || response.output || '').trim();
    
    // Safe JSON parsing with fallback
    const analysis = safeParseJSON(content, createFallbackAnalysis(filename));
    
    return {
      filename,
      ...analysis
    };
  } catch (error: any) {
    clearTimeout(timeout);
    
    if (error.name === 'AbortError') {
      console.warn(`[VISION] Timeout analyzing ${filename}`);
      return createFallbackAnalysis(filename);
    }
    
    console.error(`[VISION] Error analyzing ${filename}:`, error.message);
    return createFallbackAnalysis(filename);
  }
}

export default async function handler(req: Request): Promise<Response> {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limiting
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
                   req.headers.get('x-real-ip') || 
                   null;
  const rateLimit = checkRateLimit(clientIp);
  
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ 
      error: 'Rate limit exceeded', 
      message: 'Too many requests. Please try again later.' 
    }), {
      status: 429,
      headers: { 
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': '0',
        'Retry-After': '600'
      }
    });
  }

  try {
    // Input validation
    const body = await req.json();
    
    if (!body.photos || !Array.isArray(body.photos)) {
      return new Response(JSON.stringify({ error: 'photos array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body.photos.length === 0) {
      return new Response(JSON.stringify({ error: 'photos array cannot be empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Cap batch size to prevent abuse
    const MAX_PHOTOS = 36;
    if (body.photos.length > MAX_PHOTOS) {
      return new Response(JSON.stringify({ 
        error: `Too many photos (max ${MAX_PHOTOS})` 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('[VISION] OPENAI_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get model (support OPENAI_VISION_MODEL or fallback to OPENAI_MODEL or default)
    // Responses API compatible models: gpt-4.1-mini, gpt-4.1
    const modelName = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';

    // Initialize OpenAI client
    const openai = new OpenAI({ apiKey });

    // Analyze all images sequentially (to avoid rate limits)
    const analysisResults = [];
    
    for (let i = 0; i < body.photos.length; i++) {
      const photo = body.photos[i];
      const ext = photo.filename.split('.').pop()?.toLowerCase() || 'jpg';
      const mimeType = photo.mimeType || 
        (ext === 'png' ? 'image/png' : 
         ext === 'webp' ? 'image/webp' : 
         'image/jpeg');
      
      // Extract base64 data (remove data URL prefix if present)
      const base64Data = photo.data.includes(',') 
        ? photo.data.split(',')[1] 
        : photo.data;

      // Validate base64 data size (rough check: base64 is ~1.33x original size)
      // Limit to ~10MB image (13.3MB base64)
      if (base64Data.length > 13_300_000) {
        console.warn(`[VISION] Image too large: ${photo.filename} (${base64Data.length} bytes)`);
        analysisResults.push(createFallbackAnalysis(photo.filename));
        continue;
      }

      // Do not log base64 strings - only log filename and size info
      const sizeKB = Math.round(base64Data.length / 1024);
      console.log(`[VISION] Analyzing ${i + 1}/${body.photos.length}: ${photo.filename} (${sizeKB}KB)`);

      try {
        const analysis = await analyzeImage(base64Data, photo.filename, mimeType, openai, modelName);
        analysisResults.push(analysis);
        
        // Small delay to avoid OpenAI rate limits (50ms between requests)
        if (i < body.photos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } catch (error: any) {
        console.error(`[VISION] Error analyzing ${photo.filename}:`, error.message);
        analysisResults.push(createFallbackAnalysis(photo.filename));
      }
    }

    // Validation: ensure all images were analyzed (even if fallbacks)
    if (analysisResults.length !== body.photos.length) {
      return new Response(JSON.stringify({ 
        error: `Analysis incomplete: ${analysisResults.length}/${body.photos.length} images analyzed` 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ 
      ok: true, 
      results: analysisResults,
      count: analysisResults.length
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': rateLimit.remaining.toString()
      }
    });

  } catch (error: any) {
    console.error('[VISION] Error:', error);
    return new Response(JSON.stringify({ 
      ok: false, 
      error: error.message || 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
