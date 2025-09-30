// api/track-customer.js
// Tracking de l'activité client Pro (CommonJS • Vercel • sans deps externes)

// ------------------------
// Config CORS (restreint)
// ------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN_REGEX
  ? new RegExp(process.env.ALLOWED_ORIGIN_REGEX)
  : /^https:\/\/([a-z0-9-]+\.)*lefagoteur\.com$/i; // ex: www.lefagoteur.com

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
if (!global.activeProSessions) {
  global.activeProSessions = new Map(); // customerId -> sessionData
}
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function gcSessions() {
  const now = Date.now();
  for (const [id, session] of global.activeProSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      global.activeProSessions.delete(id);
    }
  }
}

// ------------------------
// Utils
// ------------------------
const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

function normalizeBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return body;
}

function toArrayTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  return String(tags)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
}

function extractValidProTag(tags) {
  const tagArray = toArrayTags(tags);
  const pro = tagArray.find(tag =>
    tag &&
    tag.toLowerCase().startsWith('pro') &&
    !BLACKLISTED_TAGS.includes(tag) &&
    tag.length > 3
  );
  return pro || null;
}

// "proMaSuperBoite" → "MaSuperBoite" (tu utilises ça pour info/renommage côté produit)
function extractCompanyName(tag) {
  if (!tag) return '';
  const t = String(tag);
  if (!t.toLowerCase().startsWith('pro')) return '';
  return t.slice(3);
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
    // GET (debug facultatif): /api/track-customer?customerId=xxx
    if (req.method === 'GET') {
      const id = (req.query && req.query.customerId) || '';
      if (!id) {
        return res.status(200).json({
          sessions: global.activeProSessions.size,
          timeoutMs: SESSION_TIMEOUT_MS
        });
      }
      const session = global.activeProSessions.get(id) || null;
      return res.status(200).json({
        exists: !!session,
        session,
        timeoutMs: SESSION_TIMEOUT_MS
      });
    }

    // POST
    const { customerId, customerEmail, customerTags, action = 'activity' } = normalizeBody(req.body);

    if (!customerId || !customerEmail) {
      return res.status(400).json({ error: 'Missing customerId or customerEmail' });
    }

    const validTag = extractValidProTag(customerTags);
    if (!validTag) {
      // On répond 200 pour ne pas spammer les erreurs front, mais on indique l’état
      return res.status(200).json({
        success: false,
        reason: 'not-pro',
        message: 'Not a valid Pro customer',
      });
    }

    const companyName = extractCompanyName(validTag);

    const sessionData = {
      customerId,
      customerEmail,           // À éviter dans les logs bruts
      customerTag: validTag,
      companyName,
      lastActivity: Date.now(),
      lastAction: action,
      sessionId: `${customerId}_${Date.now()}`
    };

    global.activeProSessions.set(customerId, sessionData);
    gcSessions();

    // Logs sobres (RGPD friendly): on masque l’email
    const masked = String(customerEmail).replace(/(^.).*(@.*$)/, '$1***$2');
    console.log('[track-customer] updated', {
      customerId,
      email: masked,
      tag: validTag,
      action
    });

    return res.status(200).json({
      success: true,
      sessionId: sessionData.sessionId,
      customerTag: validTag,
      companyName,
      expiresInMs: SESSION_TIMEOUT_MS
    });

  } catch (err) {
    console.error('[track-customer] error', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
