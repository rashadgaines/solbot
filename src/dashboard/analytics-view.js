class AnalyticsView {
    constructor(dashboard) {
        this.dashboard = dashboard;
        this.chartUpdateInterval = 60000; // 1 minute
        this.setupRealTimeUpdates();
    }

    setupRealTimeUpdates() {
        this.dashboard.io.on('connection', (socket) => {
            socket.on('subscribe-analytics', () => {
                socket.join('analytics-room');
                this.pushInitialData(socket);
            });
        });

        setInterval(() => this.pushUpdates(), 5000);
    }

    async pushUpdates() {
        const data = await this.gatherAnalyticsData();
        this.dashboard.io.to('analytics-room').emit('analytics-update', data);
    }

    async gatherAnalyticsData() {
        return {
            endpoints: this.dashboard.getMLMetrics().endpointPredictions,
            wallets: this.dashboard.getAnalyticsMetrics().wallets,
            patterns: this.dashboard.getAnalyticsMetrics().patterns
        };
    }
}

module.exports = AnalyticsView; 