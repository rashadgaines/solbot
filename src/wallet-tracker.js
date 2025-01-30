const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const axios = require('axios');
const EventEmitter = require('events');

class WalletTracker extends EventEmitter {
    constructor(connection, config, bot) {
        super();
        this.connection = connection;
        this.config = config;
        this.bot = bot;  // Store bot reference
        this.trackedWallets = this.loadTrackedWallets();
        this.recentTransactions = new Map();
        
        // Updated queue handling
        this.highPriorityQueue = [];
        this.normalPriorityQueue = [];
        this.isProcessing = false;
        
        // Cache settings
        this.cache = {
            walletBalances: new Map(),
            transactions: new Map(),
            signatures: new Map()
        };
        this.BALANCE_CACHE_TTL = 30000;    // 30 seconds
        this.TRANSACTION_CACHE_TTL = 60000; // 1 minute
        this.SIGNATURE_CACHE_TTL = 30000;   // 30 seconds
        
        // Existing price cache
        this.lastPriceCheck = 0;
        this.cachedSolPrice = null;
        this.PRICE_CACHE_DURATION = 60000;
        
        // Rate limiting settings
        this.requestsPerInterval = 10;
        this.intervalMs = 1000;
        this.requestQueue = [];
        this.lastRequestTime = Date.now();
        
        // Track memecoin purchases
        this.recentPurchases = new Map();
        this.purchaseAlerts = [];
        
        // Add monitoring state
        this.lastWalletCheck = new Map();
        this.WALLET_CHECK_INTERVAL = 30000; // 30 seconds minimum between checks
        this.walletPriorities = new Map();
        
        // New request timestamps
        this.requestTimestamps = [];
    }

    loadTrackedWallets() {
        const data = fs.readFileSync('./tracked-wallets.json');
        return JSON.parse(data).wallets;
    }

    async trackWalletTransactions() {
        const now = Date.now();
        const eligibleWallets = this.trackedWallets.filter(wallet => {
            const lastCheck = this.lastWalletCheck.get(wallet) || 0;
            return (now - lastCheck) >= this.WALLET_CHECK_INTERVAL;
        });

        if (eligibleWallets.length === 0) return null;

        const batchSize = 2; // Reduced from 5 to 2
        const walletBatches = this.chunkArray(eligibleWallets, batchSize);

        for (const batch of walletBatches) {
            try {
                const promises = batch.map(wallet => this.processWalletTransactions(wallet));
                const results = await Promise.all(promises);
                
                // Update last check time for processed wallets
                batch.forEach(wallet => {
                    this.lastWalletCheck.set(wallet, now);
                });

                // Add delay between batches
                if (walletBatches.length > 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                const validResults = results.filter(r => r && r.length > 0);
                if (validResults.length > 0) {
                    return validResults.flat();
                }
            } catch (error) {
                console.error('Error processing wallet batch:', error);
                await new Promise(resolve => setTimeout(resolve, 5000)); // Longer delay on error
            }
        }
        return null;
    }

    async rateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        const baseDelay = 2000; // Increase base delay to 2 seconds
        const jitter = Math.random() * 500; // Add randomization
        
        if (timeSinceLastRequest < this.intervalMs) {
            await new Promise(resolve => 
                setTimeout(resolve, baseDelay + jitter)
            );
        }
        
        // Track request timestamps for rolling window
        this.requestTimestamps = this.requestTimestamps.filter(t => now - t < 60000);
        this.requestTimestamps.push(now);
        
        // If we're approaching rate limit, add extra delay
        if (this.requestTimestamps.length > 45) { // 75% of 60 requests/minute
            await new Promise(resolve => 
                setTimeout(resolve, 5000 + jitter)
            );
        }
        
        this.lastRequestTime = Date.now();
    }

