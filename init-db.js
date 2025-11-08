const { Client } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL || 'postgresql://localhost/distributeur';

async function initDatabase() {
    const client = new Client({
        connectionString: connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        console.log('✅ Connexion à PostgreSQL établie');

        // Création des tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS soldes (
                id VARCHAR(50) PRIMARY KEY,
                solde DECIMAL(10,2) NOT NULL DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id VARCHAR(50) PRIMARY KEY,
                montant DECIMAL(10,2) NOT NULL,
                statut VARCHAR(20) NOT NULL,
                boissons JSONB NOT NULL,
                date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                date_expiration TIMESTAMP,
                date_paiement TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Insérer les soldes initiaux
        await client.query(`
            INSERT INTO soldes (id, solde) 
            VALUES 
            ('distributeur', 0.00),
            ('utilisateur', 50.00)
            ON CONFLICT (id) DO NOTHING;
        `);

        console.log('✅ Base de données initialisée avec succès');
        console.log('📊 Tables créées: soldes, transactions');
        console.log('💰 Soldes initiaux configurés');

    } catch (error) {
        console.error('❌ Erreur initialisation base de données:', error);
    } finally {
        await client.end();
    }
}

initDatabase();
