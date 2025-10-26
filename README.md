# 🚀 HyperTrade - Real-Time Smart Wallet Copy Trading

> **Powered by Envio HyperSync** - Ultra-fast blockchain data streaming for instant trade execution

A sophisticated quantitative trading system that monitors and automatically copies trades from profitable "smart wallets" on Uniswap V3 in real-time. Built with Envio's HyperSync to demonstrate the power of millisecond-latency blockchain data access.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## 🎯 What is This?

HyperTrade is a **copy trading bot** that watches specific Ethereum wallets known for profitable trading patterns. When these "smart wallets" make a trade on Uniswap V3, the bot instantly detects and replicates the trade, allowing you to follow successful traders automatically.

**The HyperSync Advantage**: Traditional blockchain monitoring requires either running expensive nodes or using slow APIs. HyperSync provides **real-time blockchain data streaming** that's orders of magnitude faster than conventional methods, enabling truly instant trade execution.

## ⚡ Why HyperSync?

This project showcases HyperSync as a **game-changer for DeFi trading applications**:

| Traditional Approach | **HyperSync** |
|---------------------|---------------|
| 3-15 seconds block delay | **< 1 second** real-time streaming |
| Requires running full nodes | **Zero infrastructure** needed |
| Limited historical queries | **Instant** historical data access |
| Complex RPC setup | **One API call** setup |
| Rate limits & timeouts | **Unlimited throughput** |

### Real-World Impact

- **Speed Matters**: In copy trading, being 1-2 seconds faster can mean the difference between profit and loss
- **Historical Analysis**: Quickly scan thousands of blocks to backtest strategies
- **Cost Effective**: No need to run expensive Ethereum nodes or pay for premium RPC endpoints
- **Reliability**: Enterprise-grade infrastructure with 99.9% uptime

## ✨ Features

### 🎨 Beautiful Terminal Interface (TUI)
- **Live Feed**: Real-time display of all blockchain swaps and detected trades
- **Position Tracking**: Monitor your current position with P&L updates
- **Account Summary**: Complete trading history with win rate and statistics
- **Interactive**: Full keyboard controls for navigation and mode switching

### 🤖 Smart Trading Modes

#### 1. **Smart Wallet Mode** (Default)
- Follows specific pre-configured profitable wallets
- Only copies trades that meet minimum size requirements
- Ideal for real money trading

#### 2. **Demo Mode** (Press 'd' to toggle)
- Follows ALL buy trades on the pool
- Perfect for testing and learning
- Lower trade size threshold for more action

### 📊 Complete Account Management
- Track balance, P&L, and trade history
- Automatic position management with configurable hold duration
- Persistent state (survives restarts)
- Detailed trade analytics

### ⚙️ Highly Configurable
- Customizable smart wallet addresses to follow
- Adjustable risk parameters (trade size, hold duration)
- Support for multiple Uniswap V3 pools
- Flexible starting block for historical analysis

## 🚀 Quick Start

### Prerequisites
```bash
node >= 18.0.0
pnpm (or npm)
```

### Installation

1. **Clone the repository**
```bash
git clone <your-repo-url>
cd HyperTrade
```

2. **Install dependencies**
```bash
pnpm install
```

3. **Set up environment variables** (REQUIRED)

Copy the example environment file and add your HyperSync token:
```bash
cp .env.example .env
```

Then edit `.env` and add your HyperSync bearer token:
```bash
# .env
HYPERSYNC_URL=https://eth.hypersync.xyz
HYPERSYNC_BEARER=your-actual-token-here
```

