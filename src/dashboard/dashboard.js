const express = require('express');
const http = require('http');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const socketIo = require('socket.io');
const AnalyticsView = require('./analytics-view');

class Dashboard {
    constructor(config, bot) {
        this.config = config;
        this.bot = bot;
        
        // Use bot's wallet address if config doesn't provide one
        const walletAddress = config.wallet?.address || bot.config.wallet.address;
        
        if (!walletAddress) {
            throw new Error('No wallet address provided in configuration');
        }
        
        try {
            this.walletAddress = new PublicKey(walletAddress);
        } catch (error) {
            throw new Error(`Invalid wallet address: ${walletAddress}`);
        }
        
        this.connectedClients = new Set();
        this.lastRequestTime = 0;
        this.requestQueue = [];
        this.retryDelay = 500;
        this.maxRetryDelay = 8000;
        
        // Create a new connection with proper version support
        this.connection = new Connection(bot.connection.rpcEndpoint, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
        });
        
        // Initialize Express server
        const app = express();
        app.use(express.static(__dirname + '/public'));
        app.use(cors());
        
        this.server = http.createServer(app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.initializeRoutes(app);
        this.initializeSocketEvents();
        this.server.listen(config.dashboard.port);
        
        console.log(`Dashboard server started on port ${config.dashboard.port}`);
        this.startMetricsLoop();

        this.analyticsView = new AnalyticsView(this);
        this.metricsBuffer = new Map();
        this.METRICS_BUFFER_SIZE = 100;
    }

    initializeRoutes(app) {
        // Health check endpoint
        app.get('/health', (req, res) => {
            res.json({ status: 'ok' });
        });

        // Get current metrics
        app.get('/api/metrics', async (req, res) => {
            try {
                const metrics = await this.gatherMetrics();
                res.json(metrics);
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch metrics' });
            }
        });
    }

    initializeSocketEvents() {
        this.io.on('connection', (socket) => {
            const clientId = socket.id;
            this.connectedClients.add(clientId);
            console.log(`Client connected (${clientId}). Total clients: ${this.connectedClients.size}`);
            
            // Send initial metrics
            this.updateMetrics();
            
            socket.on('disconnect', () => {
                this.connectedClients.delete(clientId);
                console.log(`Client disconnected (${clientId}). Total clients: ${this.connectedClients.size}`);
            });

            socket.on('error', (error) => {
                console.error(`Socket error for client ${clientId}:`, error);
            });
        });
    }

    startMetricsLoop() {
        setInterval(async () => {
            if (this.connectedClients.size > 0) {
                await this.updateMetrics();
            }
        }, this.config.dashboard.updateInterval || 30000);
    }

    async updateMetrics() {
        try {
            const metrics = await this.gatherMetrics();
            this.io.emit('metrics-update', metrics);
        } catch (error) {
            console.error('Error updating metrics:', error);
        }
    }

    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        const minDelay = 1000; // Increase minimum delay to 1 second
        
        if (timeSinceLastRequest < minDelay) {
            await new Promise(resolve => 
                setTimeout(resolve, minDelay - timeSinceLastRequest)
            );
        }
        
        // Add jitter to prevent thundering herd
        await new Promise(resolve => 
            setTimeout(resolve, Math.random() * 500)
        );
        
        this.lastRequestTime = Date.now();
    }

    async gatherMetrics() {
        const baseMetrics = await this.getBaseMetrics();
        const mlMetrics = this.getMLMetrics();
        const analyticsMetrics = this.getAnalyticsMetrics();

        return {
            ...baseMetrics,
            ml: mlMetrics,
            analytics: analyticsMetrics,
            timestamp: Date.now()
        };
    }

    getMLMetrics() {
        return {
            endpointPredictions: Array.from(this.bot.endpointMetrics.entries()).map(([endpoint, metrics]) => ({
                endpoint: endpoint.slice(0, 15) + '...',
                successRate: (metrics.successCount / (metrics.successCount + metrics.failureCount)) * 100,
                predictedReliability: 1 - (metrics.failureProbability || 0),
                averageLatency: metrics.averageLatency,
                predictionAccuracy: this.calculatePredictionAccuracy(endpoint)
            }))
        };
    }

    getAnalyticsMetrics() {
        const walletMetrics = Array.from(this.bot.walletActivityMetrics.entries())
            .map(([wallet, metrics]) => ({
                wallet: wallet.slice(0, 4) + '...' + wallet.slice(-4),
                score: metrics.score,
                activityCount: metrics.activities.length,
                lastActive: metrics.lastActive
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 10); // Top 10 active wallets

        return {
            wallets: walletMetrics,
            patterns: this.getWalletPatterns()
        };
    }

    calculatePredictionAccuracy(endpoint) {
        const predictions = this.bot.endpointPredictor.trainingData
            .filter(data => data.endpoint === endpoint)
            .slice(-50); // Last 50 predictions

        if (predictions.length === 0) return 0;

        const accuracy = predictions.reduce((acc, pred) => {
            const error = Math.abs(pred.output.expectedLatency - pred.input.averageLatency);
            return acc + (1 - (error / pred.input.averageLatency));
        }, 0);

        return (accuracy / predictions.length) * 100;
    }

    getWalletPatterns() {
        return Array.from(this.bot.walletBehaviorAnalyzer.walletPatterns.entries())
            .map(([wallet, pattern]) => ({
                wallet: wallet.slice(0, 4) + '...' + wallet.slice(-4),
                purchaseCount: pattern.purchases.length,
                successRate: pattern.successRate,
                correlatedWallets: this.bot.walletBehaviorAnalyzer.findRelatedWallets(wallet).length
            }))
            .filter(p => p.purchaseCount > 0)
            .sort((a, b) => b.purchaseCount - a.purchaseCount)
            .slice(0, 5); // Top 5 patterns
    }

    async retryWithBackoff(fn) {
        while (true) {
            try {
                return await fn();
            } catch (error) {
                if (error.message.includes('429')) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                    this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
                    console.log(`Retrying after ${this.retryDelay}ms delay...`);
                } else {
                    throw error;
                }
            }
        }
    }

    async getBaseMetrics() {
        const walletBalance = await this.connection.getBalance(this.walletAddress);
        
        return {
            balance: {
                sol: walletBalance / 1e9,
                usd: (walletBalance / 1e9) * (await this.bot.walletTracker.getSolPrice())
            },
            connections: this.connectedClients.size,
            uptime: process.uptime()
        };
    }
}

module.exports = Dashboard;