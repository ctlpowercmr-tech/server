const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['https://ctl-distributeur.netlify.app', 'https://ctl-duseur.netlify.app'],
  credentials: true
}));
app.use(express.json());

// Stockage en mémoire (remplacera par base de données en production)
let transactions = new Map();
let soldeDistributeur = 0;
let soldeUtilisateur = 50.00; // Solde initial utilisateur

// Routes API
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'API Distributeur fonctionnelle' });
});

app.post('/api/transaction', (req, res) => {
  const { montant, boissons } = req.body;
  
  if (!montant || !boissons) {
    return res.status(400).json({ 
      success: false, 
      error: 'Données manquantes' 
    });
  }

  const transactionId = 'TXN_' + uuidv4();
  
  const transaction = {
    id: transactionId,
    montant: parseFloat(montant),
    boissons,
    statut: 'en_attente',
    date: new Date().toISOString(),
    dateExpiration: new Date(Date.now() + 10 * 60 * 1000).toISOString() // Expire dans 10 min
  };
  
  transactions.set(transactionId, transaction);
  
  console.log(`Nouvelle transaction créée: ${transactionId}, Montant: ${montant}€`);
  
  res.json({
    success: true,
    data: transaction
  });
});

app.get('/api/transaction/:id', (req, res) => {
  const transaction = transactions.get(req.params.id);
  
  if (!transaction) {
    return res.status(404).json({
      success: false,
      error: 'Transaction non trouvée'
    });
  }
  
  // Vérifier l'expiration
  if (new Date() > new Date(transaction.dateExpiration)) {
    transaction.statut = 'expire';
  }
  
  res.json({
    success: true,
    data: transaction
  });
});

app.post('/api/transaction/:id/payer', (req, res) => {
  const transaction = transactions.get(req.params.id);
  
  if (!transaction) {
    return res.status(404).json({
      success: false,
      error: 'Transaction non trouvée'
    });
  }
  
  if (transaction.statut !== 'en_attente') {
    return res.status(400).json({
      success: false,
      error: `Transaction déjà ${transaction.statut}`
    });
  }
  
  // Vérifier le solde utilisateur
  if (soldeUtilisateur < transaction.montant) {
    return res.status(400).json({
      success: false,
      error: 'Solde insuffisant'
    });
  }
  
  // Effectuer le paiement
  soldeUtilisateur -= transaction.montant;
  soldeDistributeur += transaction.montant;
  transaction.statut = 'paye';
  transaction.datePaiement = new Date().toISOString();
  
  console.log(`Paiement réussi: ${transaction.id}, Nouveau solde distributeur: ${soldeDistributeur}€`);
  
  res.json({
    success: true,
    data: transaction,
    nouveauSoldeUtilisateur: soldeUtilisateur
  });
});

app.post('/api/transaction/:id/annuler', (req, res) => {
  const transaction = transactions.get(req.params.id);
  
  if (transaction) {
    transaction.statut = 'annule';
    res.json({
      success: true,
      data: transaction
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Transaction non trouvée'
    });
  }
});

app.get('/api/solde/distributeur', (req, res) => {
  res.json({
    success: true,
    solde: soldeDistributeur
  });
});

app.get('/api/solde/utilisateur', (req, res) => {
  res.json({
    success: true,
    solde: soldeUtilisateur
  });
});

// Nettoyage des transactions expirées toutes les heures
setInterval(() => {
  const maintenant = new Date();
  let nbSupprimes = 0;
  
  transactions.forEach((transaction, id) => {
    if (new Date(transaction.dateExpiration) < maintenant && transaction.statut === 'en_attente') {
      transactions.delete(id);
      nbSupprimes++;
    }
  });
  
  if (nbSupprimes > 0) {
    console.log(`Nettoyage: ${nbSupprimes} transactions expirées supprimées`);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://localhost:${PORT}`);
});