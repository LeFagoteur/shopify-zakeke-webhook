// api/link-design-customer.js
// Lie design/productId au client + TAG/RENAME immédiats
// Nettoyage: supprime 'needs-attribution' et 'zakeke-attributed'
// Réconcilie *-1M / *-2M selon `markings` (1 ou 2) et accepte `baseMmTags` depuis le front

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /.*/;

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

// caches éphémères pour raccrocher les wagons entre front et webhooks (si tu en utilises ailleurs)
if (!global.designCustomerMap)  global.designCustomerMap  = new Map();
if (!global.productCustomerMap) global.productCustomerMap = new Map();

const TTL_MS = 60 * 60 * 1000;
function gcMaps() {
  const now = Date.now();
  for (const [k, v] of global.designCustomerMap.entries())  if (now - v.createdAt > TTL_MS) global.designCustomerMap.delete(k);
  for (const [k, v] of global.productCustomerMap.entries()) if (now - v.createdAt > TTL_MS) global.productCustomerMap.delete(k);
}

const BLACKLISTED = ['membre-pro','membre-premium','membre-gratuit'];
const isValidPro = t => !!t && t.toLowerCase().startsWith('pro') && !BLACKLISTED.includes(t) && t.length > 3;

// --- Shopify GraphQL helper ---
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

// --- Formatage titre ---
function companyFromProTag(tag) {
  const raw = String(tag || '').replace(/^pro[-_]?/i, '');
  return raw.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}
const capitalizeFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
const escapeRe = s => String(s).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

// --- Product fetch ---
async function getProduct(gid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}

// --- 1M / 2M helpers ---
const isMm = t => /-[12]M$/i.test(t);

// Fusionne les tags 1M/2M existants avec les tags "graine" du produit source
function mergeBaseMmTags(existing, base) {
  const out = new Set(existing);
  (Array.isArray(base) ? base : []).forEach(t => { if (isMm(t)) out.add(t); });
  return Array.from(out);
}

// Garde uniquement le bon suffixe selon markings, en convertissant si besoin
function reconcileDealeasyTags(existingTags, markings) {
  const keepSuffix = Number(markings) >= 2 ? '2M' : '1M';
  const oneM = existingTags.filter(t => /-1M$/i.test(t));
  const twoM = existingTags.filter(t => /-2M$/i.test(t));

  // si aucun tag 1M/2M n’existe, on ne touche pas
  if (!oneM.length && !twoM.length) return Array.from(new Set(existingTags));

  // retire tous les 1M/2M
  const base = existingTags.filter(t => !isMm(t));
  // on garde/convertit selon la cible
  if (keepSuffix === '2M') {
    if (twoM.length) return Array.from(new Set([...base, ...twoM]));
    // convertir 1M -> 2M
    return Array.from(new Set([...base, ...oneM.map(t => t.replace(/-1M$/i, '-2M'))]));
  } else {
    if (oneM.length) return Array.from(new Set([...base, ...oneM]));
    // convertir 2M -> 1M
    return Array.from(new Set([...base, ...twoM.map(t => t.replace(/-2M$/i, '-1M'))]));
  }
}

