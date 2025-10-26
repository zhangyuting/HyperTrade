/**
 * Smart Wallet Copy Trading - TUI Version
 * Real-time monitoring and auto-trading with beautiful terminal interface
 */

import 'dotenv/config';
import blessed from 'blessed';
import {
  HypersyncClient,
  LogField,
  BlockField,
  TransactionField,
  JoinMode,
  Decoder,
} from "@envio-dev/hypersync-client";
import { keccak256, toUtf8Bytes } from "ethers";
import fs from 'fs';

// ========== Configuration ==========

const CONFIG = {
  hypersyncUrl: process.env.HYPERSYNC_URL || "https://eth.hypersync.xyz",
  bearerToken: process.env.HYPERSYNC_BEARER,
  
  pools: [
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", // Uniswap V3 USDC/WETH 0.3%
  ],
  
  poolDecimals: {
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8": { 
      token0: 6,   // USDC
      token1: 18,  // WETH
    },
  },
  
  smartWallets: [
    "0x56fc0708725a65ebb633efdaec931c0600a9face",
  ].map(addr => addr.toLowerCase()),
  
  // Trading strategy
  minTradeSize: 0.1,        // Minimum 0.1 ETH to follow
  holdDuration: 120,         // Hold for 120 seconds
  startBlocksBack: 5000,     // Scan last 5000 blocks
  
  // Account settings
  initialBalance: 10000,     // $10,000 starting balance
  riskPerTrade: 0.02,        // 2% risk per trade
  
  // Debug settings
  enableDebugLog: false,     // Set to true to write debug logs to debug.log
};

// ========== Event Setup ==========

const SWAP_SIGNATURE = "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
const SWAP_TOPIC0 = keccak256(toUtf8Bytes("Swap(address,address,int256,int256,uint160,uint128,int24)")).toLowerCase();
const decoder = Decoder.fromSignatures([SWAP_SIGNATURE]);

// ========== Helper Functions ==========

function calculatePrice(sqrtPriceX96, decimals0 = 6, decimals1 = 18) {
  const Q192 = 2n ** 192n;
  const priceToken1PerToken0 = Number((sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** decimals0)) / Q192) / (10 ** decimals1);
  return 1 / priceToken1PerToken0;
}

function formatAmount(bigIntValue, decimals) {
  const absValue = bigIntValue < 0n ? -bigIntValue : bigIntValue;
  const valueStr = absValue.toString().padStart(decimals + 1, '0');
  return parseFloat(valueStr.slice(0, -decimals) + '.' + valueStr.slice(-decimals));
}

function formatTime() {
  return new Date().toLocaleTimeString();
}

function formatPnL(pnl) {
  const sign = pnl >= 0 ? '+' : '';
  const color = pnl >= 0 ? '{green-fg}' : '{red-fg}';
  return `${color}${sign}${pnl.toFixed(2)}%{/}`;
}

// ========== Account Manager ==========

class AccountManager {
  constructor(initialBalance) {
    this.balance = initialBalance;
    this.initialBalance = initialBalance;
    this.trades = [];
    this.currentPosition = null;
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync('account_state.json')) {
        const state = JSON.parse(fs.readFileSync('account_state.json', 'utf8'));
        this.balance = state.balance;
        this.trades = state.trades || [];
      }
    } catch (e) {
      // Ignore load errors
    }
  }

  saveState() {
    try {
      fs.writeFileSync('account_state.json', JSON.stringify({
        balance: this.balance,
        trades: this.trades,
      }, null, 2));
    } catch (e) {
      // Ignore save errors
    }
  }

  openPosition(side, ethAmount, usdcAmount, price) {
    const usdValue = usdcAmount;
    // Normalize side immediately when opening position
    const normalizedSide = side.trim().toUpperCase();
    
    if (CONFIG.enableDebugLog) {
      console.log(`[DEBUG] Opening position:`, {
        originalSide: `"${side}"`,
        normalizedSide: `"${normalizedSide}"`,
        price: price
      });
    }
    
    this.currentPosition = {
      side: normalizedSide,  // Store normalized side
      ethAmount,
      usdcAmount,
      entryPrice: price,
      openedAt: Date.now(),
      usdValue,
    };
    return this.currentPosition;
  }

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
    
    // Calculate PnL
    let pnl;
    if (side === 'BUY') {
      pnl = (exitPrice - this.currentPosition.entryPrice) / this.currentPosition.entryPrice;
      if (CONFIG.enableDebugLog) {
        console.log(`[DEBUG] Using BUY formula: (${exitPrice} - ${this.currentPosition.entryPrice}) / ${this.currentPosition.entryPrice} = ${pnl}`);
      }
    } else {
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
    
    this.balance += pnlUsd;

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
    this.saveState();

    return trade;
  }

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
      recentTrades: this.trades.slice(-10).reverse(),
    };
  }
}

