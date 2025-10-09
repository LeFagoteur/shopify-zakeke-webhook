// api/webhook-product.js
// Vérifie HMAC, debounce 10s, traite products/create/update pour "rattraper" un produit Zakeke
// sans jamais réintroduire 'needs-attribution'. Logs frugaux.

const crypto = require('crypto');

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_WEBHOOK_SECRET= process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

exports.config = { api: { bodyParser: false } };

if (!global.lastProcessedProductAt) global.lastProcessedProductAt = new Map();
const DEBOUNCE_MS = 10_000;

function readRawBody(req){ return new Promise((resolve,reject)=>{ const b=[]; req.on('data',c=>b.push(c)); req.on('end',()=>resolve(Buffer.concat(b))); req.on('error',reject); }); }
function verifyShopifyHmac(rawBody, hmacHeaderB64){
  if (!SHOPIFY_WEBHOOK_SECRET || !hmacHeaderB64) return false;
  const digestB64 = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody).digest('base64');
  const a = Buffer.from(digestB64,'base64'); const b = Buffer.from(hmacHeaderB64,'base64');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a,b);
}
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method:'POST',
    headers:{ 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type':'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function isZakekeProduct(p){ const pt = (p && p.product_type) || ''; return /zakeke/i.test(pt); }
function extractDesignIdFromHtml(bodyHtml){
  if (!bodyHtml) return null;
  const m1 = bodyHtml.match(/data-zakeke-design-id=["']([^"']+)["']/i); if (m1 && m1[1]) return m1[1];
  const m2 = bodyHtml.match(/000-[A-Za-z0-9]{20,}/); if (m2) return m2[0];
  return null;
}

function companyFromProTag(tag){
  if (!tag) return '';
  const raw = String(tag).replace(/^pro[-_]?/i,'');
  return raw.replace(/[-_]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim();
}
const capitalizeFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
const escapeRe = s => String(s).replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');
const isMm = t => /-[12]M$/i.test(t);

async function getProduct(gid){
  const q = `query($id: ID!){ product(id:$id){ id title tags updatedAt } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}
async function updateProduct(gid, nextTags, nextTitle){
  const m = `mutation($input: ProductInput!){
    productUpdate(input:$input){ product{ id title tags updatedAt } userErrors{ field message } }
  }`;
  const res = await shopifyGraphQL(m, { input: { id: gid, tags: nextTags, title: nextTitle } });
  const ue = res.productUpdate?.userErrors || [];
  if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));
  return res.productUpdate.product;
}

// mini-fix: si attribution connue, réapplique tag client + garde 1M/2M si présent
function findAttribution(productId, designId){
  // récupère depuis les maps remplies par /api/link-design-customer
  if (productId && global.productCustomerMap?.has(String(productId))) return global.productCustomerMap.get(String(productId));
  if (designId && global.designCustomerMap?.has(designId)) return global.designCustomerMap.get(designId);
  return null;
}

module.exports = async function handler(req,res){
  try{
    if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });

    const raw = await readRawBody(req);
    if (!verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'])) {
      return res.status(401).json({ error:'Invalid HMAC' });
    }

    const topic = String(req.headers['x-shopify-topic'] || '');
    if (topic !== 'products/create' && topic !== 'products/update') {
      return res.status(200).json({ skipped:true, reason:'irrelevant-topic' });
    }

    const body = JSON.parse(raw.toString('utf8'));
    const productId = body.id;
    const now = Date.now();
    const last = global.lastProcessedProductAt.get(productId) || 0;
    if (now - last < DEBOUNCE_MS) {
      return res.status(200).json({ skipped:true, reason:'debounced', productId });
    }
    global.lastProcessedProductAt.set(productId, now);

    if (!isZakekeProduct(body)) {
      return res.status(200).json({ skipped:true, reason:'not-zakeke' });
    }

    const designId = extractDesignIdFromHtml(body.body_html);
    const tagsArr = Array.isArray(body.tags) ? body.tags : String(body.tags||'').split(',').map(t=>t.trim()).filter(Boolean);
    const hasPro = tagsArr.some(t => /^pro/i.test(t));
    const hasMm  = tagsArr.some(isMm);

    // Si tout est déjà propre, on n'insiste pas
    if (hasPro && hasMm) {
      return res.status(200).json({ skipped:true, reason:'already-ok' });
    }

    // On tente la ré-attribution silencieuse
    const attrib = findAttribution(productId, designId);
    if (!attrib) {
      return res.status(200).json({ skipped:true, reason:'no-attribution' });
    }

    const gid = `gid://shopify/Product/${productId}`;
    const pd = await getProduct(gid);
    if (!pd) return res.status(200).json({ skipped:true, reason:'product-missing' });

    // Tags: ajoute tag client si absent, ne touche pas aux MM s'il n'y en a aucun
    let nextTags = Array.from(new Set([...(pd.tags||[]).filter(t => t !== 'zakeke-attributed'), attrib.customerTag]));
    const mmExisting = (pd.tags||[]).filter(isMm);
    if (mmExisting.length) {
      // garde ce qui existe déjà
      nextTags = Array.from(new Set([...nextTags, ...mmExisting]));
    }

    // Titre: "Client - Produit" si pas déjà en préfixe
    let nextTitle = pd.title;
    const compCap = capitalizeFirst(companyFromProTag(attrib.customerTag));
    if (compCap) {
      const suffixRe = new RegExp(`\\s*-\\s*${escapeRe(compCap)}$`,'i');
      let baseTitle = nextTitle.replace(suffixRe,'').trim();
      const prefixRe = new RegExp(`^${escapeRe(compCap)}\\s*-\\s*`,'i');
      nextTitle = prefixRe.test(baseTitle) ? baseTitle : `${compCap} - ${baseTitle}`;
    }

    // Idempotence basique
    const sameTags = (pd.tags||[]).length === nextTags.length && (pd.tags||[]).every(t => nextTags.includes(t));
    const nothing = sameTags && nextTitle === pd.title;
    if (nothing) {
      return res.status(200).json({ skipped:true, reason:'nothing-to-do' });
    }

    const updated = await updateProduct(gid, nextTags, nextTitle);
    return res.status(200).json({ success:true, productId, updated });
  }catch(e){
    console.error('[webhook-product] error', e);
    return res.status(500).json({ error:'server', message:e.message });
  }
};
