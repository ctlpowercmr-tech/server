const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json());

// Générer un ID court
function genererIdCourt() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'TX';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Routes API
app.get('/api/health', async (req, res) => {
  try {
    // Tester la connexion à la base de données
    await db.pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      message: 'API et base de données fonctionnelles',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Erreur connexion base de données',
      error: error.message
    });
  }
});

app.post('/api/transaction', async (req, res) => {
  try {
    const { montant, boissons } = req.body;
    
    if (!montant || !boissons) {
      return res.status(400).json({ 
        success: false, 
        error: 'Données manquantes' 
      });
    }

    const transactionId = genererIdCourt();
    
    const transaction = {
      id: transactionId,
      montant: parseFloat(montant),
      boissons,
      statut: 'en_attente',
      dateExpiration: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    };
    
    const transactionCreee = await db.creerTransaction(transaction);
    
    console.log(`💾 Nouvelle transaction sauvegardée: ${transactionId}, Montant: ${montant}€`);
    
    res.json({
      success: true,
      data: transactionCreee
    });
  } catch (error) {
    console.error('Erreur création transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.get('/api/transaction/:id', async (req, res) => {
  try {
    const transaction = await db.getTransaction(req.params.id);
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    // Vérifier l'expiration
    if (new Date() > new Date(transaction.date_expiration) && transaction.statut === 'en_attente') {
      await db.mettreAJourTransactionStatut(transaction.id, 'expire');
      transaction.statut = 'expire';
    }
    
    res.json({
      success: true,
      data: {
        id: transaction.id,
        montant: parseFloat(transaction.montant),
        boissons: transaction.boissons,
        statut: transaction.statut,
        date: transaction.date_creation,
        dateExpiration: transaction.date_expiration
      }
    });
  } catch (error) {
    console.error('Erreur récupération transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.post('/api/transaction/:id/payer', async (req, res) => {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const transaction = await db.getTransaction(req.params.id);
    
    if (!transaction) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    if (transaction.statut !== 'en_attente') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Transaction déjà ${transaction.statut}`
      });
    }
    
    // Vérifier le solde utilisateur
    const soldeUtilisateur = await db.getSolde('utilisateur');
    if (soldeUtilisateur < transaction.montant) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Solde insuffisant'
      });
    }
    
    // Effectuer le paiement
    const nouveauSoldeUtilisateur = soldeUtilisateur - parseFloat(transaction.montant);
    const soldeDistributeur = await db.getSolde('distributeur');
    const nouveauSoldeDistributeur = soldeDistributeur + parseFloat(transaction.montant);
    
    // Mettre à jour les soldes
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = NOW() WHERE type = $2',
      [nouveauSoldeUtilisateur, 'utilisateur']
    );
    
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = NOW() WHERE type = $2',
      [nouveauSoldeDistributeur, 'distributeur']
    );
    
    // Mettre à jour la transaction
    await db.mettreAJourTransactionStatut(transaction.id, 'paye');
    
    await client.query('COMMIT');
    
    console.log(`✅ Paiement réussi: ${transaction.id}`);
    
    res.json({
      success: true,
      data: {
        ...transaction,
        statut: 'paye',
        datePaiement: new Date().toISOString()
      },
      nouveauSoldeUtilisateur: nouveauSoldeUtilisateur
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur paiement:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  } finally {
    client.release();
  }
});

app.post('/api/transaction/:id/annuler', async (req, res) => {
  try {
    const transaction = await db.mettreAJourTransactionStatut(req.params.id, 'annule');
    
    if (transaction) {
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

// Route pour recharger le solde utilisateur
app.post('/api/solde/utilisateur/recharger', async (req, res) => {
  try {
    const { montant } = req.body;
    
    if (!montant || montant <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Montant invalide'
      });
    }
    
    const nouveauSolde = await db.rechargerSoldeUtilisateur(montant);
    
    console.log(`💰 Rechargement solde: +${montant}€, Nouveau solde: ${nouveauSolde}€`);
    
    res.json({
      success: true,
      nouveauSolde: nouveauSolde,
      message: `Votre solde a été rechargé de ${montant}€`
    });
  } catch (error) {
    console.error('Erreur rechargement:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.get('/api/solde/distributeur', async (req, res) => {
  try {
    const solde = await db.getSolde('distributeur');
    res.json({
      success: true,
      solde: parseFloat(solde)
    });
  } catch (error) {
    console.error('Erreur récupération solde distributeur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.get('/api/solde/utilisateur', async (req, res) => {
  try {
    const solde = await db.getSolde('utilisateur');
    res.json({
      success: true,
      solde: parseFloat(solde)
    });
  } catch (error) {
    console.error('Erreur récupération solde utilisateur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Nettoyage périodique des transactions expirées
setInterval(() => {
  db.nettoyerTransactionsExpirees();
}, 60 * 60 * 1000); // Toutes les heures

// Démarrage du serveur
async function demarrerServeur() {
  try {
    // Initialiser la base de données
    await db.initDatabase();
    
    // Démarrer le serveur
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
      console.log(`🗄️  Base de données PostgreSQL connectée`);
      console.log(`📍 URL: http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Impossible de démarrer le serveur:', error);
    process.exit(1);
  }
}

demarrerServeur();
