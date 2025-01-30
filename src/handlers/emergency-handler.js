const { EventEmitter } = require('events');

class EmergencyHandler extends EventEmitter {
    constructor(dashboard, telegram) {
        super();
        this.dashboard = dashboard;
        this.telegramHandler = telegram;
        
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
}

module.exports = EmergencyHandler; 