class Logger {
    static getTimestamp() {
        return new Date().toLocaleTimeString();
    }

    static info(message) {
        console.log(`[${this.getTimestamp()}] ℹ️  ${message}`);
    }

    static success(message) {
        console.log(`[${this.getTimestamp()}] ✅ ${message}`);
    }

    static warning(message) {
        console.log(`[${this.getTimestamp()}] ⚠️  ${message}`);
    }

    static error(message) {
        console.error(`[${this.getTimestamp()}] ❌ ${message}`);
    }

    static debug(message) {
        console.debug(`[${this.getTimestamp()}] 🔍 ${message}`);
    }
}

module.exports = Logger; 