**Get your free HyperSync token at: [https://envio.dev](https://envio.dev)**

> 🔒 **Security Note**: The `.env` file is gitignored and will never be committed to your repository. Never share your token publicly!

4. **Configure trading settings** (optional)

Edit `smart_wallets_tui.js` to customize:
```javascript
const CONFIG = {
  // Add smart wallets you want to follow
  smartWallets: [
    "0x56fc0708725a65ebb633efdaec931c0600a9face",
    // Add more addresses...
  ],
  
  // Trading parameters
  minTradeSize: 0.1,        // Minimum ETH to copy
  holdDuration: 120,         // Seconds to hold position
  initialBalance: 10000,     // Starting USD balance
};
```

5. **Run the bot**
```bash
# Run the full TUI version
pnpm start

# Or run the simple console version
pnpm run simple
```

## 🎮 Controls & Usage

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `d` | Toggle between Smart-Wallet and Demo modes |
| `↑` / `k` | Scroll live feed up |
| `↓` / `j` | Scroll live feed down |
| `PgUp` / `PgDn` | Fast scroll feed |
| `Home` / `g` | Jump to top of feed |
| `End` / `G` | Jump to bottom of feed |
| `a` / `z` | Scroll account summary |
| `q` / `Esc` / `Ctrl+C` | Quit application |

### Understanding the Display

```
┌─ LIVE FEED ─────────────────┐  ┌─ CURRENT POSITION ────┐
│ [HYPERSYNC] Block updates   │  │ Pool: USDC/WETH       │
│ [SWAP] Background trades    │  │ Action: BUY 0.5 ETH   │
│ [TARGET] Smart wallet found │  │ Entry: $3,245.00      │
│ [AUTO-FOLLOW] Trade copied  │  │ P&L: +$125.50 (+3.8%) │
└─────────────────────────────┘  └───────────────────────┘
                                  ┌─ ACCOUNT SUMMARY ─────┐
                                  │ Balance: $10,125.50   │
                                  │ Win Rate: 65.5%       │
                                  │ Recent Trades...      │
                                  └───────────────────────┘
```

### Status Indicators

- 🟢 **LIVE**: Fully synced, monitoring in real-time
- 🟡 **NEAR-LIVE**: Within 10 blocks of chain tip
- 🔵 **SYNCING**: Catching up to current block height

## 🎓 How It Works

### 1. **HyperSync Connection**
```javascript
const client = HypersyncClient.new({
  url: "https://eth.hypersync.xyz",
  bearerToken: "your-token",
});
```

### 2. **Real-Time Monitoring**
The bot continuously streams Uniswap V3 swap events:
```javascript
{
  fromBlock: currentBlock,
  logs: [{
    address: [UNISWAP_POOLS],
    topics: [[SWAP_EVENT]],
  }],
}
```

### 3. **Smart Detection**
When a swap is detected, the bot checks if it's from a tracked wallet:
```javascript
const isSmartWallet = CONFIG.smartWallets.includes(transaction.from);
if (isSmartWallet && tradeSize >= minSize) {
  // Copy the trade!
}
```

### 4. **Instant Execution**
Position is opened immediately with the same entry price:
```javascript
account.openPosition(side, ethAmount, usdcAmount, price);
```

### 5. **Automatic Exit**
After the configured hold duration, position closes automatically:
```javascript
if (elapsed >= CONFIG.holdDuration) {
  account.closePosition(currentPrice);
}
```

## 📈 Demo Mode - Try It Risk-Free

Press `d` to activate Demo Mode and see the bot in action:

- ✅ Follows **ALL buy trades** on the pool (not just smart wallets)
- ✅ Lower trade size threshold (0.005 ETH vs 0.1 ETH)
- ✅ Perfect for learning and testing
- ✅ No real money at risk

This mode demonstrates how HyperSync can monitor and react to every single trade happening on-chain in real-time.

## 🏗️ Technical Architecture

### Components

1. **HyperSync Client**: Ultra-fast blockchain data streaming
2. **Event Decoder**: Parses Uniswap V3 swap events
3. **Account Manager**: Tracks balance, positions, and P&L
4. **TUI Manager**: Beautiful terminal interface with blessed
5. **Trading Bot**: Core logic for detection and execution

### Data Flow

```
HyperSync → Event Detection → Smart Wallet Filter → Trade Execution → Position Management → UI Update
    ↓                                                                          ↓
Historical Sync                                                         Live Updates
(Fast Catch-up)                                                      (Real-time Stream)
```

### Why This Architecture Works

- **Stateless**: No database required, state persists to JSON
- **Efficient**: Only processes relevant events (Swap on specific pools)
- **Fast**: HyperSync enables <1s latency from on-chain to execution
- **Reliable**: Automatic error handling and reconnection

## 🔧 Advanced Configuration

### Adding More Pools

```javascript
pools: [
  "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", // USDC/WETH 0.3%
  "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", // USDC/WETH 0.05%
],

poolDecimals: {
  "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8": { token0: 6, token1: 18 },
  "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640": { token0: 6, token1: 18 },
},
```

### Risk Management

```javascript
minTradeSize: 0.1,        // Don't copy tiny trades
holdDuration: 120,        // Quick in-and-out (2 minutes)
riskPerTrade: 0.02,       // Risk 2% per trade
initialBalance: 10000,    // Starting with $10k
```

### Debug Mode

Enable detailed logging for troubleshooting:
```javascript
enableDebugLog: true,     // Writes to debug.log
```

## 🎯 Use Cases

This project demonstrates HyperSync's potential for:

1. **Copy Trading Platforms**: Build services that let users follow expert traders
2. **MEV Protection**: Detect and react to sandwich attacks in real-time
3. **Market Analysis**: Monitor whale wallets and large trades
4. **Arbitrage Bots**: Spot price discrepancies across DEXs instantly
5. **Risk Management**: Track your own positions across multiple wallets
6. **Trading Alerts**: Get notified when specific wallets make moves

## 🏆 HyperSync Benefits Demonstrated

✅ **Speed**: From block finality to bot reaction in <1 second  
✅ **Simplicity**: 20 lines of code to start streaming blockchain data  
✅ **Scalability**: Monitor unlimited wallets/pools without performance degradation  
✅ **Historical Access**: Instantly query and analyze past 5000+ blocks  
✅ **Cost Effective**: No infrastructure costs, pay only for what you use  
✅ **Reliability**: Production-grade uptime and error handling  

## 📊 Project Stats

- **Lines of Code**: ~850
- **Dependencies**: Minimal (HyperSync SDK, blessed for TUI, ethers for utilities)
- **Startup Time**: < 2 seconds
- **Memory Usage**: < 50MB
- **Data Latency**: < 1 second from on-chain event to bot detection

## 🤝 Contributing

This is a hackathon project, but contributions are welcome! Feel free to:

- Add support for more DEXs (Curve, Balancer, etc.)
- Implement advanced trading strategies
- Improve the UI/UX
- Add backtesting capabilities
- Create a web dashboard

## 📄 License

MIT License - Feel free to use this project as a starting point for your own trading bots!

## 🙏 Acknowledgments

- **Envio Team** for building HyperSync - the fastest way to access blockchain data
- **Uniswap** for the decentralized trading infrastructure
- **Ethereum** for making this all possible

## 🔗 Links

- [HyperSync Documentation](https://docs.envio.dev/docs/hypersync)
- [Get HyperSync API Token](https://envio.dev)
- [Uniswap V3 Documentation](https://docs.uniswap.org/protocol/concepts/V3-overview/concentrated-liquidity)

---

**Built for ETHGlobal 2025** - Showcasing the power of Envio HyperSync 🚀

*Disclaimer: This is a demonstration project for educational purposes. Do not use with real funds without proper testing and risk management.*

