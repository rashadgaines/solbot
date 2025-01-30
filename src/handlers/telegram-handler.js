const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

class TelegramHandler {
    constructor(bot, chatId, walletAddress, walletTracker) {
        this.bot = bot;
        this.chatId = chatId || process.env.TELEGRAM_CHAT_ID;
        this.walletAddress = walletAddress || process.env.WALLET_ADDRESS;
        this.walletTracker = walletTracker;
        this.commandCooldowns = new Map();
        this.COOLDOWN_PERIOD = 5000; // 5 seconds between commands
        this.initializeCommands();
    }

    async handleCommand(chatId, command, handler) {
        const cooldownKey = `${chatId}-${command}`;
        const lastUsed = this.commandCooldowns.get(cooldownKey) || 0;
        const now = Date.now();

        if (now - lastUsed < this.COOLDOWN_PERIOD) {
            await this.bot.sendMessage(chatId, '⚠️ Please wait a few seconds between commands');
            return;
        }

        try {
            this.commandCooldowns.set(cooldownKey, now);
            await handler();
        } catch (error) {
            console.error(`Command error (${command}):`, error);
            await this.bot.sendMessage(chatId, '❌ Command failed. Please try again.');
        }
    }

    initializeCommands() {
        // Help command
        this.bot.onText(/\/help/, (msg) => {
            this.handleCommand(msg.chat.id, 'help', () => this.sendHelp(msg.chat.id));
        });

        // Add wallet command with validation
        this.bot.onText(/\/addwallet (.+)/, (msg, match) => {
            this.handleCommand(msg.chat.id, 'addwallet', () => 
                this.addWalletToTrack(msg.chat.id, match[1]));
        });

        // List tracked wallets
        this.bot.onText(/\/wallets/, async (msg) => {
            await this.listTrackedWallets(msg.chat.id);
        });

        // Wallet balance command
        this.bot.onText(/\/balance/, async (msg) => {
            await this.getWalletBalance(msg.chat.id);
        });

        // Quick buy command from alerts
        this.bot.onText(/\/buy_(.+)_(.+)/, async (msg, match) => {
            const token = match[1];
            const amount = match[2];
            await this.executeBuy(msg.chat.id, token, amount);
        });

        // Custom amount handler
        this.bot.on('callback_query', async (query) => {
            if (query.data.startsWith('buy_') && query.data.endsWith('_custom')) {
                const token = query.data.split('_')[1];
                await this.bot.sendMessage(query.message.chat.id, 
                    '💰 Enter the amount of SOL to buy (e.g., 0.5):');
                
                // Set up one-time listener for the amount
                this.bot.once('message', async (msg) => {
                    const amount = parseFloat(msg.text);
                    if (!isNaN(amount) && amount > 0) {
                        await this.executeBuy(msg.chat.id, token, amount);
                    } else {
                        await this.bot.sendMessage(msg.chat.id, 
                            '❌ Invalid amount. Please enter a valid number.');
                    }
                });
            }
        });
    }

    async sendHelp(chatId) {
        const helpMessage = `
🤖 Welcome to Wallet Tracker Bot!

Available Commands:
👥 Tracking:
/addwallet [address] - Add wallet to track
/wallets - List tracked wallets

💰 Portfolio:
/balance - Check your wallet balance

⚠️ Alerts will show:
- Token purchases from tracked wallets
- Quick buy options
- Risk analysis

Example:
/addwallet FZLt2wfpE5cxkHkxGwsoPjt4TxAQPzwjBWyuJDVqMKyN
`;
        await this.bot.sendMessage(chatId, helpMessage);
    }

    async getWalletBalance(chatId) {
        try {
            const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT);
            const pubKey = new PublicKey(this.walletAddress);
            const balance = await connection.getBalance(pubKey);
            const solBalance = balance / 1e9;
            const solPrice = await this.getSolPrice();

            const message = `
💰 Your Wallet Balance:
SOL: ${solBalance.toFixed(4)} (≈ $${(solBalance * solPrice).toFixed(2)})
Address: ${this.walletAddress}
`;
            await this.bot.sendMessage(chatId, message);
        } catch (error) {
            console.error('Error fetching wallet balance:', error);
            await this.bot.sendMessage(chatId, 'Error fetching wallet balance');
        }
    }

    async getSolPrice() {
        try {
            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            return response.data.solana.usd;
        } catch (error) {
            console.error('Error fetching SOL price:', error);
            return 0;
        }
    }

    async addWalletToTrack(chatId, wallet) {
        try {
            await this.walletTracker.addWallet(wallet);
            await this.bot.sendMessage(chatId, `✅ Wallet added to tracking: ${wallet}`);
        } catch (error) {
            await this.bot.sendMessage(chatId, `❌ Failed to add wallet: ${error.message}`);
        }
    }

    async listTrackedWallets(chatId) {
        try {
            const wallets = this.walletTracker.trackedWallets;
            const message = wallets.length > 0 
                ? `📋 Tracked Wallets:\n${wallets.join('\n')}`
                : '📋 No wallets currently tracked';
            await this.bot.sendMessage(chatId, message);
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Failed to list wallets');
        }
    }

    async sendWalletAlert(alert) {
        try {
            const solPrice = await this.getSolPrice();
            const totalUsdAmount = alert.totalAmount * solPrice;
            
            const message = `
🚨 ALPHA: ${alert.buyers.length} wallets bought ${alert.token}! 🚨

🔹 Memecoin: ${alert.token}
🔹 Contract Address: ${alert.contract.slice(0, 4)}...${alert.contract.slice(-4)}
💰 Total Volume: ${alert.totalAmount.toFixed(2)} SOL ($${totalUsdAmount.toFixed(2)})

🛒 Wallets Detected:
${alert.buyers.map((buyer, i) => 
    `${i+1}️⃣ Wallet: ${buyer.wallet.slice(0, 4)}...${buyer.wallet.slice(-6)} → Amount: ${buyer.amount.toFixed(2)} SOL ($${buyer.usdAmount.toFixed(2)})`
).join('\n')}

⏰ Time Frame: ${alert.timeFrame}
⚡ Quick Buy Options:`;

            const buyButtons = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Buy 0.4 SOL", callback_data: `buy_${alert.token}_0.4` }],
                        [{ text: "Custom Amount", callback_data: `buy_${alert.token}_custom` }]
                    ]
                }
            };

            await this.bot.sendMessage(this.chatId, message, buyButtons);
        } catch (error) {
            console.error('Error sending wallet alert:', error);
            await this.bot.sendMessage(this.chatId, '❌ Error processing alert');
        }
    }

    async sendWelcomeMessage() {
        const message = `
🤖 Wallet Tracker Bot Started! 🚀

Commands:
/help - Show available commands
/addwallet <address> - Track a new wallet
/wallets - List tracked wallets
/balance - Check wallet balance

Monitoring ${this.walletTracker.trackedWallets.length} wallets for memecoin purchases.
`;
        await this.bot.sendMessage(this.chatId, message);
    }
}

module.exports = TelegramHandler; 