const express = require('express');
const cors = require('cors');
const { pool, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// Initialisation de la base de données au démarrage
initDatabase();

// Générer un ID court pour les transactions
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
    // Test de connexion à la base de données
    await pool.query('SELECT 1');
    res.json({ 
      status: 'OK', 
      message: 'API et base de données fonctionnelles',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'ERROR', 
      message: 'Erreur base de données' 
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
    const dateExpiration = new Date(Date.now() + 10 * 60 * 1000);
    
    // Insertion de la transaction dans la base de données
    await client.query(
      `INSERT INTO transactions (id, montant, boissons, date_expiration)
       VALUES ($1, $2, $3, $4)`,
      [transactionId, montant, JSON.stringify(boissons), dateExpiration]
    );
    
    await client.query('COMMIT');
    
    console.log(`Nouvelle transaction: ${transactionId}, Montant: ${montant}€`);
    
    res.json({
      success: true,
      data: {
        id: transactionId,
        montant: parseFloat(montant),
        boissons,
        statut: 'en_attente',
        date: new Date().toISOString(),
        dateExpiration: dateExpiration.toISOString()
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
        id: transaction.id,
        montant: parseFloat(transaction.montant),
        boissons: transaction.boissons,
        statut: transaction.statut,
        date: transaction.date_creation.toISOString(),
        dateExpiration: transaction.date_expiration.toISOString()
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
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = transactionResult.rows[0];
    
    if (transaction.statut !== 'en_attente') {
      return res.status(400).json({
        success: false,
        error: `Transaction déjà ${transaction.statut}`
      });
    }
    
    // Vérifier le solde utilisateur
    const soldeResult = await client.query(
      'SELECT solde FROM soldes WHERE type = $1',
      ['utilisateur']
    );
    
    const soldeUtilisateur = parseFloat(soldeResult.rows[0].solde);
    
    if (soldeUtilisateur < transaction.montant) {
      return res.status(400).json({
        success: false,
        error: 'Solde insuffisant'
      });
    }
    
    // Effectuer le paiement
    await client.query(
      'UPDATE soldes SET solde = solde - $1, derniere_maj = CURRENT_TIMESTAMP WHERE type = $2',
      [transaction.montant, 'utilisateur']
    );
    
    await client.query(
      'UPDATE soldes SET solde = solde + $1, derniere_maj = CURRENT_TIMESTAMP WHERE type = $2',
      [transaction.montant, 'distributeur']
    );
    
    await client.query(
      'UPDATE transactions SET statut = $1, date_paiement = CURRENT_TIMESTAMP WHERE id = $2',
      ['paye', transaction.id]
    );
    
    await client.query('COMMIT');
    
    // Récupérer le nouveau solde utilisateur
    const nouveauSoldeResult = await client.query(
      'SELECT solde FROM soldes WHERE type = $1',
      ['utilisateur']
    );
    
    console.log(`Paiement réussi: ${transaction.id}`);
    
    res.json({
      success: true,
      data: {
        id: transaction.id,
        montant: parseFloat(transaction.montant),
        boissons: transaction.boissons,
        statut: 'paye',
        datePaiement: new Date().toISOString()
      },
      nouveauSoldeUtilisateur: parseFloat(nouveauSoldeResult.rows[0].solde)
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

// Route pour recharger le solde (existant)
app.post('/api/solde/utilisateur/recharger', async (req, res) => {
  try {
    const { montant } = req.body;
    
    if (!montant || montant <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Montant invalide'
      });
    }
    
    const result = await pool.query(
      'UPDATE soldes SET solde = solde + $1, derniere_maj = CURRENT_TIMESTAMP WHERE type = $2 RETURNING solde',
      [montant, 'utilisateur']
    );
    
    console.log(`Rechargement solde: +${montant}€`);
    
    res.json({
      success: true,
      nouveauSolde: parseFloat(result.rows[0].solde),
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

// Routes pour consulter les soldes
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
    res.status(500).json({ success: false, error: 'Erreur serveur' });
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
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
});

// Nettoyage des transactions expirées (optionnel - peut être une tâche planifiée)
app.post('/api/nettoyage-transactions', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE transactions 
       SET statut = 'expire' 
       WHERE statut = 'en_attente' AND date_expiration < CURRENT_TIMESTAMP`
    );
    
    res.json({
      success: true,
      message: `${result.rowCount} transactions expirées nettoyées`
    });
  } catch (error) {
    console.error('Erreur nettoyage:', error);
    res.status(500).json({ success: false, error: 'Erreur nettoyage' });
  }
});

// Démarrer le serveur
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Serveur backend démarré sur le port ${PORT}`);
  console.log(`📍 Connexion à la base de données PostgreSQL établie`);
});
