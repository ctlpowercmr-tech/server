const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['https://ctl-distributeur.netlify.app', 'https://ctl-duseur.netlify.app', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Stockage en mémoire
let transactions = new Map();
let soldeDistributeur = 0;
let soldeUtilisateur = 50.00;

// Routes API
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'API Distributeur fonctionnelle',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/transaction', (req, res) => {
  try {
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
      dateExpiration: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    };
    
    transactions.set(transactionId, transaction);
    
    console.log(`Nouvelle transaction: ${transactionId}, Montant: ${montant}€`);
    
    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    console.error('Erreur création transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.get('/api/transaction/:id', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Erreur récupération transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.post('/api/transaction/:id/payer', (req, res) => {
  try {
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
    
    console.log(`Paiement réussi: ${transaction.id}`);
    
    res.json({
      success: true,
      data: transaction,
      nouveauSoldeUtilisateur: soldeUtilisateur
    });
  } catch (error) {
    console.error('Erreur paiement:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.post('/api/transaction/:id/annuler', (req, res) => {
  try {
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
  } catch (error) {
    console.error('Erreur annulation:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
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

// Nettoyage des transactions expirées
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

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Exception non capturée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Rejet non géré:', reason);
});

// Démarrage du serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📍 URL: http://0.0.0.0:${PORT}`);
});
