const { Client } = require('pg');

class Database {
    constructor() {
        this.connectionString = process.env.DATABASE_URL;
        this.client = null;
    }

    async connect() {
        try {
            this.client = new Client({
                connectionString: this.connectionString,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                connectionTimeoutMillis: 5000,
                idle_in_transaction_session_timeout: 30000
            });

            await this.client.connect();
            console.log('✅ Connecté à PostgreSQL');
            return true;
        } catch (error) {
            console.error('❌ Erreur connexion PostgreSQL:', error.message);
            return false;
        }
    }

    async ensureConnection() {
        try {
            if (!this.client || this.client._ending) {
                await this.connect();
            }
            // Test la connexion
            await this.client.query('SELECT 1');
            return true;
        } catch (error) {
            console.log('🔄 Reconnexion à PostgreSQL...');
            return await this.connect();
        }
    }

    async getSolde(id) {
        await this.ensureConnection();
        try {
            const result = await this.client.query(
                'SELECT solde FROM soldes WHERE id = $1',
                [id]
            );
            return result.rows[0] ? parseFloat(result.rows[0].solde) : 0;
        } catch (error) {
            console.error('Erreur getSolde:', error);
            return 0;
        }
    }

    async updateSolde(id, nouveauSolde) {
        await this.ensureConnection();
        try {
            await this.client.query(
                'UPDATE soldes SET solde = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [nouveauSolde, id]
            );
            return true;
        } catch (error) {
            console.error('Erreur updateSolde:', error);
            return false;
        }
    }

    async createTransaction(transaction) {
        await this.ensureConnection();
        try {
            await this.client.query(
                `INSERT INTO transactions (id, montant, statut, boissons, date_expiration)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    transaction.id,
                    transaction.montant,
                    transaction.statut,
                    JSON.stringify(transaction.boissons),
                    transaction.dateExpiration
                ]
            );
            return true;
        } catch (error) {
            console.error('Erreur createTransaction:', error);
            return false;
        }
    }

    async getTransaction(id) {
        await this.ensureConnection();
        try {
            const result = await this.client.query(
                'SELECT * FROM transactions WHERE id = $1',
                [id]
            );
            
            if (result.rows.length === 0) return null;

            const row = result.rows[0];
            return {
                id: row.id,
                montant: parseFloat(row.montant),
                statut: row.statut,
                boissons: row.boissons,
                date: row.date_creation.toISOString(),
                dateExpiration: row.date_expiration ? row.date_expiration.toISOString() : null,
                datePaiement: row.date_paiement ? row.date_paiement.toISOString() : null
            };
        } catch (error) {
            console.error('Erreur getTransaction:', error);
            return null;
        }
    }

    async updateTransactionStatut(id, statut) {
        await this.ensureConnection();
        try {
            const query = statut === 'paye' 
                ? 'UPDATE transactions SET statut = $1, date_paiement = CURRENT_TIMESTAMP WHERE id = $2'
                : 'UPDATE transactions SET statut = $1 WHERE id = $2';
            
            await this.client.query(query, [statut, id]);
            return true;
        } catch (error) {
            console.error('Erreur updateTransactionStatut:', error);
            return false;
        }
    }

    async cleanupExpiredTransactions() {
        await this.ensureConnection();
        try {
            const result = await this.client.query(
                `DELETE FROM transactions 
                 WHERE statut = 'en_attente' 
                 AND date_expiration < CURRENT_TIMESTAMP`
            );
            
            if (result.rowCount > 0) {
                console.log(`🗑️ ${result.rowCount} transactions expirées nettoyées`);
            }
            return result.rowCount;
        } catch (error) {
            console.error('Erreur cleanupExpiredTransactions:', error);
            return 0;
        }
    }

    async getServerStats() {
        await this.ensureConnection();
        try {
            const transactionsResult = await this.client.query(`
                SELECT 
                    COUNT(*) as total_transactions,
                    COUNT(CASE WHEN statut = 'paye' THEN 1 END) as transactions_payees,
                    COUNT(CASE WHEN statut = 'en_attente' THEN 1 END) as transactions_en_attente
                FROM transactions
            `);

            const soldesResult = await this.client.query(`
                SELECT id, solde FROM soldes
            `);

            return {
                transactions: transactionsResult.rows[0],
                soldes: soldesResult.rows.reduce((acc, row) => {
                    acc[row.id] = parseFloat(row.solde);
                    return acc;
                }, {})
            };
        } catch (error) {
            console.error('Erreur getServerStats:', error);
            return null;
        }
    }
}

module.exports = new Database();
