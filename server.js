const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors({
  origin: ['https://ctl-distributeur.netlify.app', 'https://ctl-duseur.netlify.app', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());

// Initialisation de la base de données
async function initialiserBaseDeDonnees() {
  try {
    console.log('🔧 Initialisation de la base de données...');
    
    // Création de la table transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        montant DECIMAL(10,2) NOT NULL,
        statut VARCHAR(20) NOT NULL DEFAULT 'en_attente',
        boissons JSONB NOT NULL,
        date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        date_expiration TIMESTAMP NOT NULL,
        date_paiement TIMESTAMP,
        UNIQUE(id)
      )
    `);
    
    // Création de la table soldes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soldes (
        id VARCHAR(50) PRIMARY KEY DEFAULT 'unique',
        solde_distributeur DECIMAL(10,2) DEFAULT 0,
        solde_utilisateur DECIMAL(10,2) DEFAULT 50.00,
        date_maj TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Insérer les soldes initiaux s'ils n'existent pas
    await pool.query(`
      INSERT INTO soldes (id, solde_distributeur, solde_utilisateur) 
      VALUES ('unique', 0, 50.00) 
      ON CONFLICT (id) DO NOTHING
    `);
    
    console.log('✅ Base de données initialisée avec succès');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error);
    throw error;
  }
}

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
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      message: 'API et base de données fonctionnelles',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Erreur health check:', error);
    res.status(500).json({
      status: 'ERROR',
      message: 'Problème de connexion à la base de données'
    });
  }
});

app.post('/api/transaction', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { montant, boissons } = req.body;
    
    if (!montant || !boissons) {
      return res.status(400).json({ 
        success: false, 
        error: 'Données manquantes' 
      });
    }

    const transactionId = genererIdCourt();
    const dateExpiration = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Insérer la transaction
    const result = await client.query(
      `INSERT INTO transactions (id, montant, boissons, date_expiration) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [transactionId, parseFloat(montant), JSON.stringify(boissons), dateExpiration]
    );
    
    await client.query('COMMIT');
    
    console.log(`Nouvelle transaction créée: ${transactionId}, Montant: ${montant}€`);
    
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        boissons: JSON.parse(result.rows[0].boissons)
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur création transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  } finally {
    client.release();
  }
});

