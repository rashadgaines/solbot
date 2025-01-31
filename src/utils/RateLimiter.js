class RateLimiter {
    constructor(options = {}) {
        this.maxTokens = options.maxTokens || 30;
        this.tokens = this.maxTokens;
        this.refillRate = options.refillRate || 2; // tokens per second
        this.lastRefill = Date.now();
        
        // Backoff settings
        this.baseDelay = 2000;
        this.maxDelay = 30000;
        this.failureCount = 0;
    }

    async getToken() {
        this._refillTokens();
        
        if (this.tokens < 1) {
            const waitTime = this._calculateWaitTime();
            await new Promise(resolve => setTimeout(resolve, waitTime));
            this._refillTokens();
        }
        
        this.tokens--;
        return true;
    }

    _refillTokens() {
        const now = Date.now();
        const timePassed = (now - this.lastRefill) / 1000;
        const newTokens = timePassed * this.refillRate;
        
        this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
        this.lastRefill = now;
    }

    _calculateWaitTime() {
        const backoffMultiplier = Math.min(Math.pow(2, this.failureCount), 8);
        return Math.min(this.baseDelay * backoffMultiplier, this.maxDelay);
    }

    recordSuccess() {
        this.failureCount = Math.max(0, this.failureCount - 1);
    }

    recordFailure() {
        this.failureCount++;
        this.tokens = 0; // Reset tokens on failure
    }
}

module.exports = RateLimiter; 