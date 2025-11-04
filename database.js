const { Pool } = require('pg');

// Configuration de la connexion PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialisation de la base de données
async function initDatabase() {
  try {
    console.log('🔄 Initialisation de la base de données...');
    
    // Création de la table des transactions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        montant DECIMAL(10,2) NOT NULL,
        statut VARCHAR(20) NOT NULL DEFAULT 'en_attente',
        boissons JSONB NOT NULL,
        date_creation TIMESTAMPTZ DEFAULT NOW(),
        date_expiration TIMESTAMPTZ,
        date_paiement TIMESTAMPTZ
      )
    `);
    
    // Création de la table des soldes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soldes (
        id SERIAL PRIMARY KEY,
        type VARCHAR(20) UNIQUE NOT NULL,
        solde DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        date_maj TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    // Initialisation des soldes par défaut
    await pool.query(`
      INSERT INTO soldes (type, solde) 
      VALUES 
        ('distributeur', 0.00),
        ('utilisateur', 50.00)
      ON CONFLICT (type) DO NOTHING
    `);
    
    console.log('✅ Base de données initialisée avec succès');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error);
    throw error;
  }
}

// Fonctions pour les transactions
async function creerTransaction(transaction) {
  const { id, montant, boissons, dateExpiration } = transaction;
  
  const result = await pool.query(
    `INSERT INTO transactions (id, montant, boissons, date_expiration) 
     VALUES ($1, $2, $3, $4) 
     RETURNING *`,
    [id, montant, JSON.stringify(boissons), dateExpiration]
  );
  
  return result.rows[0];
}

async function getTransaction(id) {
  const result = await pool.query(
    'SELECT * FROM transactions WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function mettreAJourTransactionStatut(id, statut) {
  const result = await pool.query(
    `UPDATE transactions 
     SET statut = $1, date_paiement = CASE WHEN $1 = 'paye' THEN NOW() ELSE date_paiement END 
     WHERE id = $2 
     RETURNING *`,
    [statut, id]
  );
  return result.rows[0];
}

// Fonctions pour les soldes
async function getSolde(type) {
  const result = await pool.query(
    'SELECT solde FROM soldes WHERE type = $1',
    [type]
  );
  return result.rows[0]?.solde || 0;
}

async function mettreAJourSolde(type, nouveauSolde) {
  const result = await pool.query(
    'UPDATE soldes SET solde = $1, date_maj = NOW() WHERE type = $2 RETURNING *',
    [nouveauSolde, type]
  );
  return result.rows[0];
}

async function rechargerSoldeUtilisateur(montant) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Récupérer le solde actuel
    const result = await client.query(
      'SELECT solde FROM soldes WHERE type = $1 FOR UPDATE',
      ['utilisateur']
    );
    
    const soldeActuel = result.rows[0]?.solde || 0;
    const nouveauSolde = parseFloat(soldeActuel) + parseFloat(montant);
    
    // Mettre à jour le solde
    await client.query(
      'UPDATE soldes SET solde = $1, date_maj = NOW() WHERE type = $2',
      [nouveauSolde, 'utilisateur']
    );
    
    await client.query('COMMIT');
    
    return nouveauSolde;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Nettoyage des transactions expirées
async function nettoyerTransactionsExpirees() {
  try {
    const result = await pool.query(
      `UPDATE transactions 
       SET statut = 'expire' 
       WHERE statut = 'en_attente' AND date_expiration < NOW()`
    );
    
    if (result.rowCount > 0) {
      console.log(`🧹 ${result.rowCount} transactions expirées nettoyées`);
    }
  } catch (error) {
    console.error('Erreur nettoyage transactions:', error);
  }
}

module.exports = {
  pool,
  initDatabase,
  creerTransaction,
  getTransaction,
  mettreAJourTransactionStatut,
  getSolde,
  mettreAJourSolde,
  rechargerSoldeUtilisateur,
  nettoyerTransactionsExpirees
};
