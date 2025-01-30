const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const Dashboard = require('./dashboard/dashboard');
const EmergencyHandler = require('./handlers/emergency-handler');
const TelegramHandler = require('./handlers/telegram-handler');
const WalletTracker = require('./wallet-tracker');
const WalletBehaviorAnalyzer = require('./analysis/wallet-behavior-analyzer');
const EndpointPredictor = require('./ml/EndpointPredictor');

class TokenMonitor {
    constructor(config) {
        this.config = config;
        this.currentRpcIndex = 0;
        this.connection = this.createConnection();
        
        // Initialize components with 'this' as the bot reference
        this.walletTracker = new WalletTracker(this.connection, config.monitoring, this);
        this.telegramHandler = new TelegramHandler(
            new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true }),
            process.env.TELEGRAM_CHAT_ID,
            process.env.WALLET_ADDRESS,
            this.walletTracker
        );
        
        this.dashboard = this.initializeDashboard();
        this.initializeErrorHandler();
        
        // Send welcome message
        if (process.env.TELEGRAM_CHAT_ID) {
            this.telegramHandler.sendWelcomeMessage();
        }

        this.failureCount = new Map();
        this.FAILURE_THRESHOLD = 3;
        this.RESET_INTERVAL = 180000;

        this.endpointMetrics = new Map();
        this.initializeEndpointMetrics();

        this.requestQueue = [];
        this.priorityQueue = [];
        this.isProcessingQueue = false;
        this.queueProcessInterval = setInterval(() => this.processQueue(), 100);

        this.endpointCooldowns = new Map();
        this.COOLDOWN_DURATION = 60000; // 1 minute cooldown

        this.alertThresholds = {
            rateLimitHits: 3,
            failureRate: 0.15,
            latencyMs: 800,
            consecutiveFailures: 2
        };

        this.adaptiveThresholds = {
            baselineWindow: 3600000, // 1 hour
            adjustmentFactor: 0.1,   // 10% adjustment
            minThresholds: {
                rateLimitHits: 2,
                failureRate: 0.1,
                latencyMs: 500,
                consecutiveFailures: 2
            }
        };

        this.walletBehaviorAnalyzer = new WalletBehaviorAnalyzer();
        this.walletActivityMetrics = new Map();
        this.ACTIVITY_WEIGHTS = {
            transaction: 1.0,
            memecoinPurchase: 2.0,
            highValueTrade: 1.5,
            relatedPurchase: 2.5
        };

        this.endpointPredictor = new EndpointPredictor();
        
        // Train model periodically
        setInterval(() => this.trainPredictionModel(), 3600000); // Every hour
        setInterval(() => this.adjustThresholds(), 300000); // Every 5 minutes
        setInterval(() => this.walletBehaviorAnalyzer.processPatterns(), 600000); // Every 10 minutes
    }

    validateEndpoint(endpoint) {
        if (!endpoint) {
            console.warn('Empty RPC endpoint found and will be ignored');
            return false;
        }
        try {
            const url = new URL(endpoint);
            if (!url.protocol.startsWith('http')) {
                throw new Error(`Invalid protocol for endpoint: ${endpoint}`);
            }
            if (url.hostname.includes('helius-rpc.com')) {
                return url.pathname.includes('/v0/') || url.searchParams.has('api-key');
            }
            if (url.hostname.includes('quiknode.pro')) {
                return url.pathname.length > 1;
            }
            console.warn(`Unknown RPC provider: ${url.hostname}`);
            return false;
        } catch (error) {
            console.error(`Invalid RPC endpoint URL: ${endpoint}`);
            return false;
        }
    }

    createConnection() {
        const endpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        
        if (!endpoint || !this.validateEndpoint(endpoint)) {
            throw new Error('No valid RPC endpoint provided');
        }
        
        return new Connection(endpoint, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 60000,
            maxSupportedTransactionVersion: 0
        });
    }

    async rotateEndpoint() {
        const previousEndpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        let attempts = 0;
        const maxAttempts = this.config.rpc.endpoints.length;

        while (attempts < maxAttempts) {
            this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpc.endpoints.length;
            const newEndpoint = this.config.rpc.endpoints[this.currentRpcIndex];
            
            if (this.isEndpointHealthy(newEndpoint) && !this.isEndpointCooling(newEndpoint)) {
                this.connection = this.createConnection();
                console.log(`Switched from ${previousEndpoint} to ${newEndpoint}`);
                
                // Update connection in components
                if (this.walletTracker) {
                    this.walletTracker.connection = this.connection;
                }
                return true;
            }
            attempts++;
        }
        
        console.error('No healthy endpoints available for rotation');
        return false;
    }

    isEndpointCooling(endpoint) {
        const cooldownUntil = this.endpointCooldowns.get(endpoint);
        return cooldownUntil && Date.now() < cooldownUntil;
    }

    setCooldown(endpoint) {
        this.endpointCooldowns.set(endpoint, Date.now() + this.COOLDOWN_DURATION);
        console.log(`Endpoint ${endpoint} cooling down for ${this.COOLDOWN_DURATION/1000}s`);
    }

    async handleRpcError(error) {
        const currentEndpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        
        if (error.message.includes('429') || error.message.includes('Too many requests')) {
            this.setCooldown(currentEndpoint);
            this.rotateEndpoint();
            
            // Add immediate retry with new endpoint
            await new Promise(resolve => setTimeout(resolve, 1000));
            return true;
        }
        
        // Add general error handling
        if (error.message.includes('timeout') || error.message.includes('network error')) {
            this.recordFailure(currentEndpoint);
            this.rotateEndpoint();
            await new Promise(resolve => setTimeout(resolve, 2000));
            return true;
        }
        
        return false;
    }

    initializeDashboard() {
        this.dashboard = new Dashboard({
            dashboard: {
                port: process.env.DASHBOARD_PORT || 3000
            },
            wallet: {
                address: process.env.WALLET_ADDRESS
            }
        }, this);
        console.log('Dashboard initialized on port 3000');
        return this.dashboard;
    }

    initializeErrorHandler() {
        this.errorHandler = new EmergencyHandler(this.config.alerts);
    }

    async startMonitoring() {
        setInterval(async () => {
            try {
                const alerts = await this.walletTracker.trackWalletTransactions();
                if (alerts) {
                    await this.telegramHandler.sendWalletAlert(alerts);
                    this.dashboard.updateMetrics();
                }
            } catch (error) {
                this.errorHandler.handleError(error, 'monitoring');
            }
        }, this.config.monitoring.walletTrackingInterval);
    }

    isCircuitOpen(endpoint) {
        const failures = this.failureCount.get(endpoint) || 0;
        return failures >= this.FAILURE_THRESHOLD;
    }

    recordFailure(endpoint) {
        const currentCount = this.failureCount.get(endpoint) || 0;
        this.failureCount.set(endpoint, currentCount + 1);
        
        // Schedule reset
        setTimeout(() => {
            this.failureCount.set(endpoint, 0);
        }, this.RESET_INTERVAL);
    }

    resetFailures(endpoint) {
        this.failureCount.set(endpoint, 0);
    }

    async executeFallbackStrategy(operation) {
        // Try public backup nodes if all main endpoints fail
        const backupEndpoints = [
            'https://api.mainnet-beta.solana.com',
            'https://solana-api.projectserum.com'
        ];

        for (const endpoint of backupEndpoints) {
            try {
                const tempConnection = new Connection(endpoint);
                const result = await operation(tempConnection);
                console.log(`Fallback successful using ${endpoint}`);
                return result;
            } catch (error) {
                console.error(`Fallback failed for ${endpoint}:`, error.message);
            }
        }
        throw new Error('All fallback attempts failed');
    }

    async executeWithCircuitBreaker(operation, attemptCount = 0) {
        const MAX_ATTEMPTS = this.config.rpc.endpoints.length * 2; // Allow more retries
        const BACKOFF_TIME = Math.min(1000 * Math.pow(2, attemptCount), 32000);
        
        if (attemptCount >= MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, 30000)); // Cool down period
            return this.executeFallbackStrategy(operation);
        }

        const endpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        
        if (this.isCircuitOpen(endpoint)) {
            this.rotateEndpoint();
            await new Promise(resolve => setTimeout(resolve, BACKOFF_TIME));
            return this.executeWithCircuitBreaker(operation, attemptCount + 1);
        }

        try {
            const result = await operation(this.connection);
            this.resetFailures(endpoint);
            return result;
        } catch (error) {
            this.recordFailure(endpoint);
            if (error.message.includes('429')) {
                await new Promise(resolve => setTimeout(resolve, BACKOFF_TIME));
                this.rotateEndpoint();
                return this.executeWithCircuitBreaker(operation, attemptCount + 1);
            }
            throw error;
        }
    }

    initializeEndpointMetrics() {
        this.config.rpc.endpoints.forEach(endpoint => {
            this.endpointMetrics.set(endpoint, {
                successCount: 0,
                failureCount: 0,
                rateLimitHits: 0,
                averageLatency: 0,
                lastHealthCheck: Date.now(),
                isHealthy: true,
                consecutiveFailures: 0,
                requestsPerMinute: 0,
                lastMinuteRequests: [],
                errorTypes: new Map(),
                performance: {
                    last1m: [],
                    last5m: [],
                    last15m: []
                }
            });
        });
        
        // Update metrics every minute
        setInterval(() => this.updateEndpointMetrics(), 60000);
    }

    async updateEndpointMetrics() {
        const now = Date.now();
        
        this.endpointMetrics.forEach((metrics, endpoint) => {
            // Calculate requests per minute
            metrics.lastMinuteRequests = metrics.lastMinuteRequests.filter(
                time => now - time < 60000
            );
            metrics.requestsPerMinute = metrics.lastMinuteRequests.length;

            // Update moving averages
            metrics.performance.last1m.push(metrics.averageLatency);
            metrics.performance.last5m.push(metrics.averageLatency);
            metrics.performance.last15m.push(metrics.averageLatency);

            // Keep only needed history
            metrics.performance.last1m = metrics.performance.last1m.slice(-60);
            metrics.performance.last5m = metrics.performance.last5m.slice(-300);
            metrics.performance.last15m = metrics.performance.last15m.slice(-900);

            console.log(`Endpoint ${endpoint} metrics:`, {
                successRate: (metrics.successCount / (metrics.successCount + metrics.failureCount)) * 100,
                avgLatency: metrics.averageLatency,
                requestsPerMinute: metrics.requestsPerMinute,
                rateLimitHits: metrics.rateLimitHits,
                errorTypes: Object.fromEntries(metrics.errorTypes)
            });
        });
    }

    async trackEndpointMetrics(endpoint, startTime, success) {
        const metrics = this.endpointMetrics.get(endpoint);
        const latency = Date.now() - startTime;
        
        if (success) {
            metrics.successCount++;
            metrics.averageLatency = (metrics.averageLatency + latency) / 2;
        } else {
            metrics.failureCount++;
        }
        
        metrics.lastUsed = Date.now();
        
        // Log metrics every 100 requests
        if ((metrics.successCount + metrics.failureCount) % 100 === 0) {
            console.log(`Endpoint ${endpoint} metrics:`, metrics);
        }
    }

    async queueRequest(request, priority = false) {
        const requestItem = {
            operation: request,
            timestamp: Date.now(),
            priority
        };
        
        if (priority) {
            this.priorityQueue.push(requestItem);
        } else {
            this.requestQueue.push(requestItem);
        }

        if (!this.isProcessingQueue) {
            await this.processQueue();
        }
    }

    calculateAdaptiveRateLimit(endpoint) {
        const metrics = this.endpointMetrics.get(endpoint);
        if (!metrics) return this.config.rpc.intervalMs;

        const baseInterval = this.config.rpc.intervalMs;
        const successRate = metrics.successCount / (metrics.successCount + metrics.failureCount);
        const recentRateLimit = metrics.rateLimitHits > 0 && 
            (Date.now() - metrics.lastRateLimitHit < 60000);

        if (recentRateLimit) {
            return baseInterval * 2;
        }

        if (successRate < 0.8) {
            return baseInterval * 1.5;
        }

        return baseInterval;
    }

    async processQueue() {
        if (this.isProcessingQueue) return;
        
        this.isProcessingQueue = true;
        const BATCH_SIZE = 3; // Process 3 requests at a time
        const BATCH_INTERVAL = 5000; // 5 second interval between batches
        
        try {
            while (this.priorityQueue.length || this.requestQueue.length) {
                const batch = [];
                
                // Get batch of requests
                while (batch.length < BATCH_SIZE && (this.priorityQueue.length || this.requestQueue.length)) {
                    const request = this.priorityQueue.shift() || this.requestQueue.shift();
                    batch.push(request);
                }
                
                // Process batch concurrently
                await Promise.all(batch.map(request => 
                    this.executeWithCircuitBreaker(request.operation)
                ));
                
                // Wait between batches
                await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    async isEndpointHealthy(endpoint) {
        const metrics = this.endpointMetrics.get(endpoint);
        if (!metrics) return false;

        const healthCriteria = {
            isNotCooling: !this.isEndpointCooling(endpoint),
            hasLowFailures: metrics.consecutiveFailures < this.config.rpc.healthCheck.failureThreshold,
            hasGoodLatency: metrics.averageLatency < this.alertThresholds.latencyMs,
            hasLowRateLimits: metrics.rateLimitHits < this.alertThresholds.rateLimitHits
        };

        const isHealthy = Object.values(healthCriteria).every(Boolean);
        
        if (!isHealthy) {
            console.warn(`Endpoint ${endpoint} health check failed:`, 
                Object.entries(healthCriteria)
                    .filter(([_, value]) => !value)
                    .map(([key]) => key)
                    .join(', ')
            );
        }

        return isHealthy;
    }

    selectBestEndpoint() {
        const endpoints = this.config.rpc.endpoints;
        const metrics = Array.from(this.endpointMetrics.entries())
            .map(([endpoint, metrics]) => ({
                endpoint,
                score: this.calculateEndpointScore(metrics)
            }))
            .sort((a, b) => b.score - a.score);

        const bestEndpoint = metrics[0].endpoint;
        if (bestEndpoint !== this.config.rpc.endpoints[this.currentRpcIndex]) {
            this.currentRpcIndex = endpoints.indexOf(bestEndpoint);
            this.rotateEndpoint();
        }
    }

    calculateEndpointScore(metrics) {
        const successRate = metrics.successCount / (metrics.successCount + metrics.failureCount);
        const latencyScore = 1 - (metrics.averageLatency / 1000); // Normalize to 0-1
        const rateLimitScore = 1 - (metrics.rateLimitHits / 100);
        
        return (successRate * 0.4) + (latencyScore * 0.3) + (rateLimitScore * 0.3);
    }

    prepareMetricsForDashboard() {
        const metricsData = {};
        
        this.endpointMetrics.forEach((metrics, endpoint) => {
            metricsData[endpoint] = {
                performance: {
                    latency: {
                        current: metrics.averageLatency,
                        history: metrics.performance.last5m
                    },
                    success: {
                        rate: (metrics.successCount / (metrics.successCount + metrics.failureCount)) * 100,
                        total: metrics.successCount + metrics.failureCount
                    },
                    rateLimits: {
                        count: metrics.rateLimitHits,
                        lastHit: metrics.lastRateLimitHit
                    },
                    load: {
                        requestsPerMinute: metrics.requestsPerMinute,
                        history: metrics.lastMinuteRequests.length
                    }
                },
                health: {
                    status: this.isEndpointHealthy(endpoint),
                    cooling: this.isEndpointCooling(endpoint),
                    failureCount: metrics.consecutiveFailures
                }
            };
        });

        return metricsData;
    }

    async executeWithFailover(operation, priority = false) {
        const healthyEndpoints = this.config.rpc.endpoints.filter(endpoint => {
            const metrics = this.endpointMetrics.get(endpoint);
            return metrics.isHealthy && !this.isEndpointCooling(endpoint);
        });

        if (healthyEndpoints.length === 0) {
            return this.executeFallbackStrategy(operation);
        }

        // Sort endpoints by health score
        const sortedEndpoints = healthyEndpoints.sort((a, b) => {
            const scoreA = this.calculateEndpointScore(this.endpointMetrics.get(a));
            const scoreB = this.calculateEndpointScore(this.endpointMetrics.get(b));
            return scoreB - scoreA;
        });

        for (const endpoint of sortedEndpoints) {
            try {
                const tempConnection = new Connection(endpoint);
                return await operation(tempConnection);
            } catch (error) {
                this.recordFailure(endpoint);
                continue;
            }
        }

        throw new Error('All healthy endpoints failed');
    }

    async checkMetricAlerts() {
        this.endpointMetrics.forEach((metrics, endpoint) => {
            const alerts = [];
            
            if (metrics.rateLimitHits >= this.alertThresholds.rateLimitHits) {
                alerts.push(`High rate limiting on ${endpoint}`);
            }

            const failureRate = metrics.failureCount / (metrics.successCount + metrics.failureCount);
            if (failureRate >= this.alertThresholds.failureRate) {
                alerts.push(`High failure rate (${(failureRate * 100).toFixed(1)}%) on ${endpoint}`);
            }

            if (metrics.averageLatency >= this.alertThresholds.latencyMs) {
                alerts.push(`High latency (${metrics.averageLatency.toFixed(0)}ms) on ${endpoint}`);
            }

            if (alerts.length > 0) {
                this.errorHandler.handleError({
                    message: alerts.join('\n'),
                    type: 'endpoint-health'
                }, 'metrics');
            }
        });
    }

    async adjustThresholds() {
        const metrics = Array.from(this.endpointMetrics.values());
        const averageLatency = metrics.reduce((sum, m) => sum + m.averageLatency, 0) / metrics.length;
        const maxRateLimits = Math.max(...metrics.map(m => m.rateLimitHits));

        // Adjust thresholds based on recent performance
        this.alertThresholds.latencyMs = Math.max(
            this.adaptiveThresholds.minThresholds.latencyMs,
            averageLatency * (1 + this.adaptiveThresholds.adjustmentFactor)
        );

        this.alertThresholds.rateLimitHits = Math.max(
            this.adaptiveThresholds.minThresholds.rateLimitHits,
            maxRateLimits * (1 + this.adaptiveThresholds.adjustmentFactor)
        );

        console.log('Updated alert thresholds:', this.alertThresholds);
    }

    updateWalletActivity(wallet, activityType, value = 1) {
        if (!this.walletActivityMetrics.has(wallet)) {
            this.walletActivityMetrics.set(wallet, {
                score: 0,
                activities: [],
                lastActive: 0,
                purchasePatterns: new Map()
            });
        }

        const metrics = this.walletActivityMetrics.get(wallet);
        const weight = this.ACTIVITY_WEIGHTS[activityType] || 1.0;
        
        metrics.score = metrics.score * 0.95 + (value * weight); // Decay old score by 5%
        metrics.activities.unshift({ type: activityType, timestamp: Date.now() });
        metrics.activities = metrics.activities.slice(0, 100); // Keep last 100 activities
        metrics.lastActive = Date.now();

        // Update purchase patterns for memecoin purchases
        if (activityType === 'memecoinPurchase') {
            const hour = Math.floor(Date.now() / 3600000);
            metrics.purchasePatterns.set(hour, (metrics.purchasePatterns.get(hour) || 0) + 1);
        }
    }

    predictEndpointPerformance(endpoint) {
        const metrics = this.endpointMetrics.get(endpoint);
        if (!metrics) return 0;

        const recentLatencies = metrics.performance.last5m;
        if (recentLatencies.length < 5) return 0;

        // Calculate trend
        const trend = recentLatencies.slice(-5).reduce((acc, curr, idx, arr) => {
            if (idx === 0) return 0;
            return acc + (curr - arr[idx - 1]);
        }, 0) / 4;

        // Calculate reliability score
        const successRate = metrics.successCount / (metrics.successCount + metrics.failureCount);
        const latencyScore = 1 - (metrics.averageLatency / 2000); // Normalize to 0-1
        const rateLimitScore = 1 - (metrics.rateLimitHits / 10);

        // Weighted scoring
        return (successRate * 0.4) + (latencyScore * 0.3) + (rateLimitScore * 0.2) + (trend * 0.1);
    }

    async trainPredictionModel() {
        const metrics = Array.from(this.endpointMetrics.entries());
        
        for (const [endpoint, metrics] of metrics) {
            // Add historical data points
            metrics.performance.last15m.forEach((latency, index) => {
                const historicalMetrics = {
                    ...metrics,
                    averageLatency: latency,
                    requestsPerMinute: Math.max(0, metrics.requestsPerMinute - index)
                };
                this.endpointPredictor.addDataPoint(historicalMetrics);
            });
        }
        
        await this.updatePredictions();
    }

    async updatePredictions() {
        const predictions = await Promise.all(
            Array.from(this.endpointMetrics.entries()).map(async ([endpoint, metrics]) => {
                const prediction = await this.endpointPredictor.predict(endpoint, metrics);
                return {
                    endpoint,
                    prediction,
                    currentScore: this.calculateEndpointScore(metrics)
                };
            })
        );
        
        // Update endpoint selection based on predictions
        const bestEndpoint = predictions
            .sort((a, b) => (b.currentScore * (1 - b.prediction.failureProbability)) - 
                            (a.currentScore * (1 - a.prediction.failureProbability)))[0];
        
        if (bestEndpoint.endpoint !== this.config.rpc.endpoints[this.currentRpcIndex]) {
            this.rotateEndpoint();
        }
    }

    async analyzeWalletPatterns() {
        const wallets = Array.from(this.walletActivityMetrics.keys());
        const now = Date.now();

        for (const wallet of wallets) {
            const metrics = this.walletActivityMetrics.get(wallet);
            
            // Clean up old activities
            metrics.activities = metrics.activities.filter(
                activity => now - activity.timestamp < this.walletBehaviorAnalyzer.ANALYSIS_WINDOW
            );

            // Analyze patterns if we have enough data
            if (metrics.activities.length > 0) {
                const purchasePattern = {
                    purchases: metrics.activities.filter(a => a.type === 'memecoinPurchase'),
                    timePatterns: metrics.purchasePatterns,
                    score: metrics.score
                };

                this.walletBehaviorAnalyzer.analyzePurchasePattern(wallet, purchasePattern);
                
                // Update priority based on analysis
                const relatedWallets = this.walletBehaviorAnalyzer.findRelatedWallets(wallet);
                if (relatedWallets.length > 0) {
                    this.adjustWalletPriority(wallet, relatedWallets);
                }
            }
        }
    }

    adjustWalletPriority(wallet, relatedWallets) {
        const metrics = this.walletActivityMetrics.get(wallet);
        const relatedActivity = relatedWallets.some(related => {
            const relatedMetrics = this.walletActivityMetrics.get(related);
            return relatedMetrics && relatedMetrics.score > 0.7;
        });

        if (relatedActivity) {
            metrics.score *= 1.2; // Boost priority
            console.log(`Boosted priority for wallet ${wallet.slice(0, 4)}... due to related wallet activity`);
        }
    }
}

module.exports = TokenMonitor; 