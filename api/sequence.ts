/**
 * Vercel Serverless Function: Sequence Planning
 * Creates global narrative sequence using vision analysis results
 * 
 * POST /api/sequence
 * Body: { analysisResults: Array, promptText?: string }
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
    console.error('[SEQUENCE] JSON parse error:', error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/**
 * Validate that selected IDs match expected count and use only provided IDs
 */
function isValidSelection(orderedIds: string[], images: any[], targetCount: number): boolean {
  if (!Array.isArray(orderedIds) || orderedIds.length !== targetCount) {
    return false;
  }
  
  const imageIdSet = new Set(images.map(img => String(img.id ?? img.filename ?? images.indexOf(img))));
  return orderedIds.every(id => imageIdSet.has(String(id)));
}

/**
 * Deterministic fallback: return images in original order
 */
function deterministicFallback(images: any[], targetCount: number): string[] {
  return images.slice(0, targetCount).map((img, idx) => String(img.id ?? img.filename ?? idx));
}

/**
 * Build shots array from ordered IDs and beats
 */
function buildShots(orderedIds: string[], beats: any[]): any[] {
  return orderedIds.map((id, idx) => {
    const beat = beats.find(b => String(b.id) === String(id));
    return {
      id,
      role: beat?.role || (idx < orderedIds.length * 0.2 ? 'opening' : 
                          idx < orderedIds.length * 0.6 ? 'build' : 
                          idx < orderedIds.length * 0.9 ? 'turn' : 'resolution'),
      reason: beat?.reason || ''
    };
  });
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
    
    if (!body.analysisResults || !Array.isArray(body.analysisResults)) {
      return new Response(JSON.stringify({ error: 'analysisResults array required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body.analysisResults.length === 0) {
      return new Response(JSON.stringify({ error: 'analysisResults array cannot be empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Cap batch size to prevent abuse
    const MAX_IMAGES = 200;
    if (body.analysisResults.length > MAX_IMAGES) {
      return new Response(JSON.stringify({ 
        error: `Too many images (max ${MAX_IMAGES})` 
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const promptText = typeof body.promptText === 'string' ? body.promptText.trim() : '';

    // Validate API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('[SEQUENCE] OPENAI_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get model (support OPENAI_SEQUENCE_MODEL or fallback to OPENAI_MODEL or default)
    const modelName = process.env.OPENAI_SEQUENCE_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // Initialize OpenAI client
    const openai = new OpenAI({ apiKey });

    // Normalize analysis results to image format and create compact representation
    const images = body.analysisResults.map((a: any, idx: number) => ({
      id: String(a.id ?? a.filename ?? idx),
      filename: a.filename || `image_${idx}`,
      analysis: {
        subject: a.subject || a.caption || '',
        mood: Array.isArray(a.mood) ? a.mood : [],
        composition: a.composition || {},
        visual_energy: Number(a.visual_energy ?? a.visualWeight ?? 5) || 5,
        best_role: Array.isArray(a.best_role) ? a.best_role : []
      }
    }));

    // Create compact input to reduce token usage
    const compact = images.map(i => ({
      id: i.id,
      subject: i.analysis?.subject,
      mood: i.analysis?.mood,
      composition: i.analysis?.composition,
      visual_energy: i.analysis?.visual_energy,
      best_role: i.analysis?.best_role
    }));

    const targetCount = images.length;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      
      const response = await openai.chat.completions.create({
        model: modelName,
        messages: [{
          role: 'system',
          content: `You are a professional video editor creating a cinematic memory video sequence plan.

Your task is to order ALL provided images into a story (no omissions).

OUTPUT FORMAT (JSON only):
{
  "orderedIds": ["idA", "idB", ...],
  "theme": "brief theme description",
  "emotion_arc": [{"beat": "opening|build|turn|climax|resolution", "ids": ["idA", "idB"]}],
  "beats": [
    { "id": "idA", "role": "opening|build|turn|climax|resolution", "reason": "brief why" }
  ]
}

HARD CONSTRAINTS:
1) Use only provided ids.
2) Return exactly ALL ids (orderedIds.length == images.length).
3) Each id appears exactly once.
4) Avoid near-duplicate adjacency (similar tags/composition).
5) Do NOT preserve upload order unless it is already the absolute best story.

Return valid JSON only, no markdown, no code fences.`
        }, {
          role: 'user',
          content: `Order ALL images for a story (do NOT drop any).
User prompt: ${promptText || '(none)'}
images = ${JSON.stringify(compact)}

Return orderedIds containing every id exactly once (length == images.length) and beats with roles (opening/build/turn/climax/resolution).`
        }],
        temperature: 0.4,
        max_tokens: 1200
      }, {
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      const content = response.choices[0].message.content?.trim() || '';
      
      // Safe JSON parsing with fallback
      const fallbackPlan = {
        orderedIds: deterministicFallback(images, targetCount),
        theme: '',
        emotion_arc: [],
        beats: []
      };
      const raw = safeParseJSON(content, fallbackPlan);
      
      const selectedOrderedIds = raw.orderedIds || raw.ordered_ids || [];
      const beats = Array.isArray(raw.beats) ? raw.beats : [];
      const theme = raw.theme || '';
      const emotion_arc = Array.isArray(raw.emotion_arc) ? raw.emotion_arc : [];
      
      const valid = isValidSelection(selectedOrderedIds, images, targetCount);
      
      let finalIds = selectedOrderedIds;
      if (!valid) {
        console.warn('[SEQUENCE] Model output invalid, using deterministic fallback');
        finalIds = deterministicFallback(images, targetCount);
      }
      
      // Build shots from beats
      const shots = buildShots(finalIds, beats);
      
      // Map ids to original image indices
      const orderedIdsStr = finalIds.map(id => String(id));
      const selectedIndices = orderedIdsStr.map(id => {
        const idx = images.findIndex(img => String(img.id) === String(id));
        return idx >= 0 ? idx : 0;
      });

      // Build plan compatible with renderer/motion pipeline
      const plan = {
        theme,
        emotion_arc,
        ordered_ids: orderedIdsStr,
        shots,
        selected: selectedIndices,
        order: Array.from({ length: orderedIdsStr.length }, (_, i) => i),
        durations: Array.from({ length: orderedIdsStr.length }, () => 3.8),
        transitions: Array.from({ length: Math.max(0, orderedIdsStr.length - 1) }, () => 'crossfade'),
        usedPlanner: 'ai'
      };

      return new Response(JSON.stringify({ 
        ok: true, 
        plan
      }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': rateLimit.remaining.toString()
        }
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.warn('[SEQUENCE] Request timed out, using deterministic fallback');
        // Return deterministic fallback on timeout
        const fallbackIds = deterministicFallback(images, targetCount);
        const fallbackShots = buildShots(fallbackIds, []);
        
        return new Response(JSON.stringify({ 
          ok: true,
          plan: {
            theme: '',
            emotion_arc: [],
            ordered_ids: fallbackIds,
            shots: fallbackShots,
            selected: Array.from({ length: fallbackIds.length }, (_, i) => i),
            order: Array.from({ length: fallbackIds.length }, (_, i) => i),
            durations: Array.from({ length: fallbackIds.length }, () => 3.8),
            transitions: Array.from({ length: Math.max(0, fallbackIds.length - 1) }, () => 'crossfade'),
            usedPlanner: 'fallback'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.error('[SEQUENCE] Error:', error);
      
      // Return deterministic fallback on error
      const fallbackIds = deterministicFallback(images, targetCount);
      const fallbackShots = buildShots(fallbackIds, []);
      
      return new Response(JSON.stringify({ 
        ok: true,
        plan: {
          theme: '',
          emotion_arc: [],
          ordered_ids: fallbackIds,
          shots: fallbackShots,
          selected: Array.from({ length: fallbackIds.length }, (_, i) => i),
          order: Array.from({ length: fallbackIds.length }, (_, i) => i),
          durations: Array.from({ length: fallbackIds.length }, () => 3.8),
          transitions: Array.from({ length: Math.max(0, fallbackIds.length - 1) }, () => 'crossfade'),
          usedPlanner: 'fallback',
          error: error.message
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

  } catch (error: any) {
    console.error('[SEQUENCE] Error:', error);
    return new Response(JSON.stringify({ 
      ok: false, 
      error: error.message || 'Unknown error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
