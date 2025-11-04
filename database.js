const { Pool } = require('pg');

// Création d'un pool de connexions pour de meilleures performances
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Fonction pour initialiser les tables de la base de données
async function initDatabase() {
  try {
    const client = await pool.connect();
    
    // Création de la table des transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(50) PRIMARY KEY,
        montant DECIMAL(10,2) NOT NULL,
        statut VARCHAR(20) NOT NULL DEFAULT 'en_attente',
        boissons JSONB NOT NULL,
        date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        date_expiration TIMESTAMP,
        date_paiement TIMESTAMP
      )
    `);
    
    // Création de la table des soldes
    await client.query(`
      CREATE TABLE IF NOT EXISTS soldes (
        type VARCHAR(50) PRIMARY KEY,
        solde DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        derniere_maj TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Initialisation des soldes s'ils n'existent pas
    await client.query(`
      INSERT INTO soldes (type, solde) 
      VALUES 
        ('distributeur', 0.00),
        ('utilisateur', 50.00)
      ON CONFLICT (type) DO NOTHING
    `);
    
    client.release();
    console.log('✅ Base de données initialisée avec succès');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error);
    throw error;
  }
}

module.exports = { pool, initDatabase };
