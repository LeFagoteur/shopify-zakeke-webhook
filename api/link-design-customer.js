// api/link-design-customer.js
// Lie design/productId au client + TAGUE le produit IMMÉDIATEMENT (sans attendre le webhook)
// + Renommage: "Tag Entreprise - Titre Produit"

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /.*/; // élargis si besoin

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

if (!global.designCustomerMap)  global.designCustomerMap  = new Map(); // designId -> attrib
if (!global.productCustomerMap) global.productCustomerMap = new Map(); // productId -> attrib

const TTL_MS = 60 * 60 * 1000; // 60 min, on garde large

function gcMaps() {
  const now = Date.now();
  for (const [k, v] of global.designCustomerMap.entries())  if (now - v.createdAt > TTL_MS) global.designCustomerMap.delete(k);
  for (const [k, v] of global.productCustomerMap.entries()) if (now - v.createdAt > TTL_MS) global.productCustomerMap.delete(k);
}

const BLACKLISTED = ['membre-pro','membre-premium','membre-gratuit'];
const isValidPro = t => !!t && t.toLowerCase().startsWith('pro') && !BLACKLISTED.includes(t) && t.length > 3;

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
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

function companyFromProTag(tag) {
  const raw = String(tag || '').replace(/^pro[-_]?/i, '');
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeRe(s) {
  return String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

async function getProduct(gid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}

async function tagProductNow(productIdNum, customerTag, rename = true, retries = 5, waitMs = 1200) {
  const gid = `gid://shopify/Product/${productIdNum}`;

  for (let i = 1; i <= retries; i++) {
    try {
      const pd = await getProduct(gid);
      if (!pd) throw new Error('Produit introuvable');

      const existing = Array.isArray(pd.tags) ? pd.tags : [];
      const cleaned  = existing.filter(t => t !== 'needs-attribution');
      const nextTags = Array.from(new Set([...cleaned, customerTag, 'zakeke-attributed']));

      let nextTitle = pd.title;

      if (rename) {
        const compRaw = companyFromProTag(customerTag);
        if (compRaw) {
          const compCap = capitalizeFirst(compRaw);

          // Si l’ancien format "Produit - comp" existe, on l’enlève
          const suffixRe = new RegExp(`\\s*-\\s*${escapeRe(compRaw)}$`, 'i');
          const suffixCapRe = new RegExp(`\\s*-\\s*${escapeRe(compCap)}$`, 'i');

          let baseTitle = pd.title.replace(suffixRe, '').replace(suffixCapRe, '').trim();

          // Si déjà en préfixe correct "Comp - Titre", ne rien refaire
          const prefixRe = new RegExp(`^${escapeRe(compCap)}\\s*-\\s*`, 'i');
          if (!prefixRe.test(baseTitle)) {
            nextTitle = `${compCap} - ${baseTitle}`;
          } else {
            nextTitle = baseTitle;
          }
        }
      }

      // évite les updates inutiles
      const sameTags = (existing.length === nextTags.length) && existing.every(t => nextTags.includes(t));
      const nothing = sameTags && nextTitle === pd.title;
      if (nothing) return { ok: true, reason: 'nothing-to-do', title: pd.title, tags: nextTags };

      const m = `mutation($input: ProductInput!){
        productUpdate(input:$input){
          product{ id title tags }
          userErrors{ field message }
        }
      }`;

      const res = await shopifyGraphQL(m, { input: { id: gid, tags: nextTags, title: nextTitle } });
      const ue = (res.productUpdate && res.productUpdate.userErrors) || [];
      if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));

      return { ok: true, title: nextTitle, tags: nextTags };
    } catch (e) {
      // le produit peut ne pas être prêt au tout début, on retry
      if (i === retries) return { ok: false, error: e.message };
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  return body;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // GET de debug
    if (req.method === 'GET') {
      const pid = req.query?.productId ? String(req.query.productId) : null;
      const did = req.query?.designId || null;
      return res.status(200).json({
        byProduct: pid ? global.productCustomerMap.get(pid) || null : null,
        byDesign:  did ? global.designCustomerMap.get(did)  || null : null,
        sizes: {
          product: global.productCustomerMap.size || 0,
          design:  global.designCustomerMap.size  || 0
        }
      });
    }

    const { designId, customerId, customerEmail, customerTag, productId, timestamp } = parseBody(req.body);
    if (!customerId || !customerEmail) return res.status(400).json({ error: 'Missing customerId or customerEmail' });
    if (!isValidPro(customerTag))  return res.status(200).json({ success: false, reason: 'not-pro' });
    if (!designId && !productId)   return res.status(400).json({ error: 'Missing designId or productId' });

    const attrib = { customerId, customerEmail, customerTag, productId: productId || null, createdAt: Date.now(), from: 'link-design-customer', sourceTs: timestamp || null };
    if (designId) global.designCustomerMap.set(designId, attrib);
    if (productId) global.productCustomerMap.set(String(productId), attrib);
    gcMaps();

    // TAG & RENOMMAGE IMMÉDIATS si on a le productId
    let tagging = null;
    if (productId) {
      tagging = await tagProductNow(productId, customerTag, true, 6, 1500);
      console.log('[link-design-customer] productUpdate immediate', { productId, result: tagging });
    }

    return res.status(200).json({
      success: true,
      designId: designId || null,
      productId: productId || null,
      customerId,
      customerTag,
      tagging
    });
  } catch (err) {
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