    async processWalletTransactions(wallet) {
        const endpoint = this.bot.config.rpc.endpoints[this.bot.currentRpcIndex];
        try {
            console.log(`Processing wallet ${wallet.slice(0, 4)}...${wallet.slice(-4)} using endpoint: ${endpoint}`);
            
            const signatures = await this.bot.queueRequest(
                async () => this.getTransactionSignatures(wallet),
                true
            );

            if (!signatures || signatures.length === 0) {
                console.log(`No signatures found for wallet ${wallet}`);
                return [];
            }

            const transactions = await Promise.all(
                signatures.map(sig => 
                    this.bot.queueRequest(
                        async () => {
                            try {
                                const tx = await this.connection.getParsedTransaction(sig.signature);
                                return tx || null;
                            } catch (error) {
                                console.error(`Error fetching transaction ${sig.signature}:`, error);
                                return null;
                            }
                        },
                        false
                    )
                )
            );

            const validTransactions = transactions.filter(tx => tx !== null);
            const memecoinPurchases = validTransactions
                .map(tx => this.extractMemecoinPurchase(tx))
                .filter(purchase => purchase !== null);

            if (memecoinPurchases.length > 0) {
                await this.processPurchaseAlerts(wallet, memecoinPurchases);
            }

            return memecoinPurchases;
        } catch (error) {
            console.error(`Error processing wallet ${wallet} on endpoint ${endpoint}:`, error.message);
            this.bot.recordFailure(endpoint);
            return [];
        }
    }

    async processPurchaseAlerts(wallet, purchases) {
        for (const purchase of purchases) {
            const tokenAddress = purchase.tokenAddress;
            
            // Track which wallets bought this token
            if (!this.recentPurchases.has(tokenAddress)) {
                this.recentPurchases.set(tokenAddress, new Set());
            }
            this.recentPurchases.get(tokenAddress).add(wallet);
            
            // Check if multiple wallets bought the same token
            const buyerCount = this.recentPurchases.get(tokenAddress).size;
            const priority = buyerCount >= this.config.alerts.priorityThreshold ? 'HIGH' : 'MEDIUM';
            
            this.emit('purchase', {
                wallet,
                purchase,
                priority,
                buyerCount
            });
        }
    }

    chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    async processTokenPurchase(wallet, purchase) {
        // Validate purchase amount
        if (!this.isValidPurchaseAmount(purchase.amount)) {
            console.log(`Skipping small transaction: ${purchase.amount} SOL`);
            return null;
        }

        const timeWindow = 90 * 60 * 1000; // 90 minutes
        const now = Date.now();
        
        // Clean old transactions
        for (const [key, tx] of this.recentTransactions) {
            if (now - tx.timestamp > timeWindow) {
                this.recentTransactions.delete(key);
            }
        }

        // Get SOL price for USD conversion
        const solPrice = await this.getSolPrice();

        // Add new transaction with SOL amount
        const txKey = `${purchase.tokenAddress}-${now}`;
        this.recentTransactions.set(txKey, {
            wallet,
            ...purchase,
            solAmount: purchase.amount,
            usdAmount: purchase.amount * solPrice,
            timestamp: now
        });

        // Check for related purchases
        const relatedPurchases = this.findRelatedPurchases(purchase.tokenAddress, timeWindow);
        
        // Format buyers with amounts
        const buyers = relatedPurchases.map(tx => ({
            wallet: tx.wallet,
            amount: tx.solAmount,
            usdAmount: tx.usdAmount
        }));

        return {
            priority: relatedPurchases.length >= 2 ? 'HIGH' : 'MEDIUM',
            token: purchase.tokenSymbol,
            contract: purchase.tokenAddress,
            buyers,
            totalAmount: buyers.reduce((sum, b) => sum + b.amount, 0),
            timeFrame: `${Math.round((now - relatedPurchases[0].timestamp)/60000)}m ago`
        };
    }

    extractTokenPurchase(tx) {
        if (!tx?.meta?.postTokenBalances?.length) return null;
        
        // Extract token purchase details from transaction
        try {
            const tokenBalance = tx.meta.postTokenBalances[0];
            return {
                tokenAddress: tokenBalance.mint,
                tokenSymbol: this.getTokenSymbol(tokenBalance.mint),
                amount: tokenBalance.uiTokenAmount.uiAmount,
                timestamp: tx.blockTime * 1000
            };
        } catch (error) {
            console.error('Error extracting token purchase:', error);
            return null;
        }
    }

    findRelatedPurchases(tokenAddress, timeWindow) {
        const now = Date.now();
        return Array.from(this.recentTransactions.values())
            .filter(tx => 
                tx.tokenAddress === tokenAddress && 
                now - tx.timestamp <= timeWindow
            );
    }

