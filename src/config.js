const config = {
    monitoring: {
        healthCheckInterval: 60000,
        walletTrackingInterval: 30000,
        priceUpdateInterval: 60000,
        maxTrackedWallets: 100,
        batchSize: 2,
        batchDelay: 2000
    },
    alerts: {
        minTransactionAmount: 0.1, // SOL
        timeWindow: 90 * 60 * 1000, // 90 minutes
        priorityThreshold: 2 // Number of wallets for HIGH priority
    },
    security: {
        minLiquidity: 10000,          // Minimum liquidity in USD
        maxHolderConcentration: 50,   // Maximum percentage held by top wallets
        minTradeCount: 100            // Minimum number of trades
    },
    dashboard: {
        port: process.env.DASHBOARD_PORT || 3000,
        updateInterval: 30000, // 30 seconds
        maxHistoricalTransactions: 100
    },
    rpc: {
        endpoints: [
            process.env.HELIUS_RPC_URL,
            process.env.QUICKNODE_RPC_URL
        ].filter(Boolean),
        retryDelay: 5000,
        maxRetries: 3,
        requestsPerInterval: 2,
        intervalMs: 3000,
        healthCheck: {
            interval: 20000,
            timeout: 3000,
            failureThreshold: 2
        }
    }
};

module.exports = config; 