const { EventEmitter } = require('events');

class EmergencyHandler extends EventEmitter {
    constructor(dashboard, telegram) {
        super();
        this.dashboard = dashboard;
        this.telegramHandler = telegram;
        this.errorCounts = new Map();
        this.ERROR_THRESHOLD = 3;
        this.RESET_INTERVAL = 300000; // 5 minutes
        
        if (this.dashboard?.io) {
            this.dashboard.io.on('emergency-stop', () => this.triggerEmergencyStop());
        }
    }

    async triggerEmergencyStop() {
        try {
            const alert = {
                type: 'emergency-stop',
                timestamp: Date.now(),
                reason: 'Manual emergency stop triggered'
            };

            // Notify systems
            this.emit('emergency', alert);
            
            // Update interfaces
            if (this.dashboard?.io) {
                this.dashboard.io.emit('emergency-stop', alert);
            }
            
            if (this.telegramHandler) {
                await this.telegramHandler.sendMessage(
                    process.env.TELEGRAM_CHAT_ID,
                    '🚨 EMERGENCY STOP TRIGGERED 🚨\nTracking paused.'
                );
            }
            
            return true;
        } catch (error) {
            console.error('Emergency stop failed:', error);
            throw error;
        }
    }

    handleError(error, context) {
        console.error(`Error in ${context}:`, error);
        
        // Track error count
        const currentCount = this.errorCounts.get(context) || 0;
        this.errorCounts.set(context, currentCount + 1);

        // Reset error count after interval
        setTimeout(() => {
            this.errorCounts.set(context, 0);
        }, this.RESET_INTERVAL);

        // Check if we need to take emergency action
        if (this.errorCounts.get(context) >= this.ERROR_THRESHOLD) {
            this.handleEmergency(context);
        }
    }

    handleEmergency(context) {
        console.error(`Emergency: Multiple errors detected in ${context}`);
        // Add any emergency handling logic here
    }
}

module.exports = EmergencyHandler; 