// api/track-customer.js
// Tracking client Pro: silencieux, dédoublonné, rate-limité (CommonJS)

const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

// CORS permissif mais sain (ajuste si tu veux serrer)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /.*/;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
}

// Stockage en mémoire (volatile, c’est voulu)
if (!global.activeProSessions) global.activeProSessions = new Map(); // customerId -> sessionData
if (!global.lastActionMap)     global.lastActionMap     = new Map(); // key(customerId+action) -> ts

const SESSION_TTL_MS   = 30 * 60 * 1000; // 30 min
const ACTION_COOLDOWN  = 5 * 1000;       // 5 s par couple (customerId, action) pour calmer le spam

function isValidProTagArray(tags) {
  if (!tags) return null;
  const arr = Array.isArray(tags) ? tags : String(tags).split(',').map(t => String(t).trim());
  const pro = arr.find(tag => tag && tag.toLowerCase().startsWith('pro') && !BLACKLISTED_TAGS.includes(tag));
  return pro || null;
}

function extractCompanyName(tag) {
  if (!tag) return '';
  return String(tag).replace(/^pro[-_]?/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of global.activeProSessions.entries()) {
    if (now - s.lastActivity > SESSION_TTL_MS) global.activeProSessions.delete(id);
  }
  for (const [k, ts] of global.lastActionMap.entries()) {
    if (now - ts > SESSION_TTL_MS) global.lastActionMap.delete(k);
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
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { customerId, customerEmail, customerTags, action = 'activity' } = parseBody(req.body) || {};
    // Pas de données minimales -> on se tait (204), inutile de polluer en 400
    if (!customerId || !customerEmail) return res.status(204).end();

    const validTag = isValidProTagArray(customerTags);
    // Non-Pro -> 204 silencieux
    if (!validTag) return res.status(204).end();

    // Rate-limit basique par couple (customerId, action)
    const key = `${customerId}:${action}`;
    const now = Date.now();
    const last = global.lastActionMap.get(key) || 0;
    if (now - last < ACTION_COOLDOWN) return res.status(204).end();
    global.lastActionMap.set(key, now);

    const companyName = extractCompanyName(validTag);

    // Enregistrer/rafraîchir la session
    const sessionData = {
      customerId,
      customerEmail,
      customerTag: validTag,
      companyName,
      lastActivity: now,
      action,
      sessionId: `${customerId}_${now}`
    };
    global.activeProSessions.set(customerId, sessionData);
    gcSessions();

    // Log discret pour debug, réponse 200 uniquement quand on garde quelque chose
    console.log('[track-customer] updated', { customerId, action });

    return res.status(200).json({
      success: true,
      sessionId: sessionData.sessionId,
      customerTag: validTag,
      companyName,
      expiresInMs: SESSION_TTL_MS
    });
  } catch (err) {
    console.error('[track-customer] error', err);
    // Erreur réelle -> 500, pas 400
    return res.status(500).json({ error: 'server', message: err.message });
  }
};
