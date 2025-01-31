const express = require('express');
const http = require('http');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const socketIo = require('socket.io');

class Dashboard {
    constructor(config, bot) {
        this.config = config;
        this.bot = bot;
        this.walletAddress = config.wallet.address;
        this.walletPublicKey = new PublicKey(this.walletAddress);
        this.connection = bot.connection;
        this.lastMetrics = null;
        this.connectedClients = new Set();
        
        // Initialize Express server
        this.app = express();
        this.app.use(cors());
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server);
        
        this.setupSocketHandlers();
        this.startMetricsInterval();
    }

    setupSocketHandlers() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok' });
        });

        // Get current metrics
        this.app.get('/api/metrics', async (req, res) => {
            try {
                const metrics = await this.gatherMetrics();
                res.json(metrics);
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch metrics' });
            }
        });
    }

    startMetricsInterval() {
        setInterval(async () => {
            if (this.connectedClients.size > 0) {
                await this.updateMetrics();
            }
        }, this.config.dashboard.updateInterval || 30000);
    }

    async updateMetrics() {
        try {
            const metrics = await this.getBaseMetrics();
            console.log('Emitting metrics:', metrics); // Debug log
            this.io.emit('metrics', metrics);
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

    getWalletMetrics() {
        return {
            address: this.walletAddress ? 
                this.walletAddress.slice(0, 4) + '...' + this.walletAddress.slice(-4) : 
                'Not configured',
            balance: this.lastMetrics?.balance || { sol: 0, usd: 0 },
            lastUpdate: new Date().toISOString()
        };
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
        try {
            if (!this.walletAddress) {
                console.error('No wallet address configured');
                return {
                    balance: { sol: 0, usd: 0 },
                    connections: this.connectedClients.size,
                    uptime: process.uptime()
                };
            }

            console.log('Fetching balance for wallet:', this.walletAddress);
            const walletBalance = await this.connection.getBalance(this.walletPublicKey);
            const solPrice = await this.bot.walletTracker.getSolPrice();
            
            const metrics = {
                balance: {
                    sol: walletBalance / 1e9,
                    usd: (walletBalance / 1e9) * solPrice
                },
                connections: this.connectedClients.size,
                uptime: process.uptime()
            };
            
            this.lastMetrics = metrics;
            console.log('Dashboard metrics:', metrics);
            return metrics;
        } catch (error) {
            console.error('Error getting base metrics:', error);
            throw error;
        }
    }
}

module.exports = Dashboard;