const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const Logger = require('../utils/logger');

class TelegramHandler {
    constructor(bot, chatId, walletAddress, walletTracker) {
        this.bot = bot;
        this.chatId = chatId || process.env.TELEGRAM_CHAT_ID;
        this.walletAddress = walletAddress || process.env.WALLET_ADDRESS;
        this.walletTracker = walletTracker;
        this.commandCooldowns = new Map();
        this.COOLDOWN_PERIOD = 5000; // 5 seconds between commands
        this.initializeCommands();
        this.initializeHandlers();
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

    initializeHandlers() {
        this.walletTracker.on('walletUpdate', async (update) => {
            if (update.memecoinTransactions?.length > 0) {
                await this.sendMemecoinAlert(update);
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
- Purchase amounts and timing
- Multiple wallet correlation

Example:
/addwallet FZLt2wfpE5cxkHkxGwsoPjt4TxAQPzwjBWyuJDVqMKyN
`;
        await this.bot.sendMessage(chatId, helpMessage);
    }

    async getWalletBalance(chatId) {
        try {
            if (!this.walletAddress) {
                await this.bot.sendMessage(chatId, '❌ No wallet address configured');
                return;
            }

            const balance = await this.walletTracker.getWalletBalance(this.walletAddress);
            const solPrice = await this.getSolPrice();
            const solBalance = balance / 1e9; // Convert lamports to SOL
            const usdBalance = solBalance * solPrice;

            const message = `
💰 Wallet Balance:
${solBalance.toFixed(4)} SOL ($${usdBalance.toFixed(2)} USD)
🏦 Wallet: ${this.walletAddress.slice(0, 4)}...${this.walletAddress.slice(-4)}`;

            await this.bot.sendMessage(chatId, message);
        } catch (error) {
            console.error('Error fetching wallet balance:', error);
            await this.bot.sendMessage(chatId, '❌ Error fetching wallet balance');
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

    async sendMemecoinAlert(update) {
        if (!update.memecoinTransactions || update.memecoinTransactions.length === 0) {
            return;
        }

        for (const tx of update.memecoinTransactions) {
            if (!tx || !tx.tokenAddress) {
                Logger.error('Invalid transaction data:', tx);
                continue;
            }

            const message = `
🚨 ALPHA: Wallet Activity 🚨

👛 Wallet: ${update.wallet.slice(0, 4)}...${update.wallet.slice(-4)}
⏰ Time: ${new Date(tx.timestamp).toLocaleString()}

📊 Links:
• Token: https://solscan.io/token/${tx.tokenAddress}
• Chart: https://dexscreener.com/solana/${tx.tokenAddress}
• Transaction: https://solscan.io/tx/${tx.signature}

By VLX Capital`;

            try {
                Logger.info(`Sending Telegram alert for transaction: ${tx.signature}`);
                await this.bot.sendMessage(this.chatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
                Logger.success(`Successfully sent Telegram alert for: ${tx.signature}`);
            } catch (error) {
                Logger.error(`Error sending Telegram alert: ${error.message}`);
            }
        }
    }

    async sendWelcomeMessage() {
        const message = `
🤖 Wallet Tracker Bot Started!

Monitoring ${this.walletTracker.trackedWallets.length} wallets for memecoin activity.
`;
        await this.bot.sendMessage(this.chatId, message);
    }

    async sendTokenAlert(alert) {
        try {
            const message = `
🔔 New Token Detected! 🔔

👛 Wallet: ${alert.wallet.slice(0, 4)}...${alert.wallet.slice(-4)}
🪙 Token Contract: ${alert.token.contract}
💰 Amount: ${alert.token.amount.toFixed(2)}
💵 Est. Value: $${alert.token.usdValue.toFixed(2)}

🔍 Links:
• Token: ${alert.tokenUrl}
${alert.url ? `• Transaction: ${alert.url}` : ''}

⚠️ DYOR - Not financial advice`;

            const inlineKeyboard = {
                inline_keyboard: [
                    [
                        { text: '🔍 View Token', url: alert.tokenUrl },
                        { text: '📊 Chart', url: `https://dexscreener.com/solana/${alert.token.contract}` }
                    ]
                ]
            };

            if (alert.url) {
                inlineKeyboard.inline_keyboard[0].push(
                    { text: '🔎 Transaction', url: alert.url }
                );
            }

            await this.bot.sendMessage(this.chatId, message, {
                parse_mode: 'HTML',
                reply_markup: inlineKeyboard
            });
        } catch (error) {
            console.error('Error sending token alert:', error);
        }
    }
}

module.exports = TelegramHandler; 