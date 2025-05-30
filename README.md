# Solana Wallet Tracker

The solana memecoin craze inspired me to create a very simple telegram alert system that tracked active "whales" in an alpha seeking effort. 


## Setup
1. Clone repo & install dependencies:
   ```bash
   git clone <repo-url>
   cd solana-wallet-tracker
   npm install
   ```
2. Add your Telegram bot token and RPC endpoints to `.env`.
3. Add wallet addresses to `tracked-wallets.json` (replace template values).

## Usage
- Start: `npm start`
- Dev: `npm run dev`
- Commands:
  - `/help` — Show help
  - `/addwallet [address]` — Add wallet
  - `/wallets` — List tracked wallets

## Security
- Never commit secrets or real wallet addresses.
- `.env` and `tracked-wallets.json` are in `.gitignore`.
- All user input is validated.

## Features
- Tracks all wallets in `tracked-wallets.json`
- Sends Telegram alerts for tracked wallet activity
- Smart endpoint selection using ML-based predictions

MIT License