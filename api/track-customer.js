// api/link-design-customer.js
// Lier un design Zakeke à la session client Pro qui l'a créé
// CommonJS • Vercel • sans dépendances externes

// ------------------------
// Config CORS (restreint)
// ------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /^https:\/\/([a-z0-9-]+\.)*lefagoteur\.com$/i; // ex: www.lefagoteur.com, shop.lefagoteur.com

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

// ------------------------
// Stockage en mémoire
// ------------------------
// designId -> { customerId, customerEmail, customerTag, createdAt }
if (!global.designCustomerMap) {
  global.designCustomerMap = new Map();
}
// Nettoyage périodique simple (éviter l’amnésie crasse)
const TTL_MS = 30 * 60 * 1000; // 30 minutes
function gcDesignMap() {
  const now = Date.now();
  for (const [designId, rec] of global.designCustomerMap.entries()) {
    if (now - rec.createdAt > TTL_MS) {
      global.designCustomerMap.delete(designId);
    }
  }
}

// ------------------------
// Utils
// ------------------------
const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

function isValidProTag(tag) {
  if (!tag) return false;
  const t = String(tag).trim();
  return t.startsWith('pro') && !BLACKLISTED_TAGS.includes(t) && t.length > 3;
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch {
      return {};
    }
  }
  return body;
}

// ------------------------
// Handler
// ------------------------
module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Petit endpoint GET facultatif pour debug: /api/link-design-customer?designId=xxx
    if (req.method === 'GET') {
      const designId = (req.query && req.query.designId) || '';
      if (!designId) return res.status(400).json({ error: 'Missing designId' });
      const rec = global.designCustomerMap.get(designId);
      return res.status(200).json({
        exists: !!rec,
        record: rec || null,
        ttlMs: TTL_MS
      });
    }

    // POST
    const payload = normalizeBody(req.body);

    const {
      designId,
      customerId,
      customerEmail,
      customerTag,
      productId,      // optionnel: pratique pour tes logs
      timestamp       // optionnel: côté front
    } = payload || {};

    // Validation d’entrée minimale
    if (!designId || typeof designId !== 'string' || designId.trim().length < 3) {
      return res.status(400).json({ error: 'Invalid designId' });
    }
    if (!customerId || !customerEmail) {
      return res.status(400).json({ error: 'Missing customerId or customerEmail' });
    }
    if (!isValidProTag(customerTag)) {
      // On ne stocke pas si pas Pro valide
      return res.status(200).json({
        success: false,
        reason: 'not-pro',
        message: 'Customer is not Pro or tag is invalid'
      });
    }

    // Évite les doublons inutiles: si existant, on écrase proprement
    global.designCustomerMap.set(designId, {
      customerId,
      customerEmail,
      customerTag,
      productId: productId || null,
      createdAt: Date.now(),
      from: 'link-design-customer',
      sourceTs: timestamp || null
    });

    // Petit coup de balai opportuniste
    gcDesignMap();

    // Logs sobres (RGPD-friendly)
    console.log('[link-design-customer] linked', {
      designId,
      customerId,
      tag: customerTag,
      productId: productId || undefined
    });

    return res.status(200).json({
      success: true,
      designId,
      customerId,
      customerTag,
      ttlMs: TTL_MS
    });

  } catch (err) {
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
