const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const Dashboard = require('./dashboard/dashboard');
const EmergencyHandler = require('./handlers/emergency-handler');
const TelegramHandler = require('./handlers/telegram-handler');
const WalletTracker = require('./wallet-tracker');
const EndpointPredictor = require('./ml/EndpointPredictor');
const Logger = require('./utils/logger');

class TokenMonitor {
    constructor(config) {
        this.config = config;
        Logger.info('Initializing Token Monitor...');
        
        this.currentRpcIndex = 0;
        this.connection = this.createConnection();
        Logger.success(`Connected to RPC: ${this.config.rpc.endpoints[0]}`);
        
        this.walletAddress = process.env.WALLET_ADDRESS;
        Logger.info(`Main wallet address: ${this.walletAddress}`);
        
        // Initialize components
        Logger.info('Initializing components...');
        this.walletTracker = new WalletTracker(this.connection, config.monitoring, this);
        this.telegramHandler = new TelegramHandler(
            new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true }),
            process.env.TELEGRAM_CHAT_ID,
            this.walletAddress,
            this.walletTracker
        );
        
        this.dashboard = this.initializeDashboard();
        this.initializeErrorHandler();
        Logger.success('All components initialized successfully');
        
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

        this.endpointPredictor = new EndpointPredictor();
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
        const endpoints = this.config.rpc.endpoints;
        const connections = endpoints.map(endpoint => new Connection(endpoint, {
            commitment: 'confirmed',
            httpHeaders: this.config.rpc.headers || {},
            wsEndpoint: endpoint.replace('https', 'wss'),
            useRequestQueue: true,
            requestTimeout: 30000
        }));
        
        this.connections = connections;
        this.currentConnectionIndex = 0;
        return connections[0];
    }

    async rotateConnection() {
        const currentEndpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        this.setCooldown(currentEndpoint);
        
        // Find next healthy endpoint
        const healthyEndpoints = this.config.rpc.endpoints.filter(endpoint => 
            !this.isEndpointCooling(endpoint) && 
            this.getEndpointHealth(endpoint) > 0.7
        );

        if (healthyEndpoints.length === 0) {
            console.log('No healthy endpoints available, enforcing cooldown period...');
            await new Promise(resolve => setTimeout(resolve, 30000)); // 30s cooldown
            return this.rotateConnection();
        }

        // Sort by health score and pick the best one
        const nextEndpoint = healthyEndpoints.sort((a, b) => 
            this.getEndpointHealth(b) - this.getEndpointHealth(a)
        )[0];

        this.currentRpcIndex = this.config.rpc.endpoints.indexOf(nextEndpoint);
        this.connection = new Connection(nextEndpoint, {
            commitment: 'confirmed',
            httpHeaders: this.config.rpc.headers || {},
            wsEndpoint: nextEndpoint.replace('https', 'wss')
        });

        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s settling time
        console.log(`Rotated to endpoint ${this.currentRpcIndex + 1}/${this.config.rpc.endpoints.length}`);
    }

    getEndpointHealth(endpoint) {
        const metrics = this.endpointMetrics.get(endpoint);
        if (!metrics) return 0;

        const rateLimitScore = Math.max(0, 1 - (metrics.rateLimitHits / 10));
        const successScore = metrics.successCount / (metrics.successCount + metrics.failureCount);
        const latencyScore = Math.max(0, 1 - (metrics.averageLatency / 1000));

        return (rateLimitScore * 0.4) + (successScore * 0.4) + (latencyScore * 0.2);
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
            console.log(`Rate limit hit on ${currentEndpoint}, cooling down...`);
            this.setCooldown(currentEndpoint);
            await this.rotateConnection();
            await new Promise(resolve => setTimeout(resolve, 5000));
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

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    async startMonitoring() {
        const wallets = this.walletTracker.trackedWallets;
        const walletGroups = this.chunkArray(wallets, 5);
        
        for (const group of walletGroups) {
            try {
                await this.walletTracker.processWallets();
                
                const delay = this.calculateAdaptiveDelay();
                await new Promise(resolve => setTimeout(resolve, delay));
                
            } catch (error) {
                console.error('Error processing wallet group:', error);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }

    async adjustWalletPriorities() {
        const activityScores = new Map();
        
        for (const wallet of this.walletTracker.trackedWallets) {
            const recentActivity = await this.getWalletActivityScore(wallet);
            activityScores.set(wallet, recentActivity);
            
            // Adjust priority based on activity
            if (recentActivity > 0.8) {
                this.walletTracker.walletPriorities.set(wallet, 'HIGH');
            } else if (recentActivity > 0.4) {
                this.walletTracker.walletPriorities.set(wallet, 'MEDIUM');
            } else {
                this.walletTracker.walletPriorities.set(wallet, 'LOW');
            }
        }
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

    async executeWithCircuitBreaker(operation) {
        const endpoint = this.config.rpc.endpoints[this.currentRpcIndex];
        const metrics = this.endpointMetrics.get(endpoint);
        const startTime = Date.now();

        try {
            const result = await operation(this.connection);
            
            // Update success metrics
            metrics.successCount++;
            metrics.consecutiveFailures = 0;
            metrics.averageLatency = (metrics.averageLatency + (Date.now() - startTime)) / 2;
            metrics.lastMinuteRequests.push(Date.now());
            
            // Clean up old requests
            metrics.lastMinuteRequests = metrics.lastMinuteRequests.filter(
                time => Date.now() - time < 60000
            );
            metrics.requestsPerMinute = metrics.lastMinuteRequests.length;
            
            return result;
        } catch (error) {
            // Update failure metrics
            metrics.failureCount++;
            metrics.consecutiveFailures++;
            
            if (error.message.includes('429')) {
                metrics.rateLimitHits++;
                metrics.lastRateLimitHit = Date.now();
            }
            
            throw error;
        }
    }

    initializeEndpointMetrics() {
        this.endpointMetrics = new Map();
        
        this.config.rpc.endpoints.forEach(endpoint => {
            this.endpointMetrics.set(endpoint, {
                successCount: 0,
                failureCount: 0,
                latency: [],
                lastUsed: Date.now(),
                rateLimitHits: 0,
                lastError: null,
                performance: {
                    success: 0,
                    total: 0,
                    avgLatency: 0
                }
            });
        });
    }

    updateEndpointMetrics() {
        if (!this.endpointMetrics) {
            this.initializeEndpointMetrics();
            return;
        }

        const metrics = {};
        this.endpointMetrics.forEach((value, endpoint) => {
            const successRate = value.total === 0 ? 0 : value.success / value.total;
            const avgLatency = value.latency.length > 0 
                ? value.latency.reduce((a, b) => a + b, 0) / value.latency.length 
                : 0;

            metrics[endpoint] = {
                successRate,
                avgLatency,
                rateLimitHits: value.rateLimitHits,
                lastError: value.lastError,
                lastUsed: value.lastUsed
            };
        });

        return metrics;
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
        const BATCH_SIZE = 2; // Reduced from 3 to 2
        const BATCH_INTERVAL = 8000; // Increased from 5s to 8s
        
        try {
            while (this.priorityQueue.length || this.requestQueue.length) {
                const batch = [];
                
                // Prioritize high-priority requests
                while (batch.length < BATCH_SIZE && (this.priorityQueue.length || this.requestQueue.length)) {
                    const request = this.priorityQueue.shift() || this.requestQueue.shift();
                    if (request && Date.now() - request.timestamp < 60000) { // Skip stale requests
                        batch.push(request);
                    }
                }
                
                if (batch.length > 0) {
                    await Promise.all(batch.map(request => 
                        this.executeWithCircuitBreaker(request.operation)
                            .catch(error => {
                                if (error.message.includes('429')) {
                                    this.rotateConnection();
                                    return new Promise(resolve => 
                                        setTimeout(() => resolve(this.executeWithCircuitBreaker(request.operation)), 10000)
                                    );
                                }
                                throw error;
                            })
                    ));
                    
                    await new Promise(resolve => setTimeout(resolve, BATCH_INTERVAL));
                }
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
            this.rotateConnection();
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

    async trainPredictionModel() {
        const metrics = Array.from(this.endpointMetrics.entries());
        
        for (const [endpoint, metrics] of metrics) {
            // Add historical data points
            metrics.performance.last5m.forEach((latency, index) => {
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
            this.rotateConnection();
        }
    }

    calculateAdaptiveDelay() {
        const baseDelay = 2000; // 2 seconds base delay
        const rateLimitMultiplier = this.endpointMetrics.get(this.connection._rpcEndpoint)?.rateLimitHits || 0;
        
        // Increase delay if we're hitting rate limits
        const adaptiveDelay = baseDelay * (1 + (rateLimitMultiplier * 0.5));
        
        // Cap maximum delay at 10 seconds
        return Math.min(adaptiveDelay, 10000);
    }

    async executeRequest(operation, priority = false) {
        const endpoint = await this.selectBestEndpoint();
        const metrics = this.endpointMetrics.get(endpoint);
        const startTime = Date.now();

        try {
            // Get rate limit token
            await this.walletTracker.rateLimiter.getToken();
            
            // Execute with timeout
            const result = await Promise.race([
                operation(this.connection),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Request timeout')), 30000)
                )
            ]);

            // Update metrics
            this.updateEndpointMetrics(endpoint, {
                latency: Date.now() - startTime,
                success: true
            });

            return result;
        } catch (error) {
            if (error.message.includes('429')) {
                metrics.rateLimitHits++;
                this.setCooldown(endpoint);
                await this.rotateConnection();
                return this.executeRequest(operation, priority);
            }
            throw error;
        }
    }
}

module.exports = TokenMonitor; 