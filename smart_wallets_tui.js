/**
 * Smart Wallet Copy Trading - TUI Version
 * Real-time monitoring and auto-trading with beautiful terminal interface
 * 
 * This application monitors blockchain transactions in real-time using HyperSync,
 * detects trades from profitable "smart wallets", and automatically copies them.
 * 
 * Features:
 * - Real-time blockchain monitoring with <1s latency
 * - Beautiful terminal UI with live updates
 * - Automatic trade execution and position management
 * - Two modes: Smart-Wallet (production) and Demo (testing)
 */

import 'dotenv/config';  // Load environment variables from .env file
import blessed from 'blessed';  // Terminal UI library
import {
  HypersyncClient,
  LogField,
  BlockField,
  TransactionField,
  JoinMode,
  Decoder,
} from "@envio-dev/hypersync-client";  // Ultra-fast blockchain data streaming
import { keccak256, toUtf8Bytes } from "ethers";  // Crypto utilities
import fs from 'fs';  // File system for logs and state persistence

// ========== Configuration ==========

const CONFIG = {
  // HyperSync API settings (loaded from .env file)
  hypersyncUrl: process.env.HYPERSYNC_URL || "https://eth.hypersync.xyz",
  bearerToken: process.env.HYPERSYNC_BEARER,  // Required: Get from envio.dev
  
  // Uniswap V3 pools to monitor
  pools: [
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", // Uniswap V3 USDC/WETH 0.3%
  ],
  
  // Token decimals for each pool (needed for price calculation)
  poolDecimals: {
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8": { 
      token0: 6,   // USDC has 6 decimals
      token1: 18,  // WETH has 18 decimals
    },
  },
  
  // "Smart wallets" to follow - addresses known for profitable trading
  // Add more addresses to follow multiple traders
  smartWallets: [
    "0x56fc0708725a65ebb633efdaec931c0600a9face",
  ].map(addr => addr.toLowerCase()),  // Normalize to lowercase
  
  // Trading strategy parameters
  minTradeSize: 0.1,        // Minimum 0.1 ETH to follow (ignore smaller trades)
  holdDuration: 120,         // Hold position for 120 seconds before closing
  startBlocksBack: 5000,     // How many historical blocks to scan on startup
  
  // Account settings (simulated trading)
  initialBalance: 10000,     // Start with $10,000 virtual balance
  riskPerTrade: 0.02,        // Risk 2% per trade (for future risk management)
  
  // Debug settings
  enableDebugLog: false,     // Set to true to write verbose logs to debug.log
};

// ========== Event Setup ==========

// Uniswap V3 Swap event signature
const SWAP_SIGNATURE = "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
// Pre-compute the topic0 hash for efficient filtering
const SWAP_TOPIC0 = keccak256(toUtf8Bytes("Swap(address,address,int256,int256,uint160,uint128,int24)")).toLowerCase();
// Create decoder to parse event logs
const decoder = Decoder.fromSignatures([SWAP_SIGNATURE]);

// ========== Helper Functions ==========

/**
 * Calculate USD price per ETH from Uniswap V3's sqrtPriceX96
 * @param {BigInt} sqrtPriceX96 - Square root of price * 2^96 (Uniswap V3 format)
 * @param {number} decimals0 - Token0 decimals (USDC = 6)
 * @param {number} decimals1 - Token1 decimals (WETH = 18)
 * @returns {number} Price in USDC per ETH
 */
function calculatePrice(sqrtPriceX96, decimals0 = 6, decimals1 = 18) {
  const Q192 = 2n ** 192n;  // Q192 constant from Uniswap V3
  // Calculate price token1/token0
  const priceToken1PerToken0 = Number((sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** decimals0)) / Q192) / (10 ** decimals1);
  // Invert to get USDC per ETH
  return 1 / priceToken1PerToken0;
}

/**
 * Convert BigInt amount to decimal float
 * @param {BigInt} bigIntValue - Raw token amount
 * @param {number} decimals - Token decimals
 * @returns {number} Formatted decimal amount
 */
function formatAmount(bigIntValue, decimals) {
  const absValue = bigIntValue < 0n ? -bigIntValue : bigIntValue;
  const valueStr = absValue.toString().padStart(decimals + 1, '0');
  return parseFloat(valueStr.slice(0, -decimals) + '.' + valueStr.slice(-decimals));
}

/**
 * Get current time as formatted string
 * @returns {string} Localized time string
 */
function formatTime() {
  return new Date().toLocaleTimeString();
}

/**
 * Format PnL percentage with color
 * @param {number} pnl - PnL percentage
 * @returns {string} Colored string for blessed UI
 */
function formatPnL(pnl) {
  const sign = pnl >= 0 ? '+' : '';
  const color = pnl >= 0 ? '{green-fg}' : '{red-fg}';
  return `${color}${sign}${pnl.toFixed(2)}%{/}`;
}

// ========== Account Manager ==========

/**
 * Manages trading account state including balance, positions, and trade history
 * Persists state to disk to survive restarts
 */
class AccountManager {
  /**
   * Initialize account with starting balance
   * @param {number} initialBalance - Starting USD balance
   */
  constructor(initialBalance) {
    this.balance = initialBalance;
    this.initialBalance = initialBalance;
    this.trades = [];  // Complete trade history
    this.currentPosition = null;  // Active position (only one at a time)
    this.loadState();  // Load previous state if exists
  }

