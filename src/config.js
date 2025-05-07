const config = {
    monitoring: {
        healthCheckInterval: 60000,
        walletTrackingInterval: 120000,  // 2 minutes
        priceUpdateInterval: 60000,
        maxTrackedWallets: 50,           
        batchSize: 1,
        batchDelay: 8000                 
    },
    rpc: {
        endpoints: [
            process.env.QUICKNODE_RPC_URL,
            process.env.HELIUS_RPC_URL
        ].filter(Boolean),
        retryDelay: 8000,
        maxRetries: 2,
        requestsPerInterval: 1,
        intervalMs: 5000,
        healthCheck: {
            interval: 30000,
            timeout: 5000,
            failureThreshold: 3
        }
    }
};

module.exports = config; 