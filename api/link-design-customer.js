// api/link-design-customer.js
// Lie design/productId au client + TAG/RENAME immédiats
// Nettoyage: supprime 'zakeke-attributed' si présent (on s'en fout maintenant)
// Réconcilie *-1M / *-2M selon `markings` (1 ou 2) + fusionne baseMmTags
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX) : /.*/;

const SHOPIFY_ACCESS_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP_DOMAIN   = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_VERSION   = process.env.SHOPIFY_API_VERSION || '2025-01';

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Credentials','true');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Requested-With');
}

if (!global.designCustomerMap)  global.designCustomerMap  = new Map();
if (!global.productCustomerMap) global.productCustomerMap = new Map();

const TTL_MS = 60 * 60 * 1000;
function gcMaps(){
  const now = Date.now();
  for (const [k,v] of global.designCustomerMap.entries())  if (now - v.createdAt > TTL_MS) global.designCustomerMap.delete(k);
  for (const [k,v] of global.productCustomerMap.entries()) if (now - v.createdAt > TTL_MS) global.productCustomerMap.delete(k);
}

const BLACKLISTED = ['membre-pro','membre-premium','membre-gratuit'];
const isValidPro = t => !!t && t.toLowerCase().startsWith('pro') && !BLACKLISTED.includes(t) && t.length > 3;