  /**
   * Load saved account state from disk
   * Allows bot to resume after restart without losing trade history
   */
  loadState() {
    try {
      if (fs.existsSync('account_state.json')) {
        const state = JSON.parse(fs.readFileSync('account_state.json', 'utf8'));
        this.balance = state.balance;
        this.trades = state.trades || [];
      }
    } catch (e) {
      // Ignore load errors - start fresh if file is corrupted
    }
  }

  /**
   * Save current account state to disk
   * Persists after each trade for data safety
   */
  saveState() {
    try {
      fs.writeFileSync('account_state.json', JSON.stringify({
        balance: this.balance,
        trades: this.trades,
      }, null, 2));
    } catch (e) {
      // Ignore save errors - not critical
    }
  }

  /**
   * Open a new trading position
   * @param {string} side - "BUY" or "SELL"
   * @param {number} ethAmount - Amount of ETH in the trade
   * @param {number} usdcAmount - Amount of USDC in the trade
   * @param {number} price - Entry price (USDC per ETH)
   * @returns {Object} The opened position
   */
  openPosition(side, ethAmount, usdcAmount, price) {
    const usdValue = usdcAmount;
    // Normalize side immediately when opening position to avoid comparison issues
    const normalizedSide = side.trim().toUpperCase();
    
    if (CONFIG.enableDebugLog) {
      console.log(`[DEBUG] Opening position:`, {
        originalSide: `"${side}"`,
        normalizedSide: `"${normalizedSide}"`,
        price: price
      });
    }
    
    this.currentPosition = {
      side: normalizedSide,  // "BUY" or "SELL" (normalized)
      ethAmount,
      usdcAmount,
      entryPrice: price,
      openedAt: Date.now(),
      usdValue,
    };
    return this.currentPosition;
  }