app.get('/api/transaction/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = result.rows[0];
    
    // Vérifier l'expiration
    if (new Date() > new Date(transaction.date_expiration) && transaction.statut === 'en_attente') {
      await pool.query(
        'UPDATE transactions SET statut = $1 WHERE id = $2',
        ['expire', transaction.id]
      );
      transaction.statut = 'expire';
    }
    
    res.json({
      success: true,
      data: {
        ...transaction,
        boissons: JSON.parse(transaction.boissons)
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
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Vérifier la transaction
    const transactionResult = await client.query(
      'SELECT * FROM transactions WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    
    if (transactionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = transactionResult.rows[0];
    
    if (transaction.statut !== 'en_attente') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Transaction déjà ${transaction.statut}`
      });
    }
    
    // Vérifier le solde utilisateur
    const soldeResult = await client.query(
      'SELECT * FROM soldes WHERE id = $1 FOR UPDATE',
      ['unique']
    );
    
    const soldes = soldeResult.rows[0];
    
    if (soldes.solde_utilisateur < transaction.montant) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Solde insuffisant'
      });
    }
    
    // Effectuer le paiement
    const nouveauSoldeUtilisateur = parseFloat(soldes.solde_utilisateur) - parseFloat(transaction.montant);
    const nouveauSoldeDistributeur = parseFloat(soldes.solde_distributeur) + parseFloat(transaction.montant);
    
    await client.query(
      'UPDATE soldes SET solde_utilisateur = $1, solde_distributeur = $2 WHERE id = $3',
      [nouveauSoldeUtilisateur, nouveauSoldeDistributeur, 'unique']
    );
    
    await client.query(
      'UPDATE transactions SET statut = $1, date_paiement = $2 WHERE id = $3',
      ['paye', new Date(), transaction.id]
    );
    
    await client.query('COMMIT');
    
    console.log(`Paiement réussi: ${transaction.id}`);
    
    res.json({
      success: true,
      data: {
        ...transaction,
        boissons: JSON.parse(transaction.boissons),
        statut: 'paye',
        date_paiement: new Date()
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
    const result = await pool.query(
      'UPDATE transactions SET statut = $1 WHERE id = $2 RETURNING *',
      ['annule', req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = result.rows[0];
    
    res.json({
      success: true,
      data: {
        ...transaction,
        boissons: JSON.parse(transaction.boissons)
      }
    });
  } catch (error) {
    console.error('Erreur annulation:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Recharger le solde utilisateur
app.post('/api/solde/utilisateur/recharger', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { montant } = req.body;
    
    if (!montant || montant <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Montant invalide'
      });
    }
    
    const soldeResult = await client.query(
      'SELECT * FROM soldes WHERE id = $1 FOR UPDATE',
      ['unique']
    );
    
    const soldes = soldeResult.rows[0];
    const nouveauSolde = parseFloat(soldes.solde_utilisateur) + parseFloat(montant);
    
    await client.query(
      'UPDATE soldes SET solde_utilisateur = $1 WHERE id = $2',
      [nouveauSolde, 'unique']
    );
    
    await client.query('COMMIT');
    
    console.log(`Rechargement solde: +${montant}€, Nouveau solde: ${nouveauSolde}€`);
    
    res.json({
      success: true,
      nouveauSolde: nouveauSolde,
      message: `Votre solde a été rechargé de ${montant}€`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Erreur rechargement:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  } finally {
    client.release();
  }
});

app.get('/api/solde/distributeur', async (req, res) => {
  try {
    const result = await pool.query('SELECT solde_distributeur FROM soldes WHERE id = $1', ['unique']);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Soldes non trouvés'
      });
    }
    
    res.json({
      success: true,
      solde: parseFloat(result.rows[0].solde_distributeur)
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
    const result = await pool.query('SELECT solde_utilisateur FROM soldes WHERE id = $1', ['unique']);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Soldes non trouvés'
      });
    }
    
    res.json({
      success: true,
      solde: parseFloat(result.rows[0].solde_utilisateur)
    });
  } catch (error) {
    console.error('Erreur récupération solde utilisateur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Nettoyage des transactions expirées
async function nettoyerTransactionsExpirees() {
  try {
    const result = await pool.query(
      `UPDATE transactions 
       SET statut = 'expire' 
       WHERE statut = 'en_attente' 
       AND date_expiration < $1`,
      [new Date()]
    );
    
    if (result.rowCount > 0) {
      console.log(`Nettoyage: ${result.rowCount} transactions expirées`);
    }
  } catch (error) {
    console.error('Erreur nettoyage transactions:', error);
  }
}

// Démarrage du serveur
async function demarrerServeur() {
  try {
    // Initialiser la base de données
    await initialiserBaseDeDonnees();
    
    // Nettoyer les transactions expirées au démarrage
    await nettoyerTransactionsExpirees();
    
    // Planifier le nettoyage toutes les heures
    setInterval(nettoyerTransactionsExpirees, 60 * 60 * 1000);
    
    // Démarrer le serveur
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
      console.log(`📍 URL: http://0.0.0.0:${PORT}`);
      console.log(`🗄️  Base de données PostgreSQL connectée`);
      console.log(`✅ Prêt à recevoir des requêtes!`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

// Gestion propre de l'arrêt
process.on('SIGINT', async () => {
  console.log('🛑 Arrêt du serveur en cours...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 Arrêt du serveur en cours...');
  await pool.end();
  process.exit(0);
});

// Démarrer le serveur
demarrerServeur();
