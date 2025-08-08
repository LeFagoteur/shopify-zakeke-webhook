export default async function handler(req, res) {
  console.log('🚫 Webhook temporairement désactivé pour test Zakeke');
  console.log('📦 Données reçues (mais ignorées):', JSON.stringify(req.body, null, 2));
  
  // Ne fait rien, retourne juste OK
  return res.status(200).json({ 
    status: 'success', 
    processed: false, 
    message: 'Webhook désactivé temporairement pour test' 
  });
}
