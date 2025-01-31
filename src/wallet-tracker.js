const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const axios = require('axios');
const EventEmitter = require('events');
const RateLimiter = require('./utils/RateLimiter');
const Logger = require('./utils/logger');

class TokenBucket {
    constructor(capacity, fillPerSecond) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.fillPerSecond = fillPerSecond;
        this.lastFill = Date.now();
        
        // Much more conservative settings
        this.minWaitTime = 15000;     // 15 seconds base wait
        this.maxWaitTime = 120000;    // 2 minutes max wait
        this.backoffMultiplier = 1;
        this.consecutiveFailures = 0;
        
        // Track request history
        this.requestHistory = new Map(); // wallet -> lastRequestTime
    }

    async getToken(priority = 'LOW', wallet = null) {
        this.fillBucket();
        
        // Check wallet-specific cooldown
        if (wallet) {
            const lastRequest = this.requestHistory.get(wallet) || 0;
            const timeSinceLastRequest = Date.now() - lastRequest;
            if (timeSinceLastRequest < this.minWaitTime) {
                await new Promise(resolve => 
                    setTimeout(resolve, this.minWaitTime - timeSinceLastRequest)
                );
            }
        }

        // Calculate wait time based on tokens and failures
        if (this.tokens < 1 || this.consecutiveFailures > 0) {
            const waitTime = Math.min(
                this.minWaitTime * Math.pow(2, this.consecutiveFailures),
                this.maxWaitTime
            );
            
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this.fillBucket();
        }

        // Update tracking
        if (wallet) {
            this.requestHistory.set(wallet, Date.now());
        }
        
        this.tokens = Math.max(0, this.tokens - 1);
        return true;
    }

    recordSuccess() {
        this.consecutiveFailures = Math.max(0, this.consecutiveFailures - 1);
        this.backoffMultiplier = Math.max(1, this.backoffMultiplier * 0.5);
    }

    recordFailure() {
        this.consecutiveFailures++;
        this.tokens = 0; // Reset tokens on failure
    }

    fillBucket() {
        const now = Date.now();
        const timePassed = (now - this.lastFill) / 1000;
        this.lastFill = now;
        
        this.tokens = Math.min(
            this.capacity,
            this.tokens + timePassed * this.fillPerSecond
        );
    }
}

class WalletTracker extends EventEmitter {
    constructor(connection, config, bot) {
        super();
        this.connection = connection;
        this.config = config;
        this.bot = bot;
        this.trackedWallets = this.loadTrackedWallets();
        
        // More conservative rate limiting
        this.rateLimiter = new RateLimiter({
            maxTokens: 15,  // Reduced from 25
            refillRate: 1   // Reduced from 2
        });
        
        // Increased cache TTL
        this.transactionCache = new Map();
        this.CACHE_TTL = 60000; // Increased to 60 seconds
        
        // Increased monitoring intervals
        this.PRIORITY_LEVELS = {
            HIGH: 15000,    // 15 seconds
            MEDIUM: 45000,  // 45 seconds
            LOW: 90000      // 90 seconds
        };
        
        this.sentAlerts = new Map();
        this.startMonitoring();
    }

