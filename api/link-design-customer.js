module.exports = async function handler(req, res) {
  // Autoriser CORS
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

  // Stocker temporairement (utilisez une DB en production)
  global.designCustomerMap = global.designCustomerMap || {};
  global.designCustomerMap[designId] = {
    customerId,
    customerEmail,
    customerTag,
    timestamp: Date.now()
  };

  return res.status(200).json({ 
    success: true,
    message: 'Association enregistrée',
    designId
  });
};