// ========== TUI Manager ==========

class TUIManager {
  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Smart Wallet Copy Trading'
    });

    this.createLayout();
    this.setupHandlers();
  }

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

class TradingBot {
  constructor(client, account, ui) {
    this.client = client;
    this.account = account;
    this.ui = ui;
    this.currentBlock = 0;
    this.lastPrice = null;
    
    // Demo mode: follow all BUY trades, not just smart wallets
    this.demoMode = false;
    
    // Statistics for live feed
    this.stats = {
      totalBlocks: 0,
      totalSwaps: 0,
      matchedSwaps: 0,
      startTime: Date.now(),
      lastBlockTime: Date.now(),
    };
    
    // Setup mode toggle handler
    this.ui.onModeToggle = () => this.toggleMode();
  }
  
  toggleMode() {
    this.demoMode = !this.demoMode;
    const modeName = this.demoMode ? 'DEMO' : 'SMART-WALLET';
    const modeDesc = this.demoMode ? 'Following ALL buy trades' : 'Following smart wallets only';
    
    this.ui.addFeedLine(``);
    this.ui.addFeedLine(`{yellow-fg}[MODE SWITCH]{/} Switched to {bold}${modeName}{/} mode`);
    this.ui.addFeedLine(`  {gray-fg}${modeDesc}{/}`);
    this.ui.addFeedLine(``);
  }

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
        // Handle different types of errors
        let errorMsg = 'Unknown error';
        if (error.message) {
          if (error.message.includes('arrow') || error.message.includes('server')) {
            errorMsg = 'HyperSync connection issue, retrying...';
          } else if (error.message.includes('timeout')) {
            errorMsg = 'Request timeout, retrying...';
          } else if (error.message.includes('network')) {
            errorMsg = 'Network error, retrying...';
          } else {
            errorMsg = error.message.substring(0, 100); // Truncate long messages
          }
        }
        
        this.ui.addFeedLine(`{red-fg}[ERROR]{/} ${errorMsg}`);
        
        // Longer wait for errors to avoid spam
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  async showBackgroundSwap(log, transaction) {
    try {
      const decodedLogs = await decoder.decodeLogs([log]);
      if (!decodedLogs || !decodedLogs[0]) {
        if (this.demoMode) {
          this.ui.addFeedLine(`  {red-fg}[DEBUG] Failed to decode log{/}`);
        }
        return;
      }

      const decoded = decodedLogs[0];
      const amount0 = decoded.body[0]?.val || 0n;
      const amount1 = decoded.body[1]?.val || 0n;
      const sqrtPriceX96 = decoded.body[2]?.val || 0n;

      const pool = log.address?.toLowerCase();
      const decimals = CONFIG.poolDecimals[pool] || { token0: 6, token1: 18 };

      // Use absolute value for display
      const amount0USDC = formatAmount(amount0 < 0n ? -amount0 : amount0, decimals.token0);
      const amount1ETH = formatAmount(amount1 < 0n ? -amount1 : amount1, decimals.token1);
      const price = calculatePrice(sqrtPriceX96, decimals.token0, decimals.token1);
      
      // Update last known price
      this.lastPrice = price;

      // Uniswap V3 amounts are from pool's perspective:
      // amount1 < 0 means pool pays out WETH (user buys WETH)
      // amount1 > 0 means pool receives WETH (user sells WETH)
      const isBuyingETH = amount1 < 0n;
      const side = isBuyingETH ? "BUY" : "SELL";
      const from = transaction?.from?.slice(0, 10);

      // Show trades based on mode
      const showThreshold = this.demoMode ? 0.005 : 0.5; // Even lower threshold in demo mode
      const followThreshold = this.demoMode ? 0.005 : CONFIG.minTradeSize; // Same as show threshold in demo
      
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
      // Show errors in demo mode for debugging
      if (this.demoMode) {
        this.ui.addFeedLine(`  {red-fg}[DEBUG] showBackgroundSwap error: ${error.message}{/}`);
      }
    }
  }

