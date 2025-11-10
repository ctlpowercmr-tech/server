const express = require('express');
const cors = require('cors');
const { pool, testerConnexionBDD, initialiserBDD } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

let estConnecteBDD = false;

app.use(async (req, res, next) => {
  if (!estConnecteBDD) {
    estConnecteBDD = await testerConnexionBDD();
    if (!estConnecteBDD) {
      return res.status(503).json({
        success: false,
        error: 'Base de données non disponible'
      });
    }
  }
  next();
});

function genererIdCourt() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = 'CTL';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Routes API
app.get('/api/health', async (req, res) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    
    res.json({ 
      status: 'OK', 
      message: 'API CTL-Power fonctionnelle',
      timestamp: new Date().toISOString(),
      bdd: 'CONNECTÉE'
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      message: 'Problème avec la base de données',
      timestamp: new Date().toISOString(),
      bdd: 'DÉCONNECTÉE'
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
    const dateExpiration = new Date(Date.now() + 10 * 60 * 1000);
    
    const client = await pool.connect();
    
    const result = await client.query(
      `INSERT INTO transactions (id, montant, boissons, statut, date_expiration)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [transactionId, parseFloat(montant), JSON.stringify(boissons), 'en_attente', dateExpiration]
    );
    
    client.release();
    
    const transaction = {
      id: result.rows[0].id,
      montant: parseFloat(result.rows[0].montant),
      boissons: result.rows[0].boissons,
      statut: result.rows[0].statut,
      date: result.rows[0].date_creation,
      dateExpiration: result.rows[0].date_expiration
    };
    
    console.log(`Nouvelle transaction CTL: ${transactionId}, Montant: ${montant}FCFA`);
    
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

app.get('/api/transaction/:id', async (req, res) => {
  try {
    const client = await pool.connect();
    
    const result = await client.query(
      'SELECT * FROM transactions WHERE id = $1',
      [req.params.id]
    );
    
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = result.rows[0];
    
    if (new Date() > new Date(transaction.date_expiration) && transaction.statut === 'en_attente') {
      await pool.query(
        'UPDATE transactions SET statut = $1 WHERE id = $2',
        ['expire', transaction.id]
      );
      transaction.statut = 'expire';
    }
    
    const transactionFormatee = {
      id: transaction.id,
      montant: parseFloat(transaction.montant),
      boissons: transaction.boissons,
      statut: transaction.statut,
      date: transaction.date_creation,
      dateExpiration: transaction.date_expiration,
      datePaiement: transaction.date_paiement
    };
    
    res.json({
      success: true,
      data: transactionFormatee
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
    
    const soldeResult = await client.query(
      'SELECT solde FROM soldes WHERE id = $1',
      ['utilisateur']
    );
    
    const soldeUtilisateur = parseFloat(soldeResult.rows[0].solde);
    
    if (soldeUtilisateur < transaction.montant) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Solde insuffisant'
      });
    }
    
    await client.query(
      'UPDATE transactions SET statut = $1, date_paiement = NOW() WHERE id = $2',
      ['paye', transaction.id]
    );
    
    await client.query(
      'UPDATE soldes SET solde = solde - $1, updated_at = NOW() WHERE id = $2',
      [transaction.montant, 'utilisateur']
    );
    
    await client.query(
      'UPDATE soldes SET solde = solde + $1, updated_at = NOW() WHERE id = $2',
      [transaction.montant, 'distributeur']
    );
    
    await client.query('COMMIT');
    
    console.log(`Paiement CTL réussi: ${transaction.id}`);
    
    const nouveauSoldeResult = await client.query(
      'SELECT solde FROM soldes WHERE id = $1',
      ['utilisateur']
    );
    
    const transactionMiseAJour = {
      id: transaction.id,
      montant: parseFloat(transaction.montant),
      boissons: transaction.boissons,
      statut: 'paye',
      date: transaction.date_creation,
      datePaiement: new Date().toISOString()
    };
    
    res.json({
      success: true,
      data: transactionMiseAJour,
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

app.post('/api/transaction/:id/annuler', async (req, res) => {
  try {
    const client = await pool.connect();
    
    const result = await client.query(
      'UPDATE transactions SET statut = $1 WHERE id = $2 RETURNING *',
      ['annule', req.params.id]
    );
    
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Transaction non trouvée'
      });
    }
    
    const transaction = result.rows[0];
    const transactionFormatee = {
      id: transaction.id,
      montant: parseFloat(transaction.montant),
      boissons: transaction.boissons,
      statut: transaction.statut,
      date: transaction.date_creation
    };
    
    res.json({
      success: true,
      data: transactionFormatee
    });
  } catch (error) {
    console.error('Erreur annulation:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

app.post('/api/solde/utilisateur/recharger', async (req, res) => {
  try {
    const { montant, operateur } = req.body;
    
    if (!montant || montant <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Montant invalide'
      });
    }
    
    const client = await pool.connect();
    
    const result = await client.query(
      'UPDATE soldes SET solde = solde + $1, updated_at = NOW() WHERE id = $2 RETURNING solde',
      [parseFloat(montant), 'utilisateur']
    );
    
    client.release();
    
    const nouveauSolde = parseFloat(result.rows[0].solde);
    
    console.log(`Rechargement ${operateur || 'Mobile Money'}: +${montant}FCFA, Nouveau solde: ${nouveauSolde}FCFA`);
    
    res.json({
      success: true,
      nouveauSolde: nouveauSolde,
      message: `Rechargement ${operateur ? operateur + ' ' : ''}réussi de ${montant}FCFA`
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
    const client = await pool.connect();
    
    const result = await client.query(
      'SELECT solde FROM soldes WHERE id = $1',
      ['distributeur']
    );
    
    client.release();
    
    const solde = parseFloat(result.rows[0].solde);
    
    res.json({
      success: true,
      solde: solde
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
    const client = await pool.connect();
    
    const result = await client.query(
      'SELECT solde FROM soldes WHERE id = $1',
      ['utilisateur']
    );
    
    client.release();
    
    const solde = parseFloat(result.rows[0].solde);
    
    res.json({
      success: true,
      solde: solde
    });
  } catch (error) {
    console.error('Erreur récupération solde utilisateur:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur interne du serveur'
    });
  }
});

// Maintenance serveur
setInterval(async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('🔄 Serveur CTL-Power maintenu actif');
  } catch (error) {
    console.error('❌ Erreur maintenance serveur:', error);
  }
}, 300000);

// Démarrage du serveur
async function demarrerServeur() {
  try {
    const bddInitialisee = await initialiserBDD();
    
    if (!bddInitialisee) {
      console.error('❌ Impossible d\'initialiser la base de données');
      process.exit(1);
    }
    
    estConnecteBDD = await testerConnexionBDD();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur CTL-Power démarré sur le port ${PORT}`);
      console.log(`📍 URL: http://0.0.0.0:${PORT}`);
      console.log(`✅ PostgreSQL: ${estConnecteBDD ? 'CONNECTÉ' : 'DÉCONNECTÉ'}`);
      console.log(`🔄 Mode: SERVEUR TOUJOURS ACTIF`);
    });
  } catch (error) {
    console.error('❌ Erreur démarrage serveur:', error);
    process.exit(1);
  }
}

demarrerServeur();
