// api/link-design-customer.js
// Lie design/productId au client + TAG/RENAME immédiats
// + Réconciliation Dealeasy: garder seulement *-1M ou *-2M selon `markings`

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

if (!global.designCustomerMap)  global.designCustomerMap  = new Map(); // designId -> attrib
if (!global.productCustomerMap) global.productCustomerMap = new Map(); // productId -> attrib

const TTL_MS = 60 * 60 * 1000; // 60 min

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

/**
 * Réconcilie tous les tags qui finissent par -1M / -2M.
 * - Si aucun 1M/2M présent: ne touche pas.
 * - Si les deux présents: garde uniquement ceux avec le suffixe voulu.
 * - Si un seul type présent et pas le bon: remplace -1M <-> -2M.
 * - Les autres tags sont conservés.
 */
function reconcileDealeasyTags(existingTags, markings) {
  const keepSuffix = Number(markings) >= 2 ? '2M' : '1M';

  const oneM = existingTags.filter(t => /-1M$/i.test(t));
  const twoM = existingTags.filter(t => /-2M$/i.test(t));

  // 0) aucun tag 1M/2M -> ne touche à rien
  if (oneM.length === 0 && twoM.length === 0) {
    return Array.from(new Set(existingTags));
  }

  const out = [];

  // 1) conserver tout ce qui n'est pas 1M/2M
  for (const t of existingTags) {
    if (!/-[12]M$/i.test(t)) out.push(t);
  }

  // 2) les deux présents -> garder seulement le suffixe voulu
  if (oneM.length && twoM.length) {
    for (const t of (keepSuffix === '2M' ? twoM : oneM)) out.push(t);
    return Array.from(new Set(out));
  }

  // 3) un seul type présent -> remplace si besoin
  if (keepSuffix === '2M' && oneM.length && !twoM.length) {
    for (const t of oneM) out.push(t.replace(/-1M$/i, '-2M'));
    return Array.from(new Set(out));
  }
  if (keepSuffix === '1M' && twoM.length && !oneM.length) {
    for (const t of twoM) out.push(t.replace(/-2M$/i, '-1M'));
    return Array.from(new Set(out));
  }

  // 4) déjà le bon suffixe présent, on garde tel quel
  const keep = keepSuffix === '2M' ? twoM : oneM;
  for (const t of keep) out.push(t);
  return Array.from(new Set(out));
}

async function tagProductNow(productIdNum, customerTag, options = {}) {
  const {
    rename = true,
    markings = null,     // 1 ou 2, sinon null
    retries = 6,
    waitMs = 1500
  } = options;

  const gid = `gid://shopify/Product/${productIdNum}`;

  for (let i = 1; i <= retries; i++) {
    try {
      const pd = await getProduct(gid);
      if (!pd) throw new Error('Produit introuvable');

      // Tags
      const existing = Array.isArray(pd.tags) ? pd.tags : [];
      let cleaned = existing.filter(t => t !== 'needs-attribution');

      // Marker attribution utile
      if (!cleaned.includes('zakeke-attributed')) cleaned.push('zakeke-attributed');

      // Réconciliation 1M/2M si `markings` fourni
      if (markings === 1 || markings === 2) {
        cleaned = reconcileDealeasyTags(cleaned, markings);
      }

      // Tag client Pro (déjà géré par ailleurs mais on le renforce ici)
      if (customerTag && !cleaned.includes(customerTag)) cleaned.push(customerTag);

      const nextTags = Array.from(new Set(cleaned));

      // Titre: “NomClient - Titre”, plus suffixe “ - 2 marquages” si markings=2
      let nextTitle = pd.title;

      const compRaw = companyFromProTag(customerTag);
      if (rename && compRaw) {
        const compCap = capitalizeFirst(compRaw);

        // Nettoyage d'un ancien suffixe “ - comp”
        const suffixRe = new RegExp(`\\s*-\\s*${escapeRe(compRaw)}$`, 'i');
        const suffixCapRe = new RegExp(`\\s*-\\s*${escapeRe(compCap)}$`, 'i');
        let baseTitle = nextTitle.replace(suffixRe, '').replace(suffixCapRe, '').trim();

        // Mise en préfixe si pas déjà “Comp - Titre”
        const prefixRe = new RegExp(`^${escapeRe(compCap)}\\s*-\\s*`, 'i');
        nextTitle = prefixRe.test(baseTitle) ? baseTitle : `${compCap} - ${baseTitle}`;
      }

      // Suffixe “ - 2 marquages” selon markings
      const twoSuffix = ' - 2 marquages';
      if (markings === 2) {
        if (!nextTitle.endsWith(twoSuffix)) nextTitle = `${nextTitle}${twoSuffix}`;
      } else if (nextTitle.endsWith(twoSuffix)) {
        nextTitle = nextTitle.slice(0, -twoSuffix.length);
      }

      // Idempotence
      const sameTags = (existing.length === nextTags.length) && existing.every(t => nextTags.includes(t));
      const nothing = sameTags && nextTitle === pd.title;
      if (nothing) return { ok: true, reason: 'nothing-to-do', title: pd.title, tags: nextTags };

      // Mutation
      const m = `mutation($input: ProductInput!){
        productUpdate(input:$input){
          product{ id title tags }
          userErrors{ field message }
        }
      }`;
      const res = await shopifyGraphQL(m, { input: { id: gid, tags: nextTags, title: nextTitle } });
      const ue = (res.productUpdate && res.productUpdate.userErrors) || [];
      if (ue.length) {
        console.error('[link-design-customer] productUpdate userErrors', ue);
        throw new Error('productUpdate errors');
      }

      return { ok: true, title: nextTitle, tags: nextTags };
    } catch (e) {
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
    // GET debug
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

    const { designId, customerId, customerEmail, customerTag, productId, markings, timestamp } = parseBody(req.body);
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

    // Tag & rename immédiats si on a productId
    let tagging = null;
    if (productId) {
      const mk = Number(markings);
      const mkNorm = (mk === 1 || mk === 2) ? mk : null;
      tagging = await tagProductNow(productId, customerTag, { rename: true, markings: mkNorm, retries: 6, waitMs: 1500 });
      console.log('[link-design-customer] productUpdate immediate', { productId, markings: mkNorm, result: tagging });
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
