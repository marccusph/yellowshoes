// api/analyze.js — Vercel Serverless Function for "Yellow Shoes"
// Analyzes a fashion item image and returns styling suggestions (with per-store
// shopping search terms) as JSON.
//
// Security:
//   - CORS allowlist via the ALLOWED_ORIGINS env var (comma-separated origins).
//   - Best-effort per-IP rate limiting (configurable via env).

const SUPPORTED_LANGUAGES = {
  English: 'English',
  'Portuguese (Portugal)': 'European Portuguese (pt-PT)',
  'Portuguese (Brazil)': 'Brazilian Portuguese (pt-BR)',
  French: 'French',
  Italian: 'Italian',
  German: 'German',
};

// ----- Best-effort in-memory rate limiter -----
// NOTE: Vercel runs multiple ephemeral instances, so this limits per-instance
// and resets on cold starts. For robust, global limits use Vercel KV / Upstash.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '600000', 10); // 10 min
const hits = new Map(); // ip -> number[] of request timestamps

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Opportunistic cleanup so the map can't grow unbounded.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Returns true if the request's origin is allowed and sets the proper header.
function applyCors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  // No allowlist configured: reflect the request origin so the app works out of
  // the box (not a blanket '*'). Set ALLOWED_ORIGINS to lock this down.
  if (allowed.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    return true;
  }

  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    return true;
  }
  return false;
}

export default async function handler(req, res) {
  const originAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(originAllowed ? 200 : 403).end();
  if (!originAllowed) return res.status(403).json({ error: 'Origin not allowed.' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  try {
    const { imageData, mediaType, style, season, language } = req.body || {};

    // Visitor country from Vercel's edge geolocation (ISO code, e.g. "BR", "PT").
    // Used by the frontend to pick country-appropriate affiliate stores.
    const country = (req.headers['x-vercel-ip-country'] || '').toUpperCase();

    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided.' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not found in environment');
      return res.status(500).json({
        error: 'API key not configured. Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.',
      });
    }

    const languageLabel = SUPPORTED_LANGUAGES[language] || 'English';
    const inLanguage =
      languageLabel === 'English'
        ? ''
        : ` IMPORTANT: write every text value in the JSON in ${languageLabel}.`;

    // The default look is always "Casual"; choosing a style (with a season) overrides it.
    const effectiveStyle = style || 'Casual';
    const seasonPart = season ? ` for the ${season} season` : '';
    const focus = `Provide ONE wearable ${effectiveStyle} outfit${seasonPart}, with tasteful, specific pieces.`;

    const promptText = `You are a professional fashion stylist. The image shows ONE fashion item the user ALREADY owns and wants to wear — it is the ANCHOR of the outfit, never something to re-suggest. ${focus}${inLanguage}

Build the outfit AROUND that item:
- Work out which slot the item fills: tops, bottoms, footwear or accessories (a dress or jumpsuit fills BOTH tops and bottoms).
- Suggest ONLY the OTHER pieces that complete the look. For the slot(s) the user's item already fills, set BOTH its "items" value and its "searchTerms" value to an empty string "". Never suggest a replacement for a piece they already have.

Return ONLY a raw JSON object — no markdown, no backticks, no preamble — matching exactly this shape:
{
  "itemDescription": "short description of the item and its main color",
  "styleCategory": "${effectiveStyle}",
  "colorPalette": ["color", "color", "color"],
  "outfitSuggestions": [
    {
      "name": "outfit name",
      "vibe": "one short sentence on why this look works",
      "items": {
        "tops": "specific suggestion with colors and fabrics",
        "bottoms": "specific suggestion with colors and styles",
        "footwear": "specific shoe / sneaker / boot suggestion with colors",
        "accessories": "bag, jewellery, belt or watch suggestions (NO shoes here)"
      },
      "searchTerms": {
        "tops": "2-4 word shoppable search query for the top (colour + garment)",
        "bottoms": "2-4 word shoppable search query for the bottoms",
        "footwear": "2-4 word shoppable search query for the shoes",
        "accessories": "2-4 word shoppable search query for the key accessory (bag/jewellery/belt/watch)"
      }
    }
  ],
  "tips": ["tip", "tip", "tip"]
}
Include exactly 1 entry in outfitSuggestions and 3 entries in tips. CRITICAL: leave the user's own item's slot empty ("") in both items and searchTerms — only fill the complementary slots. Keep searchTerms short and shopping-friendly.`;

    const safeMediaType =
      typeof mediaType === 'string' && mediaType.startsWith('image/') ? mediaType : 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', // current Claude Sonnet (the old dated model was retired -> 404)
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: safeMediaType, data: imageData } },
              { type: 'text', text: promptText },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', response.status, errorText);
      return res
        .status(502)
        .json({ error: `The styling service returned an error (${response.status}). Please try again in a moment.` });
    }

    const data = await response.json();
    const rawText = (data.content || []).find((block) => block.type === 'text')?.text || '';

    const parsed = extractJson(rawText);
    if (!parsed) {
      console.error('Could not parse model output as JSON. First 500 chars:', rawText.slice(0, 500));
      return res.status(502).json({ error: 'The stylist response was malformed. Please try again.' });
    }

    return res.status(200).json({ ...parsed, country });
  } catch (error) {
    console.error('Error in analyze handler:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

// Robustly pull a JSON object out of the model's text response.
// Handles raw JSON, ```json fenced blocks, and stray text around the object.
function extractJson(text) {
  if (!text) return null;
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  try {
    return JSON.parse(t);
  } catch (_) {
    /* fall through */
  }

  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch (_) {
      /* give up */
    }
  }
  return null;
}
