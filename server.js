const express = require('express');
const cors = require('cors');
const database = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware - TOUJOURS ACTIF
app.use(cors({
    origin: '*',
    credentials: true
}));
app.use(express.json());

// Initialisation de la base de données au démarrage
async function initializeServer() {
    console.log('🚀 Initialisation du serveur...');
    
    const dbConnected = await database.connect();
    if (!dbConnected) {
        console.error('❌ Impossible de se connecter à la base de données');
        process.exit(1);
    }

    // Nettoyer les transactions expirées au démarrage
    await database.cleanupExpiredTransactions();

    // Démarrer le serveur
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🎉 Serveur backend démarré sur le port ${PORT}`);
        console.log(`📍 URL: http://0.0.0.0:${PORT}`);
        console.log(`🗄️  Base de données: PostgreSQL connectée`);
        console.log(`⚡ Statut: TOUJOURS ACTIF - Pas de mise en veille`);
    });

    // Nettoyage périodique des transactions expirées
    setInterval(() => {
        database.cleanupExpiredTransactions();
    }, 60 * 60 * 1000); // Toutes les heures

    // Garder la connexion active
    setInterval(() => {
        database.ensureConnection();
    }, 30000); // Toutes les 30 secondes
}

// Routes API - TOUJOURS ACCESSIBLES
app.get('/api/health', async (req, res) => {
    const dbStatus = await database.ensureConnection();
    res.json({ 
        status: 'OK', 
        message: 'API Distributeur fonctionnelle',
        database: dbStatus ? 'CONNECTÉE' : 'ERREUR',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.get('/api/stats', async (req, res) => {
    try {
        const stats = await database.getServerStats();
        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur récupération statistiques'
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

        // Générer ID court
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let transactionId = 'TX';
        for (let i = 0; i < 6; i++) {
            transactionId += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        const transaction = {
            id: transactionId,
            montant: parseFloat(montant),
            boissons,
            statut: 'en_attente',
            dateExpiration: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        };
        
        // Sauvegarder dans PostgreSQL
        const saved = await database.createTransaction(transaction);
        
        if (!saved) {
            throw new Error('Erreur sauvegarde transaction');
        }
        
        console.log(`💳 Nouvelle transaction: ${transactionId}, Montant: ${montant}€`);
        
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
        const transaction = await database.getTransaction(req.params.id);
        
        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: 'Transaction non trouvée'
            });
        }
        
        // Vérifier l'expiration
        if (new Date() > new Date(transaction.dateExpiration)) {
            transaction.statut = 'expire';
            await database.updateTransactionStatut(transaction.id, 'expire');
        }
        
        res.json({
            success: true,
            data: transaction
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
    try {
        const transaction = await database.getTransaction(req.params.id);
        
        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: 'Transaction non trouvée'
            });
        }
        
        if (transaction.statut !== 'en_attente') {
            return res.status(400).json({
                success: false,
                error: `Transaction déjà ${transaction.statut}`
            });
        }
        
        // Vérifier le solde utilisateur
        const soldeUtilisateur = await database.getSolde('utilisateur');
        if (soldeUtilisateur < transaction.montant) {
            return res.status(400).json({
                success: false,
                error: 'Solde insuffisant'
            });
        }
        
        // Effectuer le paiement
        const nouveauSoldeUtilisateur = soldeUtilisateur - transaction.montant;
        const nouveauSoldeDistributeur = await database.getSolde('distributeur') + transaction.montant;
        
        // Mettre à jour les soldes
        await database.updateSolde('utilisateur', nouveauSoldeUtilisateur);
        await database.updateSolde('distributeur', nouveauSoldeDistributeur);
        
        // Mettre à jour la transaction
        await database.updateTransactionStatut(transaction.id, 'paye');
        
        console.log(`✅ Paiement réussi: ${transaction.id}`);
        
        res.json({
            success: true,
            data: { ...transaction, statut: 'paye' },
            nouveauSoldeUtilisateur: nouveauSoldeUtilisateur
        });
    } catch (error) {
        console.error('Erreur paiement:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur'
        });
    }
});

app.post('/api/transaction/:id/annuler', async (req, res) => {
    try {
        const transaction = await database.getTransaction(req.params.id);
        
        if (transaction) {
            await database.updateTransactionStatut(transaction.id, 'annule');
            res.json({
                success: true,
                data: { ...transaction, statut: 'annule' }
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

app.post('/api/solde/utilisateur/recharger', async (req, res) => {
    try {
        const { montant } = req.body;
        
        if (!montant || montant <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Montant invalide'
            });
        }
        
        const soldeActuel = await database.getSolde('utilisateur');
        const nouveauSolde = soldeActuel + parseFloat(montant);
        
        await database.updateSolde('utilisateur', nouveauSolde);
        
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
        const solde = await database.getSolde('distributeur');
        res.json({
            success: true,
            solde: solde
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur récupération solde'
        });
    }
});

app.get('/api/solde/utilisateur', async (req, res) => {
    try {
        const solde = await database.getSolde('utilisateur');
        res.json({
            success: true,
            solde: solde
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur récupération solde'
        });
    }
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
    console.error('🚨 Exception non capturée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Rejet non géré:', reason);
});

// Démarrer le serveur
initializeServer().catch(console.error);
