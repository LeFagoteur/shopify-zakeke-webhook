// api/track-customer.js
// Tracking de l'activité client Pro - Version CommonJS

const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

function extractValidProTag(tags) {
  if (!tags) return null;
  
  // Convertir en array si c'est une string
  const tagArray = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
  
  // Trouver un tag pro valide
  const proTag = tagArray.find(tag => 
    tag.startsWith('pro') && 
    !BLACKLISTED_TAGS.includes(tag) &&
    tag.length > 3
  );
  
  return proTag || null;
}

function extractCompanyName(tag) {
  if (!tag || !tag.startsWith('pro')) return '';
  return tag.substring(3);
}

module.exports = async function handler(req, res) {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      customerId, 
      customerEmail, 
      customerTags, 
      action = 'activity'
    } = req.body;
    
    console.log('👤 Tracking activité client:', {
      email: customerEmail,
      action,
      timestamp: new Date().toISOString()
    });
    
    // Valider le tag Pro
    const validTag = extractValidProTag(customerTags);
    
    if (!validTag) {
      console.log('⚠️ Pas un client Pro valide:', customerTags);
      return res.status(200).json({ 
        success: false, 
        message: 'Not a valid Pro customer' 
      });
    }
    
    const companyName = extractCompanyName(validTag);
    
    // Initialiser le stockage global si nécessaire
    if (!global.activeProSessions) {
      global.activeProSessions = new Map();
    }
    
    // Créer/Mettre à jour la session
    const sessionData = {
      customerId,
      customerEmail,
      customerTag: validTag,
      companyName,
      lastActivity: Date.now(),
      action,
      sessionId: `${customerId}_${Date.now()}`
    };
    
    global.activeProSessions.set(customerId, sessionData);
    
    console.log('✅ Session Pro enregistrée:', {
      email: customerEmail,
      company: companyName,
      tag: validTag,
      totalSessions: global.activeProSessions.size
    });
    
    // Nettoyer les vieilles sessions (plus de 30 minutes)
    const SESSION_TIMEOUT = 30 * 60 * 1000;
    const now = Date.now();
    
    for (const [id, session] of global.activeProSessions.entries()) {
      if (now - session.lastActivity > SESSION_TIMEOUT) {
        console.log('🧹 Nettoyage session expirée:', session.customerEmail);
        global.activeProSessions.delete(id);
      }
    }
    
    return res.status(200).json({ 
      success: true,
      sessionId: sessionData.sessionId,
      customerTag: validTag,
      companyName
    });
    
  } catch (error) {
    console.error('❌ Erreur tracking client:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};