  /**
   * Close the current position and calculate PnL
   * @param {number} exitPrice - Exit price (USDC per ETH)
   * @returns {Object|null} The closed trade with PnL, or null if no position
   */
  closePosition(exitPrice) {
    if (!this.currentPosition) return null;

    // Normalize side: trim and convert to uppercase to handle any format
    const side = this.currentPosition.side.trim().toUpperCase();
    
    // Debug logging (only if enabled)
    if (CONFIG.enableDebugLog) {
      console.log(`[DEBUG] Closing position:`, {
        side: `"${this.currentPosition.side}"`,
        sideLength: this.currentPosition.side.length,
        normalized: `"${side}"`,
        normalizedLength: side.length,
        entryPrice: this.currentPosition.entryPrice,
        exitPrice: exitPrice,
        isBuy: side === 'BUY',
        comparison: `"${side}" === "BUY" is ${side === 'BUY'}`
      });
    }
    
    // Calculate PnL based on position side
    let pnl;
    if (side === 'BUY') {
      // For BUY: profit when price goes up
      pnl = (exitPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice;
      if (CONFIG.enableDebugLog) {
        console.log(`[DEBUG] Using BUY formula: (${exitPrice} - ${this.currentPosition.entryPrice}) / ${this.currentPosition.entryPrice} = ${pnl}`);
      }
    } else {
      // For SELL: profit when price goes down
      pnl = (this.currentPosition.entryPrice - exitPrice) / this.currentPosition.entryPrice;
      if (CONFIG.enableDebugLog) {
        console.log(`[DEBUG] Using SELL formula: (${this.currentPosition.entryPrice} - ${exitPrice}) / ${this.currentPosition.entryPrice} = ${pnl}`);
      }
    }

    const pnlUsd = this.currentPosition.usdValue * pnl;
    
    if (CONFIG.enableDebugLog) {
      console.log(`[DEBUG] PnL calculation:`, {
        pnl: pnl,
        pnlPercent: (pnl * 100).toFixed(2) + '%',
        pnlUsd: pnlUsd.toFixed(2)
      });
    }
    
    // Update balance
    this.balance += pnlUsd;

    // Create trade record
    const trade = {
      id: this.trades.length + 1,
      ...this.currentPosition,
      side: side, // Store normalized side
      exitPrice,
      closedAt: Date.now(),
      pnl,
      pnlUsd,
      duration: Math.floor((Date.now() - this.currentPosition.openedAt) / 1000),
    };

    this.trades.push(trade);
    this.currentPosition = null;
    this.saveState();  // Persist state after closing position

    return trade;
  }

  /**
   * Get account statistics and recent trade history
   * @returns {Object} Stats including balance, win rate, and recent trades
   */
  getStats() {
    const totalTrades = this.trades.length;
    const winningTrades = this.trades.filter(t => t.pnl > 0).length;
    const totalPnlUsd = this.trades.reduce((sum, t) => sum + t.pnlUsd, 0);
    const totalPnlPercent = (this.balance - this.initialBalance) / this.initialBalance * 100;

    return {
      balance: this.balance,
      totalTrades,
      winRate: totalTrades > 0 ? (winningTrades / totalTrades * 100) : 0,
      totalPnlUsd,
      totalPnlPercent,
      recentTrades: this.trades.slice(-10).reverse(),  // Last 10 trades, newest first
    };
  }
}

// ========== TUI Manager ==========

/**
 * Manages the terminal user interface using blessed library
 * Creates and updates three main panels: Live Feed, Current Position, and Account Summary
 */
class TUIManager {
  /**
   * Initialize the TUI with blessed screen
   */
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,  // Smart cursor positioning for better performance
      title: 'Smart Wallet Copy Trading'
    });

    this.createLayout();  // Create UI panels
    this.setupHandlers();  // Setup keyboard handlers
  }

  /**
   * Create the three-panel layout:
   * - Header: Status bar with balance and block info
   * - Left: Live feed of blockchain events
   * - Right Top: Current position details
   * - Right Bottom: Account summary and trade history
   */
  createLayout() {
    // Header
    this.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '>>> SMART WALLET COPY TRADING SYSTEM | Powered by HyperSync <<<',
      tags: true,
      border: { type: 'line' },
      style: {
        fg: 'white',
        bg: 'blue',
        border: { fg: 'blue' }
      }
    });

    // Live feed (left side)
    this.feedBox = blessed.box({
      top: 3,
      left: 0,
      width: '50%',
      height: '100%-3',
      label: ' [LIVE FEED] ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        ch: ' ',
        bg: 'blue'
      }
    });

    // Current position (right top)
    this.positionBox = blessed.box({
      top: 3,
      left: '50%',
      width: '50%',
      height: 12,
      label: ' [CURRENT POSITION] ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } }
    });

    // Account summary (right bottom)
    this.accountBox = blessed.box({
      top: 15,
      left: '50%',
      width: '50%',
      height: '100%-15',
      label: ' [ACCOUNT SUMMARY] ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'green' } },
      scrollable: true,
    });

    this.screen.append(this.header);
    this.screen.append(this.feedBox);
    this.screen.append(this.positionBox);
    this.screen.append(this.accountBox);
  }

  setupHandlers() {
    this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
    this.feedLines = [];
    
    // Mode toggle callback (will be set by TradingBot)
    this.onModeToggle = null;
    this.screen.key(['d'], () => {
      if (this.onModeToggle) this.onModeToggle();
    });
    
    // Scroll controls for Live Feed
    this.screen.key(['up', 'k'], () => {
      this.feedBox.scroll(-1);
      this.screen.render();
    });
    
    this.screen.key(['down', 'j'], () => {
      this.feedBox.scroll(1);
      this.screen.render();
    });
    
    this.screen.key(['pageup'], () => {
      this.feedBox.scroll(-10);
      this.screen.render();
    });
    
    this.screen.key(['pagedown'], () => {
      this.feedBox.scroll(10);
      this.screen.render();
    });
    
    // Go to top/bottom
    this.screen.key(['home', 'g'], () => {
      this.feedBox.scrollTo(0);
      this.screen.render();
    });
    
    this.screen.key(['end', 'G'], () => {
      this.feedBox.setScrollPerc(100);
      this.screen.render();
    });
    
    // Scroll account box too
    this.screen.key(['a'], () => {
      this.accountBox.scroll(-1);
      this.screen.render();
    });
    
    this.screen.key(['z'], () => {
      this.accountBox.scroll(1);
      this.screen.render();
    });
  }

  updateHeader(block, balance, status = 'LIVE', mode = 'SMART-WALLET') {
    const statusColor = status === 'LIVE' ? 'green-fg' : status === 'NEAR-LIVE' ? 'yellow-fg' : 'cyan-fg';
    const modeColor = mode === 'DEMO' ? 'yellow-fg' : 'cyan-fg';
    const content = `>>> SMART WALLET COPY TRADING SYSTEM | Powered by HyperSync <<< | Mode: {${modeColor}}${mode}{/} | Status: {${statusColor}}${status}{/} | Block: {cyan-fg}${block}{/} | Balance: {green-fg}$${balance.toFixed(2)}{/}`;
    this.header.setContent(content);
    this.screen.render();
  }

  addFeedLine(message) {
    const timestamp = `{gray-fg}[${formatTime()}]{/}`;
    this.feedLines.push(`${timestamp} ${message}`);
    if (this.feedLines.length > 100) {
      this.feedLines.shift();
    }
    this.feedBox.setContent(this.feedLines.join('\n'));
    this.feedBox.setScrollPerc(100);
    this.screen.render();
  }

  updatePosition(position, currentPrice) {
    if (!position) {
      this.positionBox.setContent('\n  {gray-fg}--- No active position ---{/}');
      this.screen.render();
      return;
    }

    const elapsed = Math.floor((Date.now() - position.openedAt) / 1000);
    const remaining = Math.max(0, CONFIG.holdDuration - elapsed);
    const progress = Math.min(100, (elapsed / CONFIG.holdDuration * 100)).toFixed(0);
    
    const pnl = position.side === 'BUY'
      ? (currentPrice - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - currentPrice) / position.entryPrice * 100;

    const pnlUsd = position.usdValue * (pnl / 100);
    const pnlColor = pnl >= 0 ? 'green-fg' : 'red-fg';
    const pnlSign = pnl >= 0 ? '+' : '';

    const content = `
  Pool:     {cyan-fg}USDC/WETH{/}
  Action:   {yellow-fg}${position.side}{/} ${position.ethAmount.toFixed(4)} ETH
  
  Entry:    $${position.entryPrice.toFixed(2)}
  Current:  $${currentPrice.toFixed(2)}
  Value:    $${position.usdValue.toFixed(2)}
  
  Time:     ${elapsed}s / ${CONFIG.holdDuration}s (${progress}%)
  Closes in: {cyan-fg}${remaining}s{/}
  
  Unrealized P&L:
  {${pnlColor}}${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnl.toFixed(2)}%){/}
`;

    this.positionBox.setContent(content);
    this.screen.render();
  }

  updateAccount(stats) {
    const { balance, totalTrades, winRate, totalPnlUsd, totalPnlPercent, recentTrades } = stats;

    let content = `
  Total Trades: {cyan-fg}${totalTrades}{/}
  Win Rate: {yellow-fg}${winRate.toFixed(1)}%{/}
  Total PnL: ${totalPnlUsd >= 0 ? '{green-fg}' : '{red-fg}'}$${totalPnlUsd.toFixed(2)}{/} (${formatPnL(totalPnlPercent)})

  {bold}=== Recent Trades ==={/bold}
`;

    if (recentTrades.length === 0) {
      content += `  {gray-fg}No trades yet{/}\n`;
    } else {
      recentTrades.forEach(trade => {
        const pnlColor = trade.pnl >= 0 ? '{green-fg}' : '{red-fg}';
        const icon = trade.pnl >= 0 ? '[WIN]' : '[LOSS]';
        const sign = trade.pnl >= 0 ? '+' : '';
        
        content += `\n  {bold}Trade #${trade.id}{/bold} ${pnlColor}${icon}{/}\n`;
        content += `  Action: {yellow-fg}${trade.side}{/} ${trade.ethAmount.toFixed(4)} ETH\n`;
        content += `  Entry:  $${trade.entryPrice.toFixed(2)} | Exit: $${trade.exitPrice.toFixed(2)}\n`;
        content += `  P&L:    ${pnlColor}${sign}$${trade.pnlUsd.toFixed(2)} (${sign}${(trade.pnl * 100).toFixed(2)}%){/}\n`;
        content += `  {gray-fg}Duration: ${trade.duration}s{/}\n`;
      });
    }

    this.accountBox.setContent(content);
    this.screen.render();
  }

  render() {
    this.screen.render();
  }
}