  async handleSmartWalletSwap(log, transaction) {
    try {
      const decodedLogs = await decoder.decodeLogs([log]);
      if (!decodedLogs || !decodedLogs[0]) return;

      const decoded = decodedLogs[0];
      const amount0 = decoded.body[0]?.val || 0n;
      const amount1 = decoded.body[1]?.val || 0n;
      const sqrtPriceX96 = decoded.body[2]?.val || 0n;

      const pool = log.address?.toLowerCase();
      const decimals = CONFIG.poolDecimals[pool] || { token0: 6, token1: 18 };

      // Use absolute value for display
      const amount0USDC = formatAmount(amount0 < 0n ? -amount0 : amount0, decimals.token0);
      const amount1ETH = formatAmount(amount1 < 0n ? -amount1 : amount1, decimals.token1);
      const price = calculatePrice(sqrtPriceX96, decimals.token0, decimals.token1);
      this.lastPrice = price;

      // Uniswap V3 amounts are from pool's perspective:
      // amount1 < 0 means pool pays out WETH (user buys WETH)
      // amount1 > 0 means pool receives WETH (user sells WETH)
      const isBuyingETH = amount1 < 0n;
      const side = isBuyingETH ? "BUY" : "SELL";

      // Check if trade size meets minimum
      if (amount1ETH < CONFIG.minTradeSize) {
        this.ui.addFeedLine(`{yellow-fg}[TARGET]{/} Wallet detected but size too small ({cyan-fg}${amount1ETH.toFixed(4)} ETH{/})`);
        return;
      }

      const from = transaction?.from?.slice(0, 12);
      const txHash = transaction?.hash?.slice(0, 10);
      
      this.ui.addFeedLine(``);
      this.ui.addFeedLine(`{bold}{yellow-fg}>>> TARGET WALLET DETECTED (Real-time via HyperSync) <<<{/}{/}`);
      this.ui.addFeedLine(`  Wallet: {cyan-fg}${from}...{/} | Tx: {gray-fg}${txHash}...{/}`);
      this.ui.addFeedLine(`  Action: {yellow-fg}${side}{/} {cyan-fg}${amount1ETH.toFixed(4)} ETH{/} @ {white-fg}$${price.toFixed(2)}{/}`);
      this.ui.addFeedLine(`  Value:  {white-fg}$${(amount1ETH * price).toFixed(2)}{/}`);

      // Auto-follow the trade
      if (!this.account.currentPosition) {
        this.account.openPosition(side, amount1ETH, amount0USDC, price);
        this.ui.addFeedLine(`  {green-fg}[AUTO-FOLLOW] Position opened instantly!{/}`);
        this.ui.updatePosition(this.account.currentPosition, price);
      } else {
        this.ui.addFeedLine(`  {yellow-fg}[SKIP] Already in position{/}`);
      }

    } catch (error) {
      this.ui.addFeedLine(`{red-fg}[PARSE ERROR]{/} ${error.message}`);
    }
  }

  closePosition(exitPrice) {
    const trade = this.account.closePosition(exitPrice);
    if (trade) {
      const pnlColor = trade.pnl >= 0 ? 'green-fg' : 'red-fg';
      const pnlSign = trade.pnl >= 0 ? '+' : '';
      const result = trade.pnl >= 0 ? '[WIN]' : '[LOSS]';
      
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

async function main() {
  // Check for bearer token before starting TUI
  if (!CONFIG.bearerToken) {
    console.error("❌ ERROR: HYPERSYNC_BEARER token not found!");
    console.error("   Please create a .env file with your HyperSync token.");
    console.error("   Copy .env.example to .env and add your token.");
    console.error("   Get one at: https://envio.dev\n");
    process.exit(1);
  }
  
  // COMPLETELY suppress ALL console output to prevent TUI corruption
  let debugLog = null;
  
  if (CONFIG.enableDebugLog) {
    const fs = await import('fs');
    debugLog = fs.createWriteStream('debug.log', { flags: 'a' });
    debugLog.write(`\n\n=== Session started at ${new Date().toISOString()} ===\n`);
  }
  
  // Override console methods to prevent TUI corruption
  console.error = (...args) => {
    if (CONFIG.enableDebugLog && debugLog && args[0]?.includes?.('[DEBUG]')) {
      debugLog.write(`[${new Date().toISOString()}] ERROR: ${JSON.stringify(args)}\n`);
    }
    // Suppress all console output
  };
  
  console.warn = (...args) => {
    if (CONFIG.enableDebugLog && debugLog) {
      debugLog.write(`[${new Date().toISOString()}] WARN: ${JSON.stringify(args)}\n`);
    }
    // Suppress all console output
  };
  
  console.log = (...args) => {
    if (CONFIG.enableDebugLog && debugLog && args[0]?.includes?.('[DEBUG]')) {
      debugLog.write(`[${new Date().toISOString()}] LOG: ${JSON.stringify(args)}\n`);
    }
    // Suppress all console output
  };

  // Initialize components
  const client = HypersyncClient.new({
    url: CONFIG.hypersyncUrl,
    bearerToken: CONFIG.bearerToken,
  });

  const account = new AccountManager(CONFIG.initialBalance);
  const ui = new TUIManager();
  const bot = new TradingBot(client, account, ui);

  // Start the bot
  await bot.start();
}

main().catch(error => {
  // Restore console and display fatal error
  process.stderr.write('\n\n❌ Fatal Error: ' + error.message + '\n');
  process.stderr.write(error.stack + '\n');
  process.exit(1);
});

