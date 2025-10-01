// api/link-design-customer.js
// Lier un design Zakeke et/ou un productId au client Pro (CommonJS)

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

if (!global.designCustomerMap) global.designCustomerMap = new Map();   // designId -> attribution
if (!global.productCustomerMap) global.productCustomerMap = new Map(); // productId -> attribution

const TTL_MS = 60 * 60 * 1000; // 60 min pour maximiser les chances sans DB

function gcMaps() {
  const now = Date.now();
  for (const [k, v] of global.designCustomerMap.entries()) {
    if (now - v.createdAt > TTL_MS) global.designCustomerMap.delete(k);
  }
  for (const [k, v] of global.productCustomerMap.entries()) {
    if (now - v.createdAt > TTL_MS) global.productCustomerMap.delete(k);
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
    // GET de debug: ?designId=... ou ?productId=...
    if (req.method === 'GET') {
      const designId = (req.query && req.query.designId) || null;
      const productId = (req.query && req.query.productId) || null;

      const byDesign = designId ? global.designCustomerMap.get(designId) || null : null;
      const byProduct = productId ? global.productCustomerMap.get(String(productId)) || null : null;

      return res.status(200).json({
        designId,
        productId,
        byDesignExists: !!byDesign,
        byProductExists: !!byProduct,
        byDesign,
        byProduct,
        ttlMs: TTL_MS
      });
    }

    // POST
    const { designId, customerId, customerEmail, customerTag, productId, timestamp } = normalizeBody(req.body);

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
      createdAt: Date.now(),
      from: 'link-design-customer',
      sourceTs: timestamp || null
    };

    if (designId) global.designCustomerMap.set(designId, attrib);
    if (productId) global.productCustomerMap.set(String(productId), attrib);

    gcMaps();

    console.log('[link-design-customer] linked', {
      designId: designId || null,
      productId: productId || null,
      customerId,
      tag: customerTag
    });

    return res.status(200).json({
      success: true,
      designId: designId || null,
      productId: productId || null,
      customerId,
      customerTag,
      ttlMs: TTL_MS
    });

  } catch (err) {
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
