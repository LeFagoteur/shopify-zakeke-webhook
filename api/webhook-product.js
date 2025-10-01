// api/webhook-product.js  (CommonJS, Node, Vercel)
// Vérifie HMAC correctement (base64), traite products/create & products/update, tag + rename.

const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET= process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

exports.config = { 
  api: { 
    bodyParser: false 
  } 
};

// ------------ low-level utils ------------
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function verifyShopifyHmac(rawBody, hmacHeaderB64) {
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeaderB64) return false;
  const digestB64 = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digestB64, 'base64');
  const b = Buffer.from(hmacHeaderB64, 'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

// ------------ business utils ------------
function isZakekeProduct(p) {
  const pt = (p && p.product_type) || '';
  return /zakeke/i.test(pt); // "provider-zakeke-product" & "zakeke-design"
}

function companyFromProTag(tag) {
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i, '');
  return raw.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

function findAttributionForProduct(productId) {
  // 1) mapping direct par productId
  if (productId && global.productCustomerMap?.has(String(productId))) {
    return global.productCustomerMap.get(String(productId));
  }
  // 2) fallback: session pro la plus récente
  if (global.activeProSessions && global.activeProSessions.size) {
    let latest = null;
    for (const s of global.activeProSessions.values()) {
      if (!latest || s.lastActivity > latest.lastActivity) latest = s;
    }
    return latest || null;
  }
  return null;
}

async function getProduct(gid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}

async function updateProduct(gid, customerTag, rename = true) {
  const pd = await getProduct(gid);
  if (!pd) throw new Error('Produit introuvable');

  const tags = Array.from(new Set([...(pd.tags || []), customerTag]));

  let title = pd.title;
  if (rename) {
    const comp = companyFromProTag(customerTag);
    if (comp && !title.includes(comp)) title = `${title} - ${comp}`;
  }

  const m = `mutation($input: ProductInput!){
    productUpdate(input:$input){
      product{ id title tags }
      userErrors{ field message }
    }
  }`;
  const res = await shopifyGraphQL(m, { input: { id: gid, tags, title } });
  const ue = (res.productUpdate && res.productUpdate.userErrors) || [];
  if (ue.length) {
    console.error('[webhook-product] productUpdate userErrors', ue);
    throw new Error('productUpdate errors');
  }
  return res.productUpdate.product;
}

// ------------ handler ------------
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const raw = await readRawBody(req);
    const hOk = verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256']);
    if (!hOk) {
      console.warn('[webhook-product] HMAC invalid', {
        topic: req.headers['x-shopify-topic'],
        shop: req.headers['x-shopify-shop-domain']
      });
      return res.status(401).json({ error: 'Invalid HMAC' });
    }

    const topic = req.headers['x-shopify-topic'] || '';
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped: true, reason: 'irrelevant-topic' });
    }

    const body = JSON.parse(raw.toString('utf8'));
    if (!isZakekeProduct(body)) {
      return res.status(200).json({ skipped: true, reason: 'not-zakeke' });
    }

    const productId = body.id; // id numérique (REST webhook)
    const productGid = `gid://shopify/Product/${productId}`;

    const attr = findAttributionForProduct(productId);
    if (!attr?.customerTag) {
      console.log('[webhook-product] skipped: no-attribution', { productId });
      return res.status(200).json({ skipped: true, reason: 'no-attribution' });
    }

    const updated = await updateProduct(productGid, attr.customerTag, true);
    console.log('[webhook-product] tagged/renamed', {
      productId,
      tag: attr.customerTag,
      title: updated.title
    });

    return res.status(200).json({ success: true, productId, tag: attr.customerTag });

  } catch (e) {
    console.error('[webhook-product] error', e);
    return res.status(500).json({ error: 'server', message: e.message });
  }
};
