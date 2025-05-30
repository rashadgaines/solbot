const { Telegraf } = require('telegraf');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const Logger = require('../utils/logger');

class TelegramHandler {
    constructor(bot, chatId, walletTracker) {
        this.bot = bot;
        this.chatId = chatId || process.env.TELEGRAM_CHAT_ID;
        this.walletTracker = walletTracker;
        this.commandCooldowns = new Map();
        this.COOLDOWN_PERIOD = 5000; // 5 seconds between commands
        this.initializeCommands();
        this.initializeHandlers();
        this.bot.launch();
    }

    async handleCommand(ctx, command, handler) {
        const chatId = ctx.chat.id;
        const cooldownKey = `${chatId}-${command}`;
        const lastUsed = this.commandCooldowns.get(cooldownKey) || 0;
        const now = Date.now();

        if (now - lastUsed < this.COOLDOWN_PERIOD) {
            await ctx.reply('⚠️ Please wait a few seconds between commands');
            return;
        }

        try {
            this.commandCooldowns.set(cooldownKey, now);
            await handler(ctx);
        } catch (error) {
            console.error(`Command error (${command}):`, error);
            await ctx.reply('❌ Command failed. Please try again.');
        }
    }

    initializeCommands() {
        // Help command
        this.bot.command('help', (ctx) => {
            this.handleCommand(ctx, 'help', () => this.sendHelp(ctx));
        });

        // Add wallet command with validation
        this.bot.hears(/\/addwallet (.+)/, (ctx) => {
            const match = ctx.message.text.match(/\/addwallet (.+)/);
            if (match) {
                this.handleCommand(ctx, 'addwallet', () => this.addWalletToTrack(ctx, match[1]));
            }
        });

        // List tracked wallets
        this.bot.command('wallets', (ctx) => {
            this.listTrackedWallets(ctx);
        });
    }

    initializeHandlers() {
        this.walletTracker.on('walletUpdate', async (update) => {
            if (update.memecoinTransactions?.length > 0) {
                await this.sendMemecoinAlert(update);
            }
        });
    }

    async sendHelp(ctx) {
        const helpMessage = `
🤖 Welcome to Wallet Tracker Bot!

Available Commands:
👥 Tracking:
/addwallet [address] - Add wallet to track
/wallets - List tracked wallets

⚠️ Alerts will show:
- Token purchases from tracked wallets
- Purchase amounts and timing

Example:
/addwallet FZLt2wfpE5cxkHkxGwsoPjt4TxAQPzwjBWyuJDVqMKyN
`;
        await ctx.reply(helpMessage);
    }

    async getWalletBalance(ctx) {
        try {
            if (!this.walletAddress) {
                await ctx.reply('❌ No wallet address configured');
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

            await ctx.reply(message);
        } catch (error) {
            console.error('Error fetching wallet balance:', error);
            await ctx.reply('❌ Error fetching wallet balance');
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

    async addWalletToTrack(ctx, wallet) {
        try {
            await this.walletTracker.addWallet(wallet);
            await ctx.reply(`✅ Wallet added to tracking: ${wallet}`);
        } catch (error) {
            await ctx.reply(`❌ Failed to add wallet: ${error.message}`);
        }
    }

    async listTrackedWallets(ctx) {
        try {
            const wallets = this.walletTracker.trackedWallets;
            const message = wallets.length > 0 
                ? `📋 Tracked Wallets:\n${wallets.join('\n')}`
                : '📋 No wallets currently tracked';
            await ctx.reply(message);
        } catch (error) {
            await ctx.reply('❌ Failed to list wallets');
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
                await this.bot.telegram.sendMessage(this.chatId, message, {
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
        await this.bot.telegram.sendMessage(this.chatId, message);
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

            await this.bot.telegram.sendMessage(this.chatId, message, {
                parse_mode: 'HTML',
                reply_markup: inlineKeyboard
            });
        } catch (error) {
            console.error('Error sending token alert:', error);
        }
    }
}

module.exports = TelegramHandler; 