// Ce fichier reçoit TOUTES les données que Shopify envoie
module.exports = function handler(req, res) {
  
  // Afficher dans les logs (pour que tu puisses voir)
  console.log('🎯 Quelqu\'un a appelé mon endpoint !');
  console.log('📝 Méthode utilisée:', req.method);
  console.log('📦 Données reçues:', req.body);
  console.log('🕒 Heure:', new Date().toLocaleString());
  
  // Renvoyer une réponse à Shopify
  return res.status(200).json({
    message: 'J\'ai bien reçu tes données, Shopify !',
    timestamp: new Date().toISOString(),
    received: req.body
  });
}
