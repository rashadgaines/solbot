# Solana Wallet Tracker

A real-time monitoring system for tracking Solana active "whale" wallet activities. Built with Node.js and Telegram integration.

## Features

-  Real-time wallet monitoring
-  Instant Telegram alerts for memecoin transactions
-  Smart RPC endpoint management with failover
-  Adaptive rate limiting
-  Performance metrics tracking
-  Circuit breaker pattern implementation

## Tech Stack

- **Runtime**: Node.js
- **Blockchain**: Solana Web3.js
- **Messaging**: Telegram Bot API
- **Rate Limiting**: Custom implementation with token bucket algorithm
- **Monitoring**: Custom metrics and health checks
- **Error Handling**: Emergency handler with circuit breaker pattern

## Prerequisites

- Node.js >= 16.0.0
- npm or yarn
- Telegram Bot Token
- Solana RPC endpoints

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/solana-wallet-tracker.git
cd solana-wallet-tracker
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:
```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
SOLANA_RPC_ENDPOINTS=endpoint1,endpoint2,endpoint3
```

## Configuration

The project uses environment variables for configuration. Create a `.env` file with the following variables:

- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
- `SOLANA_RPC_ENDPOINTS`: Comma-separated list of Solana RPC endpoints
- `ALERT_THRESHOLD`: Minimum transaction amount to trigger alerts (in SOL)
- `RATE_LIMIT_WINDOW`: Rate limiting window in milliseconds
- `MAX_REQUESTS_PER_WINDOW`: Maximum requests allowed per window

## Usage

1. Configure your environment variables
2. Add wallet addresses to `tracked-wallets.json`
3. Start the bot:
   - Production: `npm start`
   - Development: `npm run dev`
4. Use Telegram commands to interact:
   - `/help` - View available commands
   - `/addwallet [address]` - Track new wallet
   - `/wallets` - List tracked wallets

## Development

- `npm run dev`: Start in development mode with auto-reload
- `npm run lint`: Run ESLint
- `npm run format`: Format code with Prettier

## Architecture Highlights

- Multi-RPC endpoint support with automatic failover
- Adaptive rate limiting to prevent API throttling
- Caching layer for optimized performance
- Event-driven architecture for real-time updates
- Emergency handling system for critical failures

## Performance Features

- Smart request batching and queuing
- Automatic RPC endpoint health monitoring
- Predictive endpoint selection using simple ML
- Efficient caching with TTL
- Adaptive delay calculations based on rate limits



## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.

© 2024 VLX Capital. All rights reserved.

## Security: Network & Code Hygiene

- **Restrict Outbound Connections:** Only allow connections to Telegram, Solana RPC endpoints, and required APIs (e.g., CoinGecko) using firewall or cloud security groups.
- **Run as Non-root:** Deploy the bot as a non-root user for least privilege.
- **Environment Variables:** Store all secrets (API keys, tokens, wallet addresses) in `.env` and never commit them to version control.
- **Input Validation:** All user input (e.g., wallet addresses) is validated before processing.
- **Error Handling:** Errors are logged, but sensitive info is never shown to users.
- **Dependency Updates:** Regularly run `npm audit` and `npm update` to keep dependencies secure.
- **Bot Permissions:** Only grant the Telegram bot the minimum permissions needed.
- **Logging & Monitoring:** Use logging and monitor for unusual activity in production.
