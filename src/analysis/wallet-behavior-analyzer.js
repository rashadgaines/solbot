class WalletBehaviorAnalyzer {
    constructor() {
        this.walletPatterns = new Map();
        this.correlatedWallets = new Map();
        this.ANALYSIS_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
    }

    analyzePurchasePattern(wallet, purchase) {
        if (!this.walletPatterns.has(wallet)) {
            this.walletPatterns.set(wallet, {
                purchases: [],
                timePatterns: new Map(),
                tokenPreferences: new Map(),
                successRate: 0
            });
        }

        const pattern = this.walletPatterns.get(wallet);
        pattern.purchases.push({
            timestamp: Date.now(),
            token: purchase.tokenAddress,
            amount: purchase.amount
        });

        this.updateCorrelations(wallet, purchase);
        this.calculateSuccessRate(wallet);
    }

    findRelatedWallets(wallet) {
        const correlations = this.correlatedWallets.get(wallet) || new Map();
        return Array.from(correlations.entries())
            .filter(([_, score]) => score > 0.7)
            .map(([relatedWallet]) => relatedWallet);
    }
}

module.exports = WalletBehaviorAnalyzer; 