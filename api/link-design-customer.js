export default async function handler(req, res) {
  // Autoriser les requêtes POST uniquement
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS pour permettre les appels depuis Shopify
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const { designId, customerId, customerEmail, customerTag } = req.body;
  
  console.log('🔗 Association design-client reçue:', {
    designId,
    customerId,
    customerEmail,
    customerTag
  });

  // Pour l'instant, on stocke juste en mémoire
  // (Dans une vraie app, utilisez une base de données)
  global.designCustomerMap = global.designCustomerMap || new Map();
  global.designCustomerMap.set(designId, {
    customerId,
    customerEmail,
    customerTag,
    timestamp: Date.now()
  });

  return res.status(200).json({ 
    success: true,
    message: 'Association enregistrée'
  });
}