    async addWallet(wallet) {
        if (!this.isValidWallet(wallet)) {
            throw new Error('Invalid wallet address');
        }
        
        const wallets = this.loadTrackedWallets();
        if (!wallets.includes(wallet)) {
            wallets.push(wallet);
            await this.saveWallets(wallets);
            this.trackedWallets = wallets;
        }
    }

    async removeWallet(wallet) {
        const wallets = this.loadTrackedWallets()
            .filter(w => w !== wallet);
        await this.saveWallets(wallets);
        this.trackedWallets = wallets;
    }

    isValidWallet(address) {
        try {
            new PublicKey(address);
            return true;
        } catch {
            return false;
        }
    }

    async saveWallets(wallets) {
        await fs.promises.writeFile(
            './tracked-wallets.json',
            JSON.stringify({ wallets }, null, 2)
        );
    }

    async getSolPrice() {
        const now = Date.now();
        
        // Return cached price if within cache duration
        if (this.cachedSolPrice && (now - this.lastPriceCheck) < this.PRICE_CACHE_DURATION) {
            return this.cachedSolPrice;
        }

        try {
            // Try CoinGecko first
            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            if (response.data?.solana?.usd) {
                this.cachedSolPrice = response.data.solana.usd;
                this.lastPriceCheck = now;
                return this.cachedSolPrice;
            }

            // Fallback to Jupiter price API
            const jupiterResponse = await axios.get(`https://price.jup.ag/v4/price?ids=SOL`);
            if (jupiterResponse.data?.data?.SOL?.price) {
                this.cachedSolPrice = jupiterResponse.data.data.SOL.price;
                this.lastPriceCheck = now;
                return this.cachedSolPrice;
            }

            throw new Error('Failed to fetch SOL price from all sources');
        } catch (error) {
            console.error('Error fetching SOL price:', error);
            return this.cachedSolPrice || 0; // Return last known price or 0
        }
    }

    isValidPurchaseAmount(amount) {
        const MIN_SOL_AMOUNT = 0.1; // Minimum 0.1 SOL
        const MAX_SOL_AMOUNT = 10000; // Maximum 10,000 SOL
        
        return amount >= MIN_SOL_AMOUNT && 
               amount <= MAX_SOL_AMOUNT && 
               !isNaN(amount);
    }

    async queueTransaction(wallet, transaction) {
        this.processingQueue.push({ wallet, transaction });
        if (!this.isProcessing) {
            await this.processQueue();
        }
    }

    async processQueue() {
        if (this.processingQueue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const batch = this.processingQueue.splice(0, 10); // Process 10 at a time
        
        try {
            const results = await Promise.all(
                batch.map(({ wallet, transaction }) => 
                    this.processTokenPurchase(wallet, transaction)
                )
            );
            
            // Filter out null results and emit alerts
            const alerts = results.filter(r => r !== null);
            if (alerts.length > 0) {
                this.emit('alerts', alerts);
            }
        } catch (error) {
            console.error('Error processing transaction batch:', error);
        }

        // Process next batch
        await this.processQueue();
    }

    async getWalletBalance(address) {
        const cached = this.cache.walletBalances.get(address);
        if (cached && Date.now() - cached.timestamp < this.BALANCE_CACHE_TTL) {
            return cached.value;
        }

        const balance = await this.connection.getBalance(new PublicKey(address));
        this.cache.walletBalances.set(address, {
            value: balance,
            timestamp: Date.now()
        });
        return balance;
    }

    async getTransactionSignatures(wallet) {
        const cacheKey = `${wallet}-signatures`;
        const cached = this.cache.signatures.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.SIGNATURE_CACHE_TTL) {
            return cached.value;
        }

        try {
            const signatures = await this.connection.getSignaturesForAddress(
                new PublicKey(wallet),
                { limit: 20 }
            );

            // Validate and format the response
            if (!signatures || !Array.isArray(signatures)) {
                console.warn(`Invalid signature response for wallet ${wallet}`);
                return [];
            }

            const formattedSignatures = signatures.map(sig => ({
                signature: sig.signature,
                slot: sig.slot,
                blockTime: sig.blockTime
            }));

            this.cache.signatures.set(cacheKey, {
                value: formattedSignatures,
                timestamp: Date.now()
            });

            return formattedSignatures;
        } catch (error) {
            console.error(`Error fetching signatures for wallet ${wallet}:`, error);
            return [];
        }
    }
}

module.exports = WalletTracker; 