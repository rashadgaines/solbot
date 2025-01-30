// Load environment variables first
require('dotenv').config();

// Then load other dependencies
const config = require('./config');
const TokenMonitor = require('./token-monitor');

// Validate required environment variables
if (!process.env.HELIUS_RPC_URL && !process.env.QUICKNODE_RPC_URL) {
    throw new Error('At least one RPC endpoint (HELIUS_RPC_URL or QUICKNODE_RPC_URL) must be provided');
}

async function startBot() {
    try {
        const monitor = new TokenMonitor(config);
        await monitor.startMonitoring();
        console.log('Bot started successfully');
    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

startBot(); 