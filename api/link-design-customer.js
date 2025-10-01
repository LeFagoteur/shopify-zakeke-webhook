// /api/link-design-customer.js

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /^https:\/\/([a-z0-9-]+\.)*lefagoteur\.com$/i;

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

// Initialisation des Maps globales
if (!global.designCustomerMap) global.designCustomerMap = new Map();
if (!global.productCustomerMap) global.productCustomerMap = new Map();
if (!global.sessionCustomerMap) global.sessionCustomerMap = new Map(); // ✅ NOUVEAU

const TTL_MS = 60 * 60 * 1000; // 60 min

function gcMaps() {
  const now = Date.now();
  
  for (const [k, v] of global.designCustomerMap.entries()) {
    if (now - v.createdAt > TTL_MS) global.designCustomerMap.delete(k);
  }
  for (const [k, v] of global.productCustomerMap.entries()) {
    if (now - v.createdAt > TTL_MS) global.productCustomerMap.delete(k);
  }
  // ✅ NOUVEAU : Nettoyer aussi sessionCustomerMap
  for (const [k, v] of global.sessionCustomerMap.entries()) {
    if (now - v.createdAt > TTL_MS) global.sessionCustomerMap.delete(k);
  }
}

const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

function isValidProTag(tag) {
  if (!tag) return false;
  const t = String(tag).trim();
  return t.toLowerCase().startsWith('pro') && !BLACKLISTED_TAGS.includes(t) && t.length > 3;
}

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // GET de debug
    if (req.method === 'GET') {
      const designId = (req.query && req.query.designId) || null;
      const productId = (req.query && req.query.productId) || null;
      const sessionId = (req.query && req.query.sessionId) || null; // ✅ NOUVEAU

      const byDesign = designId ? global.designCustomerMap.get(designId) || null : null;
      const byProduct = productId ? global.productCustomerMap.get(String(productId)) || null : null;
      const bySession = sessionId ? global.sessionCustomerMap.get(sessionId) || null : null; // ✅ NOUVEAU

      return res.status(200).json({
        designId,
        productId,
        sessionId, // ✅ NOUVEAU
        byDesignExists: !!byDesign,
        byProductExists: !!byProduct,
        bySessionExists: !!bySession, // ✅ NOUVEAU
        byDesign,
        byProduct,
        bySession, // ✅ NOUVEAU
        ttlMs: TTL_MS
      });
    }

    // POST
    const { designId, customerId, customerEmail, customerTag, productId, timestamp, sessionId } = normalizeBody(req.body); // ✅ AJOUT sessionId

    if (!designId && !productId) {
      return res.status(400).json({ error: 'Missing designId or productId' });
    }
    if (!customerId || !customerEmail) {
      return res.status(400).json({ error: 'Missing customerId or customerEmail' });
    }
    if (!isValidProTag(customerTag)) {
      return res.status(200).json({ success: false, reason: 'not-pro' });
    }

    const attrib = {
      customerId,
      customerEmail,
      customerTag,
      productId: productId || null,
      sessionId: sessionId || null, // ✅ NOUVEAU
      createdAt: Date.now(),
      from: 'link-design-customer',
      sourceTs: timestamp || null
    };

    // Stocker par designId
    if (designId) {
      global.designCustomerMap.set(designId, attrib);
    }
    
    // Stocker par productId
    if (productId) {
      global.productCustomerMap.set(String(productId), attrib);
    }

    // ✅ NOUVEAU : Stocker AUSSI par sessionId (pour fallback)
    if (sessionId) {
      // Vérifier si on a déjà des designs pour cette session
      const existingSession = global.sessionCustomerMap.get(sessionId);
      
      if (existingSession) {
        // Ajouter le designId à la liste
        if (designId && !existingSession.designIds.includes(designId)) {
          existingSession.designIds.push(designId);
        }
      } else {
        // Créer nouvelle entrée session
        global.sessionCustomerMap.set(sessionId, {
          customerId,
          customerEmail,
          customerTag,
          designIds: designId ? [designId] : [],
          createdAt: Date.now()
        });
      }
    }

    gcMaps();

    console.log('[link-design-customer] linked', {
      designId: designId || null,
      productId: productId || null,
      sessionId: sessionId || null, // ✅ NOUVEAU
      customerId,
      tag: customerTag
    });

    return res.status(200).json({
      success: true,
      designId: designId || null,
      productId: productId || null,
      sessionId: sessionId || null, // ✅ NOUVEAU
      customerId,
      customerTag,
      ttlMs: TTL_MS
    });

  } catch (err) {
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