// ========== Main Trading Bot ==========

/**
 * Core trading bot that monitors blockchain, detects smart wallet trades, and executes copies
 * Uses HyperSync for real-time, high-speed blockchain data streaming
 */
class TradingBot {
  /**
   * Initialize the trading bot
   * @param {HypersyncClient} client - HyperSync client for blockchain data
   * @param {AccountManager} account - Account manager for positions and balance
   * @param {TUIManager} ui - Terminal UI manager for display
   */
  constructor(client, account, ui) {
    this.client = client;
    this.account = account;
    this.ui = ui;
    this.currentBlock = 0;
    this.lastPrice = null;  // Track last known price for position updates
    
    // Demo mode: follow all BUY trades, not just smart wallets (for testing)
    this.demoMode = false;
    
    // Statistics for live feed display
    this.stats = {
      totalBlocks: 0,
      totalSwaps: 0,
      matchedSwaps: 0,
      startTime: Date.now(),
      lastBlockTime: Date.now(),
    };
    
    // Setup mode toggle handler (press 'd' key)
    this.ui.onModeToggle = () => this.toggleMode();
  }
  
  /**
   * Toggle between SMART-WALLET mode and DEMO mode
   * SMART-WALLET: Only follow configured smart wallet addresses
   * DEMO: Follow ALL buy trades above threshold (for testing/demo)
   */
  toggleMode() {
    this.demoMode = !this.demoMode;
    const modeName = this.demoMode ? 'DEMO' : 'SMART-WALLET';
    const modeDesc = this.demoMode ? 'Following ALL buy trades' : 'Following smart wallets only';
    
    this.ui.addFeedLine(``);
    this.ui.addFeedLine(`{yellow-fg}[MODE SWITCH]{/} Switched to {bold}${modeName}{/} mode`);
    this.ui.addFeedLine(`  {gray-fg}${modeDesc}{/}`);
    this.ui.addFeedLine(``);
  }

