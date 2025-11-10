const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  max: 20,
});

async function testerConnexionBDD() {
  try {
    const client = await pool.connect();
    console.log('✅ Connexion PostgreSQL établie');
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Erreur connexion PostgreSQL:', error);
    return false;
  }
}

async function initialiserBDD() {
  try {
    const client = await pool.connect();
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(20) PRIMARY KEY,
        montant DECIMAL(10,2) NOT NULL,
        boissons JSONB NOT NULL,
        statut VARCHAR(20) NOT NULL,
        date_creation TIMESTAMP DEFAULT NOW(),
        date_expiration TIMESTAMP,
        date_paiement TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS soldes (
        id VARCHAR(20) PRIMARY KEY,
        solde DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      INSERT INTO soldes (id, solde) 
      VALUES 
        ('distributeur', 0.00),
        ('utilisateur', 5000.00)
      ON CONFLICT (id) DO NOTHING
    `);
    
    client.release();
    console.log('✅ Base de données initialisée avec succès');
    return true;
  } catch (error) {
    console.error('❌ Erreur initialisation BDD:', error);
    return false;
  }
}

// Maintenance de la connexion
setInterval(async () => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (error) {
    console.error('❌ Erreur maintenance connexion:', error);
  }
}, 300000);

module.exports = {
  pool,
  testerConnexionBDD,
  initialiserBDD
};