    async startMonitoring() {
        Logger.info('Starting wallet monitoring...');
        Logger.info(`Tracking ${this.trackedWallets.length} wallets`);
        
        let processedTransactions = 0;
        let lastStatusUpdate = Date.now();
        
        while (true) {
            try {
                await this.processWallets();
                processedTransactions++;
                
                // Log status every minute
                if (Date.now() - lastStatusUpdate > 60000) {
                    Logger.info(`Status Update:
• Processed ${processedTransactions} wallet checks
• Current rate limits: ${this.rateLimiter.tokens.toFixed(2)} tokens
• Active wallets: ${this.trackedWallets.length}
`);
                    lastStatusUpdate = Date.now();
                    processedTransactions = 0;
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                Logger.error(`Monitoring error: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }

    async processWallets() {
        const wallets = this.trackedWallets;
        for (const wallet of wallets) {
            try {
                await this.rateLimiter.getToken();
                const updates = await this.checkWalletActivity(wallet);
                
                if (updates.hasActivity) {
                    this.emit('walletUpdate', {
                        wallet,
                        ...updates,
                        timestamp: Date.now()
                    });
                }
            } catch (error) {
                if (error.message.includes('429')) {
                    this.rateLimiter.recordFailure();
                    await this.bot.rotateConnection();
                    continue;
                }
                console.error(`Error processing wallet ${wallet}:`, error);
            }
        }
    }

    async checkWalletActivity(wallet) {
        const [tokenAccounts, signatures] = await Promise.all([
            this.getWalletTokenAccounts(wallet),
            this.getRecentSignatures(wallet)
        ]);

        const transactions = await this.processTransactions(signatures);
        // Wait for all promises to resolve
        const memecoinTxs = await Promise.all(
            transactions
                .map(tx => this.extractMemecoinTransaction(tx, wallet))
                .filter(tx => tx !== null)
        );

        return {
            hasActivity: memecoinTxs.length > 0,
            memecoinTransactions: memecoinTxs.filter(tx => tx !== null) // Additional null check
        };
    }

    async getRecentSignatures(wallet) {
        await this.rateLimiter.getToken();
        
        // Get current timestamp and calculate cutoff (30 minutes ago)
        const currentTime = Math.floor(Date.now() / 1000);
        const cutoffTime = currentTime - (30 * 60);
        
        const signatures = await this.connection.getSignaturesForAddress(
            new PublicKey(wallet),
            { limit: 10 },
            'confirmed'
        );
        
        // Filter out old transactions
        return signatures.filter(sig => sig.blockTime && sig.blockTime > cutoffTime);
    }

    async processTransactions(signatures) {
        const transactions = [];
        
        if (signatures.length > 0) {
            Logger.info(`Processing ${signatures.length} new transactions...`);
        }
        
        for (const sig of signatures) {
            try {
                await this.rateLimiter.getToken();
                const tx = await this.connection.getParsedTransaction(
                    sig.signature,
                    {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    }
                );
                
                if (tx && tx.transaction) {
                    const memecoinTx = await this.extractMemecoinTransaction(tx, sig.wallet);
                    if (memecoinTx) {
                        Logger.success(`Found new memecoin transaction: ${sig.signature}`);
                        transactions.push(memecoinTx);
                    }
                }
            } catch (error) {
                if (error.message.includes('429')) {
                    Logger.warning('Rate limit hit, cooling down...');
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }
                Logger.error(`Error fetching transaction ${sig.signature}: ${error.message}`);
            }
        }
        
        return transactions;
    }

    async extractMemecoinTransaction(tx, wallet) {
        try {
            // Validate transaction structure
            if (!tx?.transaction?.message?.instructions) {
                return null;
            }

            const tokenProgramIdx = tx.transaction.message.instructions.findIndex(
                ix => ix.programId?.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
            );

            if (tokenProgramIdx === -1) return null;

            const instruction = tx.transaction.message.instructions[tokenProgramIdx];
            
            // Validate instruction data
            if (!instruction?.parsed?.info?.mint) {
                return null;
            }

            // Check if we've already alerted about this transaction
            const txSignature = tx.transaction.signatures[0];
            if (this.sentAlerts.has(txSignature)) {
                return null;
            }

            // Mark this transaction as processed
            this.sentAlerts.set(txSignature, Date.now());

            return {
                wallet,
                tokenAddress: instruction.parsed.info.mint,
                amount: instruction.parsed.info.amount / 1e9,
                timestamp: tx.blockTime * 1000,
                signature: txSignature
            };
        } catch (error) {
            console.error('Error extracting memecoin transaction:', error);
            return null;
        }
    }

    async getWalletTokenAccounts(wallet) {
        await this.rateLimiter.getToken();
        const accounts = await this.connection.getParsedTokenAccountsByOwner(
            new PublicKey(wallet),
            { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
        );
        return accounts.value;
    }

    loadTrackedWallets() {
        try {
            const data = fs.readFileSync('./tracked-wallets.json');
            return JSON.parse(data).wallets;
        } catch (error) {
            console.error('Error loading wallets:', error);
            return [];
        }
    }
}

class DataCache {
    constructor(ttl = 30000) {
        this.cache = new Map();
        this.ttl = ttl;
        this.stats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.stats.misses++;
            return null;
        }

        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            this.stats.evictions++;
            return null;
        }

        this.stats.hits++;
        return entry.data;
    }

    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
}

class RequestCache {
    constructor(ttl = 30000) {
        this.cache = new Map();
        this.ttl = ttl;
        this.metrics = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalLatency: 0
        };
    }

    async getOrFetch(key, fetchFn) {
        const cached = this.get(key);
        if (cached) return cached;

        const startTime = Date.now();
        const data = await fetchFn();
        const latency = Date.now() - startTime;

        this.set(key, data, latency);
        return data;
    }
}

module.exports = WalletTracker; 