  /**
   * Main bot loop - continuously stream and process blockchain data
   * This is where HyperSync's speed advantage shines:
   * - Historical sync: Processes thousands of blocks per second
   * - Live monitoring: <1 second latency from block finality to detection
   */
  async start() {
    const currentHeight = await this.client.getHeight();
    let fromBlock = currentHeight - CONFIG.startBlocksBack;

    this.ui.addFeedLine(`{green-fg}[HYPERSYNC]{/} Connected to HyperSync - Ultra-fast blockchain data engine`);
    this.ui.addFeedLine(`{green-fg}[SYSTEM]{/} Bot started successfully`);
    this.ui.addFeedLine(`{cyan-fg}[CONFIG]{/} Scanning from block ${fromBlock} (chain tip: ${currentHeight})`);
    this.ui.addFeedLine(`{cyan-fg}[CONFIG]{/} Tracking ${CONFIG.smartWallets.length} target wallet(s)`);
    this.ui.addFeedLine(`{cyan-fg}[CONFIG]{/} Min trade size: ${CONFIG.minTradeSize} ETH | Hold time: ${CONFIG.holdDuration}s`);
    this.ui.addFeedLine(``);
    this.ui.addFeedLine(`{yellow-fg}[HOTKEYS]{/} {bold}d{/}=DEMO mode | {bold}↑↓{/} or {bold}j/k{/}=Scroll | {bold}PgUp/PgDn{/}=Fast scroll`);
    this.ui.addFeedLine(`          {bold}Home/g{/}=Top | {bold}End/G{/}=Bottom | {bold}a/z{/}=Scroll account | {bold}q{/}=Quit`);
    this.ui.addFeedLine(``);

    const query = {
      fromBlock,
      logs: [{
        address: CONFIG.pools,
        topics: [[SWAP_TOPIC0]],
      }],
      fieldSelection: {
        block: [BlockField.Number, BlockField.Timestamp],
        log: [
          LogField.Address,
          LogField.Data,
          LogField.Topic0,
          LogField.Topic1,
          LogField.Topic2,
          LogField.Topic3,
          LogField.TransactionHash,
          LogField.BlockNumber,
        ],
        transaction: [TransactionField.From, TransactionField.Hash],
      },
      joinMode: JoinMode.JoinTransactions,
    };

    while (true) {
      try {
        const batchStartTime = Date.now();
        const res = await this.client.get(query);
        
        if (!res || !res.data) {
          this.ui.addFeedLine(`⏸  {gray-fg}Waiting for data...{/}`);
          await new Promise(resolve => setTimeout(resolve, 12000));
          continue;
        }

        const logs = res.data.logs || [];
        const transactions = res.data.transactions || [];
        const blocks = res.data.blocks || [];
        
        const chainHeight = await this.client.getHeight();
        const prevBlock = this.currentBlock;
        this.currentBlock = res.nextBlock || query.fromBlock;
        
        // Update statistics
        const blocksProcessed = Math.max(1, this.currentBlock - prevBlock);
        this.stats.totalBlocks += blocksProcessed;
        this.stats.totalSwaps += logs.length;
        
        // Calculate blocks behind (ensure non-negative)
        const behindTip = Math.max(0, chainHeight - this.currentBlock);
        const statusText = behindTip === 0 ? 'LIVE' : 
                          behindTip < 10 ? 'NEAR-LIVE' :
                          'SYNCING';
        const syncStatus = behindTip === 0 ? '{green-fg}LIVE{/}' : 
                          behindTip < 10 ? '{yellow-fg}NEAR-LIVE{/}' :
                          `{magenta-fg}SYNCING{/}`;
        
        // Update header with status and mode
        const modeText = this.demoMode ? 'DEMO' : 'SMART-WALLET';
        this.ui.updateHeader(this.currentBlock, this.account.balance, statusText, modeText);

        // Show scanning progress with real-time emphasis
        if (logs.length > 0) {
          this.ui.addFeedLine(`{cyan-fg}[HYPERSYNC]{/} Processed blocks ${prevBlock}-${this.currentBlock} | Found {cyan-fg}${logs.length} swaps{/} | Status: ${syncStatus} (-${behindTip})`);
        } else {
          // Show heartbeat even when no swaps (every 10 blocks or when at tip)
          if (blocksProcessed >= 10 || behindTip <= 2) {
            this.ui.addFeedLine(`{gray-fg}[HYPERSYNC]{/} Block ${this.currentBlock} synced | Status: ${syncStatus} (-${behindTip})`);
          }
        }

        // Build tx map
        const txMap = new Map();
        transactions.forEach(tx => {
          if (tx.hash) txMap.set(tx.hash.toLowerCase(), tx);
        });

        // Process logs - show ALL swaps, highlight smart wallet ones
        let matchedInBatch = 0;
        for (const log of logs) {
          if (!log.topics || log.topics[0]?.toLowerCase() !== SWAP_TOPIC0) continue;

          const txHash = log.transactionHash?.toLowerCase();
          const transaction = txHash ? txMap.get(txHash) : null;
          const from = transaction?.from?.toLowerCase();

          const isSmartWallet = from && CONFIG.smartWallets.includes(from);
          
          if (isSmartWallet) {
            matchedInBatch++;
            this.stats.matchedSwaps++;
            await this.handleSmartWalletSwap(log, transaction);
          } else {
            // Show other swaps in gray (background activity)
            await this.showBackgroundSwap(log, transaction);
          }
        }

        // Show batch summary if we found smart wallet trades
        if (matchedInBatch > 0) {
          this.ui.addFeedLine(`{green-fg}[MATCH]{/} Found {green-fg}${matchedInBatch}{/} target wallet trades!`);
        }

        // Check position timeout
        if (this.account.currentPosition) {
          const elapsed = (Date.now() - this.account.currentPosition.openedAt) / 1000;
          if (elapsed >= CONFIG.holdDuration && this.lastPrice) {
            this.closePosition(this.lastPrice);
          } else {
            this.ui.updatePosition(this.account.currentPosition, this.lastPrice || this.account.currentPosition.entryPrice);
          }
        }

        // Update account stats
        this.ui.updateAccount(this.account.getStats());

        // Navigate to next block
        if (res.nextBlock) {
          query.fromBlock = res.nextBlock;
          
          if (res.nextBlock >= chainHeight - 2) {
            this.ui.addFeedLine(`{green-fg}[LIVE]{/} Real-time monitoring active - waiting for new blocks...`);
            await new Promise(resolve => setTimeout(resolve, 12000));
          } else {
            // Fast catching up - HyperSync advantage
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } else {
          await new Promise(resolve => setTimeout(resolve, 12000));
        }

      } catch (error) {
        // Log error to file without showing in UI (to keep TUI clean)
        if (errorLog && !errorLog.destroyed) {
          errorLog.write(`\n[${new Date().toISOString()}] TradingBot Error: ${error.message}\n`);
          errorLog.write(`Stack: ${error.stack}\n`);
        }
        
        // Only show a simple, clean status in UI
        this.ui.addFeedLine(`{yellow-fg}[NETWORK]{/} Connection interrupted, retrying...`);
        
        // Longer wait for errors to avoid spam
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  /**
   * Process and display regular swaps (not from smart wallets)
   * In Demo mode, can auto-follow BUY trades for testing
   * @param {Object} log - Raw event log from blockchain
   * @param {Object} transaction - Transaction details
   */
  async showBackgroundSwap(log, transaction) {
    try {
      // Decode the Uniswap V3 Swap event
      const decodedLogs = await decoder.decodeLogs([log]);
      if (!decodedLogs || !decodedLogs[0]) {
        if (this.demoMode) {
          this.ui.addFeedLine(`  {red-fg}[DEBUG] Failed to decode log{/}`);
        }
        return;
      }

      const decoded = decodedLogs[0];
      const amount0 = decoded.body[0]?.val || 0n;  // USDC amount
      const amount1 = decoded.body[1]?.val || 0n;  // WETH amount
      const sqrtPriceX96 = decoded.body[2]?.val || 0n;  // Price in Uniswap V3 format

      const pool = log.address?.toLowerCase();
      const decimals = CONFIG.poolDecimals[pool] || { token0: 6, token1: 18 };

      // Convert BigInt amounts to human-readable decimals
      const amount0USDC = formatAmount(amount0 < 0n ? -amount0 : amount0, decimals.token0);
      const amount1ETH = formatAmount(amount1 < 0n ? -amount1 : amount1, decimals.token1);
      const price = calculatePrice(sqrtPriceX96, decimals.token0, decimals.token1);
      
      // Update last known price for position tracking
      this.lastPrice = price;

      // Determine trade direction from pool's perspective:
      // amount1 < 0: pool pays out WETH → user buys ETH
      // amount1 > 0: pool receives WETH → user sells ETH
      const isBuyingETH = amount1 < 0n;
      const side = isBuyingETH ? "BUY" : "SELL";
      const from = transaction?.from?.slice(0, 10);

      // Adjust thresholds based on mode
      const showThreshold = this.demoMode ? 0.005 : 0.5;  // Lower in demo for more visibility
      const followThreshold = this.demoMode ? 0.005 : CONFIG.minTradeSize;
      
      // Debug: show all detected swaps in demo mode
      if (this.demoMode && amount1ETH < showThreshold) {
        this.ui.addFeedLine(`  {gray-fg}[DEBUG] Detected ${side} ${amount1ETH.toFixed(4)} ETH (below threshold){/}`);
      }
      
      if (amount1ETH >= showThreshold) {
        this.ui.addFeedLine(`  {gray-fg}[SWAP] ${side} ${amount1ETH.toFixed(4)} ETH @ $${price.toFixed(2)} | ${from}...{/}`);
        
        // In demo mode, auto-follow BUY trades that meet minimum size
        if (this.demoMode && isBuyingETH && amount1ETH >= followThreshold && !this.account.currentPosition) {
          const txHash = transaction?.hash?.slice(0, 10);
          this.ui.addFeedLine(``);
          this.ui.addFeedLine(`{bold}{yellow-fg}>>> DEMO MODE: Following this trade <<<{/}{/}`);
          this.ui.addFeedLine(`  Wallet: {cyan-fg}${from}...{/} | Tx: {gray-fg}${txHash}...{/}`);
          this.ui.addFeedLine(`  Action: {yellow-fg}${side}{/} {cyan-fg}${amount1ETH.toFixed(4)} ETH{/} @ {white-fg}$${price.toFixed(2)}{/}`);
          this.ui.addFeedLine(`  Value:  {white-fg}$${(amount1ETH * price).toFixed(2)}{/}`);
          
          this.account.openPosition(side, amount1ETH, amount0USDC, price);
          this.ui.addFeedLine(`  {green-fg}[AUTO-FOLLOW] Position opened instantly!{/}`);
          this.ui.updatePosition(this.account.currentPosition, price);
        } else if (this.demoMode && isBuyingETH && amount1ETH >= followThreshold && this.account.currentPosition) {
          this.ui.addFeedLine(`  {yellow-fg}[SKIP] BUY ${amount1ETH.toFixed(4)} ETH - already in position{/}`);
        } else if (this.demoMode && !isBuyingETH && amount1ETH >= followThreshold) {
          this.ui.addFeedLine(`  {gray-fg}[SKIP] SELL - demo mode only follows BUY trades{/}`);
        }
      }

    } catch (error) {
      // Log error silently without corrupting UI
      if (errorLog && !errorLog.destroyed) {
        errorLog.write(`\n[${new Date().toISOString()}] showBackgroundSwap Error: ${error.message}\n`);
      }
      // Don't show in UI to keep it clean
    }
  }

  /**
   * Handle swap from a smart wallet - this is our signal to copy trade!
   * Automatically opens a position following the smart wallet's trade
   * @param {Object} log - Raw event log from blockchain
   * @param {Object} transaction - Transaction details
   */
  async handleSmartWalletSwap(log, transaction) {
    try {
      // Decode the swap event
      const decodedLogs = await decoder.decodeLogs([log]);
      if (!decodedLogs || !decodedLogs[0]) return;

      const decoded = decodedLogs[0];
      const amount0 = decoded.body[0]?.val || 0n;  // USDC
      const amount1 = decoded.body[1]?.val || 0n;  // WETH
      const sqrtPriceX96 = decoded.body[2]?.val || 0n;  // Price

      const pool = log.address?.toLowerCase();
      const decimals = CONFIG.poolDecimals[pool] || { token0: 6, token1: 18 };

      // Convert to human-readable amounts
      const amount0USDC = formatAmount(amount0 < 0n ? -amount0 : amount0, decimals.token0);
      const amount1ETH = formatAmount(amount1 < 0n ? -amount1 : amount1, decimals.token1);
      const price = calculatePrice(sqrtPriceX96, decimals.token0, decimals.token1);
      this.lastPrice = price;

      // Determine trade direction
      // amount1 < 0: pool pays out WETH → smart wallet buys ETH
      // amount1 > 0: pool receives WETH → smart wallet sells ETH
      const isBuyingETH = amount1 < 0n;
      const side = isBuyingETH ? "BUY" : "SELL";

      // Check if trade size meets minimum threshold
      if (amount1ETH < CONFIG.minTradeSize) {
        this.ui.addFeedLine(`{yellow-fg}[TARGET]{/} Wallet detected but size too small ({cyan-fg}${amount1ETH.toFixed(4)} ETH{/})`);
        return;
      }

      const from = transaction?.from?.slice(0, 12);
      const txHash = transaction?.hash?.slice(0, 10);
      
      // Alert user about smart wallet activity
      this.ui.addFeedLine(``);
      this.ui.addFeedLine(`{bold}{yellow-fg}>>> TARGET WALLET DETECTED (Real-time via HyperSync) <<<{/}{/}`);
      this.ui.addFeedLine(`  Wallet: {cyan-fg}${from}...{/} | Tx: {gray-fg}${txHash}...{/}`);
      this.ui.addFeedLine(`  Action: {yellow-fg}${side}{/} {cyan-fg}${amount1ETH.toFixed(4)} ETH{/} @ {white-fg}$${price.toFixed(2)}{/}`);
      this.ui.addFeedLine(`  Value:  {white-fg}$${(amount1ETH * price).toFixed(2)}{/}`);

      // Auto-follow the trade (copy it)
      if (!this.account.currentPosition) {
        this.account.openPosition(side, amount1ETH, amount0USDC, price);
        this.ui.addFeedLine(`  {green-fg}[AUTO-FOLLOW] Position opened instantly!{/}`);
        this.ui.updatePosition(this.account.currentPosition, price);
      } else {
        // Already in a position, skip this trade
        this.ui.addFeedLine(`  {yellow-fg}[SKIP] Already in position{/}`);
      }

    } catch (error) {
      // Log error silently to avoid corrupting TUI
      if (errorLog && !errorLog.destroyed) {
        errorLog.write(`\n[${new Date().toISOString()}] handleSmartWalletSwap Error: ${error.message}\n`);
      }
      // Don't show in UI to keep it clean
    }
  }

  /**
   * Close the current position and display results
   * @param {number} exitPrice - Price at which to close the position
   */
  closePosition(exitPrice) {
    const trade = this.account.closePosition(exitPrice);
    if (trade) {
      const pnlColor = trade.pnl >= 0 ? 'green-fg' : 'red-fg';
      const pnlSign = trade.pnl >= 0 ? '+' : '';
      const result = trade.pnl >= 0 ? '[WIN]' : '[LOSS]';
      
      // Display trade results in UI
      this.ui.addFeedLine(``);
      this.ui.addFeedLine(`{bold}{${pnlColor}}>>> POSITION CLOSED ${result} <<<{/}{/}`);
      this.ui.addFeedLine(`  Entry:  $${trade.entryPrice.toFixed(2)} | Exit: $${exitPrice.toFixed(2)}`);
      this.ui.addFeedLine(`  P&L:    {${pnlColor}}${pnlSign}$${trade.pnlUsd.toFixed(2)} (${pnlSign}${(trade.pnl * 100).toFixed(2)}%){/}`);
      this.ui.addFeedLine(`  Held:   ${trade.duration}s`);
      
      this.ui.updatePosition(null, null);
      this.ui.updateAccount(this.account.getStats());
    }
  }
}

// ========== Main ==========

// Global variables for logging and cleanup
// These must be global to persist across the application lifetime
let debugLog = null;  // Optional debug log (only if CONFIG.enableDebugLog = true)
let errorLog = null;  // Error log for HyperSync Rust layer errors
let originalStderrWrite = null;  // Original stderr.write to restore on exit
let originalConsoleError = console.error;  // Original console methods
let originalConsoleWarn = console.warn;
let originalConsoleLog = console.log;

/**
 * Setup output suppression to prevent TUI corruption
 * Must be called BEFORE creating the blessed screen
 * 
 * Problem: HyperSync client (Rust layer) writes errors directly to stderr,
 * bypassing JavaScript's console methods. This corrupts the TUI display.
 * 
 * Solution: Redirect all stderr and console output to log files instead
 */
function setupOutputSuppression() {
  // Create error log to capture all errors (especially from Rust layer)
  errorLog = fs.createWriteStream('hypersync_errors.log', { flags: 'a' });
  errorLog.write(`\n\n=== Session started at ${new Date().toISOString()} ===\n`);
  
  // Create optional debug log if enabled
  if (CONFIG.enableDebugLog) {
    debugLog = fs.createWriteStream('debug.log', { flags: 'a' });
    debugLog.write(`\n\n=== Session started at ${new Date().toISOString()} ===\n`);
  }
  
  // Redirect stderr to file to prevent Rust layer logs from corrupting TUI
  // This is the critical fix for HyperSync error messages appearing in terminal
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    // Write to error log file instead of terminal
    try {
      if (errorLog && !errorLog.destroyed) {
        errorLog.write(chunk, encoding, callback);
      }
    } catch (e) {
      // Ignore write errors to avoid infinite loops
    }
    
    // Handle callback properly
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  };
  
  // Override console methods to prevent TUI corruption
  console.error = (...args) => {
    if (debugLog && !debugLog.destroyed) {
      debugLog.write(`[${new Date().toISOString()}] ERROR: ${JSON.stringify(args)}\n`);
    }
    if (errorLog && !errorLog.destroyed) {
      errorLog.write(`[${new Date().toISOString()}] ERROR: ${args.join(' ')}\n`);
    }
    // Suppress all console output (don't write to terminal)
  };
  
  console.warn = (...args) => {
    if (debugLog && !debugLog.destroyed) {
      debugLog.write(`[${new Date().toISOString()}] WARN: ${JSON.stringify(args)}\n`);
    }
    if (errorLog && !errorLog.destroyed) {
      errorLog.write(`[${new Date().toISOString()}] WARN: ${args.join(' ')}\n`);
    }
    // Suppress all console output
  };
  
  console.log = (...args) => {
    if (debugLog && !debugLog.destroyed) {
      debugLog.write(`[${new Date().toISOString()}] LOG: ${JSON.stringify(args)}\n`);
    }
    // Suppress all console output
  };
}

/**
 * Cleanup function to restore outputs and close log files
 * Called on exit to ensure clean shutdown
 */
function cleanup() {
  try {
    // Restore original stderr and console methods
    if (originalStderrWrite) {
      process.stderr.write = originalStderrWrite;
    }
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
    
    // Close log file streams
    if (debugLog && !debugLog.destroyed) debugLog.end();
    if (errorLog && !errorLog.destroyed) errorLog.end();
  } catch (e) {
    // Ignore cleanup errors - we're exiting anyway
  }
}

/**
 * Main application entry point
 * Initializes HyperSync client, account manager, TUI, and trading bot
 */
async function main() {
  // Validate environment: Check for HyperSync bearer token before starting
  if (!CONFIG.bearerToken) {
    console.error("❌ ERROR: HYPERSYNC_BEARER token not found!");
    console.error("   Please create a .env file with your HyperSync token.");
    console.error("   Copy .env.example to .env and add your token.");
    console.error("   Get one at: https://envio.dev\n");
    process.exit(1);
  }
  
  // Setup output suppression BEFORE creating any components
  // This prevents HyperSync Rust errors from corrupting the TUI
  setupOutputSuppression();
  
  // Register cleanup handlers for graceful shutdown
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    // Ctrl+C pressed
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    // Kill signal received
    cleanup();
    process.exit(0);
  });
  process.on('uncaughtException', (err) => {
    // Unexpected error - log and exit gracefully
    if (errorLog && !errorLog.destroyed) {
      errorLog.write(`\n[UNCAUGHT EXCEPTION] ${err.stack}\n`);
    }
    cleanup();
    // Restore stderr for final error message
    if (originalStderrWrite) {
      process.stderr.write = originalStderrWrite;
    }
    process.stderr.write('\n\n❌ Uncaught Exception: ' + err.message + '\n');
    process.stderr.write(err.stack + '\n');
    process.exit(1);
  });

  // Initialize components AFTER output suppression is in place
  
  // 1. HyperSync client - connects to ultra-fast blockchain data stream
  const client = HypersyncClient.new({
    url: CONFIG.hypersyncUrl,
    bearerToken: CONFIG.bearerToken,
  });

  // 2. Account manager - tracks balance and positions
  const account = new AccountManager(CONFIG.initialBalance);
  
  // 3. TUI manager - creates the beautiful terminal interface
  const ui = new TUIManager();
  
  // 4. Trading bot - core logic that ties everything together
  const bot = new TradingBot(client, account, ui);

  // Start the bot - this runs indefinitely until interrupted
  await bot.start();
}

// Application entry point with error handling
main().catch(error => {
  // Fatal error occurred - clean up and display error
  cleanup();
  
  // Restore stderr for fatal error display
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
  }
  
  process.stderr.write('\n\n❌ Fatal Error: ' + error.message + '\n');
  process.stderr.write(error.stack + '\n');
  process.exit(1);
});

