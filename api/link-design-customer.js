const BLACKLISTED_TAGS = ['membre-pro', 'membre-premium', 'membre-gratuit'];

function extractValidProTag(customerTag) {
  if (!customerTag) return null;
  
  // Si c'est déjà un tag valide (pas blacklisté et commence par "pro")
  if (customerTag.startsWith('pro') && !BLACKLISTED_TAGS.includes(customerTag)) {
    return customerTag;
  }
  
  return null;
}

module.exports = async function handler(req, res) {
  // ✅ HEADERS CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { designId, customerId, customerEmail, customerTag } = req.body;
  
  console.log('🔗 Association design-client reçue:', {
    designId,
    customerId,
    customerEmail,
    customerTag,
    timestamp: new Date().toISOString()
  });

  // ✅ VALIDATION : Vérifier que le tag est valide
  const validTag = extractValidProTag(customerTag);
  
  if (!validTag) {
    console.warn('⚠️ Tag client invalide ou blacklisté:', customerTag);
    return res.status(400).json({ 
      success: false,
      message: 'Tag client invalide',
      receivedTag: customerTag
    });
  }

  // Stocker avec le tag validé
  global.designCustomerMap = global.designCustomerMap || {};
  global.designCustomerMap[designId] = {
    customerId,
    customerEmail,
    customerTag: validTag, // ✅ Utiliser le tag validé
    timestamp: Date.now()
  };

  console.log('✅ Association valide stockée avec tag:', validTag);

  return res.status(200).json({ 
    success: true,
    message: 'Association enregistrée',
    designId,
    validTag
  });
};