async function shopifyGraphQL(query, variables = {}) {
  const r = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method:'POST',
    headers:{ 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type':'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

function companyFromProTag(tag) {
  const raw = String(tag || '').replace(/^pro[-_]?/i, '');
  return raw.replace(/[-_]+/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2').trim();
}
const capitalizeFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
const escapeRe = s => String(s).replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&');

async function getProduct(gid) {
  const q = `query($id: ID!){ product(id:$id){ id title tags updatedAt } }`;
  const d = await shopifyGraphQL(q, { id: gid });
  return d.product;
}
const isMm = t => /-[12]M$/i.test(t);

function mergeBaseMmTags(existing, base) {
  const out = new Set(existing);
  (Array.isArray(base)?base:[]).forEach(t => { if (isMm(t)) out.add(t); });
  return Array.from(out);
}
function reconcileDealeasyTags(existingTags, markings) {
  const keepSuffix = Number(markings) >= 2 ? '2M' : '1M';
  const oneM = existingTags.filter(t => /-1M$/i.test(t));
  const twoM = existingTags.filter(t => /-2M$/i.test(t));
  if (!oneM.length && !twoM.length) return Array.from(new Set(existingTags));
  const base = existingTags.filter(t => !isMm(t));
  if (keepSuffix === '2M') {
    if (twoM.length) return Array.from(new Set([...base, ...twoM]));
    return Array.from(new Set([...base, ...oneM.map(t => t.replace(/-1M$/i,'-2M'))]));
  } else {
    if (oneM.length) return Array.from(new Set([...base, ...oneM]));
    return Array.from(new Set([...base, ...twoM.map(t => t.replace(/-2M$/i,'-1M'))]));
  }
}

async function tagProductNow(productIdNum, customerTag, options = {}) {
  const { rename = true, markings = null, baseMmTags = [], retries = 6, waitMs = 1500 } = options;
  const gid = `gid://shopify/Product/${productIdNum}`;

  for (let i=1;i<=retries;i++){
    try{
      const pd = await getProduct(gid);
      if (!pd) throw new Error('Produit introuvable');

      let tags = Array.isArray(pd.tags) ? pd.tags.slice() : [];
      // nettoyage simple
      tags = tags.filter(t => t !== 'zakeke-attributed');

      if (customerTag && !tags.includes(customerTag)) tags.push(customerTag);
      tags = mergeBaseMmTags(tags, baseMmTags);
      if (markings === 1 || markings === 2) tags = reconcileDealeasyTags(tags, markings);
      const nextTags = Array.from(new Set(tags));

      // titre "Client - Produit" + " - 2 marquages" si 2
      let nextTitle = pd.title;
      if (rename && customerTag){
        const compCap = capitalizeFirst(companyFromProTag(customerTag));
        if (compCap){
          const suffixRe = new RegExp(`\\s*-\\s*${escapeRe(compCap)}$`,'i');
          let baseTitle = nextTitle.replace(suffixRe,'').trim();
          const prefixRe = new RegExp(`^${escapeRe(compCap)}\\s*-\\s*`,'i');
          nextTitle = prefixRe.test(baseTitle) ? baseTitle : `${compCap} - ${baseTitle}`;
        }
      }
      const twoSuffix = ' - 2 marquages';
      if (markings === 2) {
        if (!nextTitle.endsWith(twoSuffix)) nextTitle = `${nextTitle}${twoSuffix}`;
      } else if (nextTitle.endsWith(twoSuffix)) {
        nextTitle = nextTitle.slice(0, -twoSuffix.length);
      }

      const sameTags = (pd.tags||[]).length === nextTags.length && (pd.tags||[]).every(t => nextTags.includes(t));
      const nothing = sameTags && pd.title === nextTitle;
      if (nothing) return { ok:true, reason:'nothing-to-do', title:pd.title, tags:nextTags };

      const m = `mutation($input: ProductInput!){
        productUpdate(input:$input){
          product{ id title tags updatedAt }
          userErrors{ field message }
        }
      }`;
      const res = await shopifyGraphQL(m, { input:{ id: gid, tags: nextTags, title: nextTitle } });
      const ue = res.productUpdate?.userErrors || [];
      if (ue.length) throw new Error('productUpdate errors: ' + JSON.stringify(ue));

      // ceinture: relecture 1s plus tard, si MM a sauté, on remet une fois
      await new Promise(r=>setTimeout(r, 1000));
      const after = await getProduct(gid);
      const hasMm = (after.tags||[]).some(isMm);
      if (!hasMm && (markings === 1 || markings === 2 || (baseMmTags||[]).length)) {
        const mmMerged = mergeBaseMmTags(after.tags||[], baseMmTags||[]);
        const mmFixed  = (markings===1 || markings===2) ? reconcileDealeasyTags(mmMerged, markings) : mmMerged;
        const res2 = await shopifyGraphQL(m, { input:{ id: gid, tags: Array.from(new Set(mmFixed)), title: after.title } });
        const ue2 = res2.productUpdate?.userErrors || [];
        if (ue2.length) throw new Error('productUpdate retry errors: ' + JSON.stringify(ue2));
        return { ok:true, title: after.title, tags: Array.from(new Set(mmFixed)), retried:true };
      }

      return { ok:true, title: nextTitle, tags: nextTags };
    }catch(e){
      if (i===retries) return { ok:false, error:e.message };
      await new Promise(r=>setTimeout(r, waitMs));
    }
  }
}

function parseBody(body){
  if (!body) return {};
  if (typeof body === 'string'){ try{ return JSON.parse(body); } catch { return {}; } }
  return body;
}

module.exports = async function handler(req,res){
  setCors(req,res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error:'Method not allowed' });

  try{
    if (req.method === 'GET'){
      const pid = req.query?.productId ? String(req.query.productId) : null;
      const did = req.query?.designId || null;
      return res.status(200).json({
        byProduct: pid ? global.productCustomerMap.get(pid) || null : null,
        byDesign:  did ? global.designCustomerMap.get(did)  || null : null,
        sizes: { product: global.productCustomerMap.size || 0, design: global.designCustomerMap.size || 0 }
      });
    }

    const { designId, customerId, customerEmail, customerTag, productId, markings, baseMmTags, timestamp } = parseBody(req.body);
    if (!customerId || !customerEmail) return res.status(400).json({ error:'Missing customerId or customerEmail' });
    if (!isValidPro(customerTag))  return res.status(200).json({ success:false, reason:'not-pro' });
    if (!designId && !productId)   return res.status(400).json({ error:'Missing designId or productId' });

    const attrib = { customerId, customerEmail, customerTag, productId: productId || null, createdAt: Date.now(), from:'link-design-customer', sourceTs: timestamp || null };
    if (designId) global.designCustomerMap.set(designId, attrib);
    if (productId) global.productCustomerMap.set(String(productId), attrib);
    gcMaps();

    let tagging = null;
    if (productId){
      const mk = Number(markings);
      const mkNorm = (mk===1 || mk===2) ? mk : null;
      const seed = Array.isArray(baseMmTags) ? baseMmTags.filter(isMm) : [];
      tagging = await tagProductNow(productId, customerTag, { rename:true, markings: mkNorm, baseMmTags: seed, retries:6, waitMs:1500 });
    }

    return res.status(200).json({
      success:true,
      designId: designId || null,
      productId: productId || null,
      customerId, customerTag,
      markings: (Number(markings)===1 || Number(markings)===2) ? Number(markings) : null,
      tagging
    });
  }catch(err){
    console.error('[link-design-customer] error', err);
    return res.status(500).json({ error:'Internal server error', message: err.message });
  }
};
