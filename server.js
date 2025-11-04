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
  origin: '*',
  credentials: true
}));
app.use(express.json());

// Initialisation de la base de données
async function initialiserBaseDeDonnees() {
  try {
    console.log('🔧 Initialisation de la base de données...');
    
    // Créer la table des transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        montant DECIMAL(10,2) NOT NULL,
        boissons JSONB NOT NULL,
        statut VARCHAR(20) NOT NULL,
        date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        date_expiration TIMESTAMP,
        date_paiement TIMESTAMP
      )
    `);
    
    // Créer la table des soldes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soldes (
        type VARCHAR(50) PRIMARY KEY,
        solde DECIMAL(10,2) NOT NULL DEFAULT 0,
        date_maj TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Initialiser les soldes s'ils n'existent pas
    await pool.query(`
      INSERT INTO soldes (type, solde) 
      VALUES 
        ('distributeur', 0),
        ('utilisateur', 50)
      ON CONFLICT (type) DO NOTHING
    `);
    
    console.log('✅ Base de données initialisée avec succès');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error);
    throw error;
  }
}

// Routes API
app.get('/api/health', async (req, res) => {
  try {
    // Tester la connexion à la base de données
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      message: 'API et Base de données fonctionnelles',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Erreur base de données',
      error: error.message
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

    // Générer un ID court
    const genererIdCourt = () => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let result = 'TX';
      for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    const transactionId = genererIdCourt();
    const dateExpiration = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    
    // Insérer la transaction
    const result = await client.query(
      `INSERT INTO transactions (id, montant, boissons, statut, date_expiration)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [transactionId, parseFloat(montant), JSON.stringify(boissons), 'en_attente', dateExpiration]
    );
    
    await client.query('COMMIT');
    
    console.log(`Nouvelle transaction: ${transactionId}, Montant: ${montant}€`);
    
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
    
    let transaction = result.rows[0];
    
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
    
    // Récupérer la transaction
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
    
    // Récupérer le solde utilisateur
    const soldeResult = await client.query(
      'SELECT solde FROM soldes WHERE type = $1 FOR UPDATE',
      ['utilisateur']
    );
    
    const soldeUtilisateur = parseFloat(soldeResult.rows[0].solde);
    
    // Vérifier le solde utilisateur
    if (soldeUtilisateur < transaction.montant) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Solde insuffisant'
      });
    }
    
    // Effectuer le paiement
    const nouveauSoldeUtilisateur = soldeUtilisateur - parseFloat(transaction.montant);
    
    // Mettre à jour le solde utilisateur
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = CURRENT_TIMESTAMP WHERE type = $2',
      [nouveauSoldeUtilisateur, 'utilisateur']
    );
    
    // Mettre à jour le solde distributeur
    const soldeDistributeurResult = await client.query(
      'SELECT solde FROM soldes WHERE type = $1 FOR UPDATE',
      ['distributeur']
    );
    
    const soldeDistributeur = parseFloat(soldeDistributeurResult.rows[0].solde);
    const nouveauSoldeDistributeur = soldeDistributeur + parseFloat(transaction.montant);
    
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = CURRENT_TIMESTAMP WHERE type = $2',
      [nouveauSoldeDistributeur, 'distributeur']
    );
    
    // Mettre à jour le statut de la transaction
    await client.query(
      'UPDATE transactions SET statut = $1, date_paiement = CURRENT_TIMESTAMP WHERE id = $2',
      ['paye', transaction.id]
    );
    
    await client.query('COMMIT');
    
    console.log(`Paiement réussi: ${transaction.id}`);
    
    res.json({
      success: true,
      data: {
        ...transaction,
        boissons: JSON.parse(transaction.boissons),
        statut: 'paye',
        date_paiement: new Date().toISOString()
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
    
    res.json({
      success: true,
      data: {
        ...result.rows[0],
        boissons: JSON.parse(result.rows[0].boissons)
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
    
    // Récupérer le solde actuel
    const soldeResult = await client.query(
      'SELECT solde FROM soldes WHERE type = $1 FOR UPDATE',
      ['utilisateur']
    );
    
    const soldeActuel = parseFloat(soldeResult.rows[0].solde);
    const nouveauSolde = soldeActuel + parseFloat(montant);
    
    // Mettre à jour le solde
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = CURRENT_TIMESTAMP WHERE type = $2',
      [nouveauSolde, 'utilisateur']
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
    const result = await pool.query(
      'SELECT solde FROM soldes WHERE type = $1',
      ['distributeur']
    );
    
    res.json({
      success: true,
      solde: parseFloat(result.rows[0].solde)
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
    const result = await pool.query(
      'SELECT solde FROM soldes WHERE type = $1',
      ['utilisateur']
    );
    
    res.json({
      success: true,
      solde: parseFloat(result.rows[0].solde)
    });
  } catch (error) {
    console.error('Erreur récupération solde utilisateur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Nettoyage des transactions expirées toutes les heures
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE transactions 
       SET statut = 'expire' 
       WHERE date_expiration < CURRENT_TIMESTAMP 
       AND statut = 'en_attente'
       RETURNING id`
    );
    
    if (result.rows.length > 0) {
      console.log(`Nettoyage: ${result.rows.length} transactions expirées`);
    }
  } catch (error) {
    console.error('Erreur nettoyage transactions expirées:', error);
  }
}, 60 * 60 * 1000);

// Démarrage du serveur
async function demarrerServeur() {
  try {
    // Initialiser la base de données
    await initialiserBaseDeDonnees();
    
    // Démarrer le serveur
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
      console.log(`📍 URL: http://0.0.0.0:${PORT}`);
      console.log(`🗄️  Base de données PostgreSQL connectée`);
      console.log(`✅ Prêt à recevoir des transactions!`);
    });
  } catch (error) {
    console.error('❌ Impossible de démarrer le serveur:', error);
    process.exit(1);
  }
}

demarrerServeur();