// --- Mise à jour immédiate du produit ---
async function tagProductNow(productIdNum, customerTag, options = {}) {
  const { rename = true, markings = null, baseMmTags = [], retries = 6, waitMs = 1500 } = options;
  const gid = `gid://shopify/Product/${productIdNum}`;

  for (let i = 1; i <= retries; i++) {
    try {
      const pd = await getProduct(gid);
      if (!pd) throw new Error('Produit introuvable');

      // 1) nettoyage basique
      let tags = Array.isArray(pd.tags) ? pd.tags : [];
      tags = tags.filter(t => t !== 'needs-attribution' && t !== 'zakeke-attributed');

      // 2) injecte le tag client
      if (customerTag && !tags.includes(customerTag)) tags.push(customerTag);

      // 3) merge des tags 1M/2M venant du produit source
      tags = mergeBaseMmTags(tags, baseMmTags);

      // 4) réconcilie 1M/2M selon `markings`
      if (markings === 1 || markings === 2) tags = reconcileDealeasyTags(tags, markings);

      const nextTags = Array.from(new Set(tags));

      // 5) titre "Client - Produit" + " - 2 marquages" si nécessaire
      let nextTitle = pd.title;
      if (rename && customerTag) {
        const compCap = capitalizeFirst(companyFromProTag(customerTag));
        if (compCap) {
          const suffixRe = new RegExp(`\\s*-\\s*${escapeRe(compCap)}$`, 'i');
          let baseTitle = nextTitle.replace(suffixRe, '').trim();
          const prefixRe = new RegExp(`^${escapeRe(compCap)}\\s*-\\s*`, 'i');
          nextTitle = prefixRe.test(baseTitle) ? baseTitle : `${compCap} - ${baseTitle}`;
        }
      }
      const twoSuffix = ' - 2 marquages';
      if (markings === 2) {
        if (!nextTitle.endsWith(twoSuffix)) nextTitle = `${nextTitle}${twoSuffix}`;
      } else if (nextTitle.endsWith(twoSuffix)) {
        nextTitle = nextTitle.slice(0, -twoSuffix.length);
      }

      // 6) idempotence
      const sameTags = (pd.tags || []).length === nextTags.length && (pd.tags || []).every(t => nextTags.includes(t));
      const nothing = sameTags && pd.title === nextTitle;
      if (nothing) return { ok: true, reason: 'nothing-to-do', title: pd.title, tags: nextTags };

      // 7) mutation
      const m = `mutation($input: ProductInput!){
        productUpdate(input:$input){
          product{ id title tags }
          userErrors{ field message }
        }
      }`;
      const res = await shopifyGraphQL(m, { input: { id: gid, tags: nextTags, title: nextTitle } });
      const ue = res.productUpdate?.userErrors || [];
      if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));
      return { ok: true, title: nextTitle, tags: nextTags };
    } catch (e) {
      if (i === retries) return { ok: false, error: e.message };
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

// --- util ---
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return {}; } }
  return body;
}

// --- Handler ---
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (req.method === 'GET') {
      const pid = req.query?.productId ? String(req.query.productId) : null;
      const did = req.query?.designId || null;
      return res.status(200).json({
        byProduct: pid ? global.productCustomerMap.get(pid) || null : null,
        byDesign:  did ? global.designCustomerMap.get(did)  || null : null,
        sizes: { product: global.productCustomerMap.size || 0, design: global.designCustomerMap.size || 0 }
      });
    }

    const {
      designId,
      customerId,
      customerEmail,
      customerTag,
      productId,
      markings,          // 1 ou 2
      baseMmTags,        // ["TS-CC-IN-1M", "TS-CC-IN-2M"] éventuellement
      timestamp
    } = parseBody(req.body);

    if (!customerId || !customerEmail) return res.status(400).json({ error: 'Missing customerId or customerEmail' });
    if (!isValidPro(customerTag))  return res.status(200).json({ success: false, reason: 'not-pro' });
    if (!designId && !productId)   return res.status(400).json({ error: 'Missing designId or productId' });

    const attrib = {
      customerId, customerEmail, customerTag,
      productId: productId || null,
      createdAt: Date.now(),
      from: 'link-design-customer',
      sourceTs: timestamp || null
    };
    if (designId) global.designCustomerMap.set(designId, attrib);
    if (productId) global.productCustomerMap.set(String(productId), attrib);
    gcMaps();

    let tagging = null;
    if (productId) {
      const mk = Number(markings);
      const mkNorm = (mk === 1 || mk === 2) ? mk : null;
      const seed = Array.isArray(baseMmTags) ? baseMmTags.filter(isMm) : [];
      tagging = await tagProductNow(productId, customerTag, {
        rename: true,
        markings: mkNorm,
        baseMmTags: seed,
        retries: 6,
        waitMs: 1500
      });
      console.log('[link-design-customer] productUpdate immediate', { productId, markings: mkNorm, seed, result: tagging });
    }

    return res.status(200).json({
      success: true,
      designId: designId || null,
      productId: productId || null,
      customerId,
      customerTag,
      markings: (Number(markings) === 1 || Number(markings) === 2) ? Number(markings) : null,
      tagging
    });
  } catch (err) {
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
