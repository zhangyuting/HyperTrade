/**
 * Smart Wallet Copy Trading POC
 * Tracks specific wallets' swaps on Uniswap V3 pools and simulates copy trading
 */

import 'dotenv/config';
import {
  HypersyncClient,
  LogField,
  BlockField,
  TransactionField,
  JoinMode,
  Decoder,
} from "@envio-dev/hypersync-client";
import { keccak256, toUtf8Bytes } from "ethers";

// ========== Configuration ==========

const CONFIG = {
  // Get your API token from: https://docs.envio.dev/docs/HyperSync/api-tokens
  hypersyncUrl: process.env.HYPERSYNC_URL || "https://eth.hypersync.xyz",
  bearerToken: process.env.HYPERSYNC_BEARER,
  
  // Target pools to monitor (empty array = monitor ALL Uniswap V3 pools)
  pools: [
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", // Uniswap V3 USDC/WETH 0.3%
  ],
  
  // Pool token decimals for price calculation
  // IMPORTANT: Check the actual token order in the pool contract!
  poolDecimals: {
    "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8": { 
      token0: 6,   // USDC (6 decimals)
      token1: 18,  // WETH (18 decimals)
    },
  },
  
  // Smart wallets to track (add more addresses here)
  smartWallets: [
    "0x56fc0708725a65ebb633efdaec931c0600a9face",
  ].map(addr => addr.toLowerCase()),
  
  // How long to hold position (seconds)
  holdDuration: 120,
  
  // Start from recent blocks (0 = from genesis, which is very slow)
  // Set to a larger number to scan more history, or smaller to catch up faster
  startBlocksBack: 10000,  // 约1.5天的历史
  
  // Debug mode: show all swaps to help identify wallet activity
  debug: false,  // 关闭详细调试，只显示匹配的交易
  
  // Diagnostic mode: search for wallet activity across ALL pools (not just configured ones)
  // This will ignore the pools filter to find where your wallets are actually trading
  diagnosticMode: false,
};

// ========== Event ABI Setup ==========

const SWAP_SIGNATURE = "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";
const SWAP_TOPIC0 = keccak256(toUtf8Bytes("Swap(address,address,int256,int256,uint160,uint128,int24)")).toLowerCase();

// Create decoder for parsing swap events
const decoder = Decoder.fromSignatures([SWAP_SIGNATURE]);

console.log(`🔑 Swap Event Topic0: ${SWAP_TOPIC0}`);

// ========== Helpers ==========

function calculatePrice(sqrtPriceX96, decimals0 = 6, decimals1 = 18) {
  // sqrtPriceX96 = sqrt(price) * 2^96, where price = token1/token0
  // For USDC/WETH pool: price = WETH/USDC (how much WETH per USDC)
  // We want USDC per ETH, so we need to invert
  const Q192 = 2n ** 192n;
  
  // Calculate token1/token0 price (WETH per USDC)
  const priceToken1PerToken0 = Number((sqrtPriceX96 * sqrtPriceX96 * BigInt(10 ** decimals0)) / Q192) / (10 ** decimals1);
  
  // Invert to get USDC per WETH
  const usdcPerEth = 1 / priceToken1PerToken0;
  
  return usdcPerEth;
}

function calculatePnL(side, entryPrice, exitPrice) {
  // side can be "BUY" or "SELL"
  const isLong = side === "BUY";
  const pnl = isLong
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  return pnl * 100; // percentage
}

// ========== Trading Logic ==========

class CopyTrader {
  constructor() {
    this.position = null; // { pool, side, entryPrice, openedAt, blockNumber }
    this.lastPrices = new Map();
  }

  async processSwap(log, blockNumber, timestamp) {
    const from = log.transaction?.from?.toLowerCase();
    if (!from || !CONFIG.smartWallets.includes(from)) return;

    const pool = log.address?.toLowerCase();
    const txHash = log.transactionHash;

    console.log(`\n📊 Smart Wallet Swap Detected!`);
    console.log(`   Wallet: ${from}`);
    console.log(`   Pool: ${pool}`);
    console.log(`   Block: ${blockNumber}`);
    console.log(`   Transaction: ${txHash}`);

    // Try to decode the swap event
    try {
      const decodedLogs = await decoder.decodeLogs([log]);
      
      if (decodedLogs && decodedLogs.length > 0 && decodedLogs[0]) {
        const decoded = decodedLogs[0];
        
        // Get indexed parameters (sender, recipient)
        const sender = decoded.indexed[0]?.val?.toString() || "unknown";
        const recipient = decoded.indexed[1]?.val?.toString() || "unknown";
        
        // Get body parameters (amounts, price, etc)
        const amount0 = decoded.body[0]?.val || 0n;
        const amount1 = decoded.body[1]?.val || 0n;
        const sqrtPriceX96 = decoded.body[2]?.val || 0n;
        const liquidity = decoded.body[3]?.val || 0n;
        const tick = decoded.body[4]?.val || 0n;
        
        // Format amounts properly handling BigInt
        const decimals = CONFIG.poolDecimals[pool] || { token0: 6, token1: 18 };
        
        // Convert BigInt to decimal string with proper handling
        // For USDC (token0, 6 decimals)
        const absAmount0 = amount0 < 0n ? -amount0 : amount0;
        const amount0Str = absAmount0.toString().padStart(decimals.token0 + 1, '0');
        const amount0USDC = parseFloat(
          amount0Str.slice(0, -decimals.token0) + '.' + amount0Str.slice(-decimals.token0)
        );
        
        // For WETH (token1, 18 decimals)
        const absAmount1 = amount1 < 0n ? -amount1 : amount1;
        const amount1Str = absAmount1.toString().padStart(decimals.token1 + 1, '0');
        const amount1ETH = parseFloat(
          amount1Str.slice(0, -decimals.token1) + '.' + amount1Str.slice(-decimals.token1)
        );
        
        // Determine direction based on token1 (WETH)
        // If amount1 > 0, receiving WETH (buying ETH)
        // If amount1 < 0, sending WETH (selling ETH)
        const isBuyingETH = amount1 > 0n;
        const side = isBuyingETH ? "BUY" : "SELL";
        
        // Calculate price (USDC per ETH)
        const price = calculatePrice(sqrtPriceX96, decimals.token0, decimals.token1);
        
        // Determine what was bought/sold
        const action = isBuyingETH
          ? `BUY ${amount1ETH.toFixed(6)} ETH for ${amount0USDC.toFixed(2)} USDC`
          : `SELL ${amount1ETH.toFixed(6)} ETH for ${amount0USDC.toFixed(2)} USDC`;
        
        console.log(`   💸 Trade: ${action}`);
        console.log(`   💲 Price: ${price.toFixed(2)} USDC per ETH`);
        console.log(`   📊 Size: ${amount1ETH.toFixed(6)} ETH (≈ $${amount0USDC.toFixed(2)})`);
        console.log(`   🔗 View: https://etherscan.io/tx/${txHash}`);
        
        // Track position
        if (!this.position) {
          this.position = {
            pool,
            side,
            entryPrice: price,
            openedAt: timestamp,
            blockNumber,
            txHash,
            tradeCount: 1
          };
          console.log(`✅ Started tracking wallet activity`);
        } else {
          const elapsed = timestamp - this.position.openedAt;
          this.position.tradeCount = (this.position.tradeCount || 1) + 1;
          console.log(`📈 Follow-up trade #${this.position.tradeCount} (${elapsed}s since first swap)`);
        }
        
        this.lastPrices.set(pool, price);
      } else {
        console.log(`   ⚠️  Could not decode swap details`);
        console.log(`   🔗 View: https://etherscan.io/tx/${txHash}`);
      }
    } catch (error) {
      console.log(`   ⚠️  Decode error: ${error.message}`);
      console.log(`   🔗 View: https://etherscan.io/tx/${txHash}`);
    }
  }

  checkTimeBasedClose(currentTimestamp) {
    if (!this.position) return;
    
    const holdTime = currentTimestamp - this.position.openedAt;
    if (holdTime >= CONFIG.holdDuration) {
      console.log(`\n⏰ Tracking Window Closed (${holdTime}s)`);
      console.log(`   Total trades detected: ${this.position.tradeCount || 1}`);
      console.log(`   Initial transaction: ${this.position.txHash}`);
      console.log(`   Pool: ${this.position.pool}`);
      
      // Calculate PnL if we have price data
      if (this.position.entryPrice > 0) {
        const currentPrice = this.lastPrices.get(this.position.pool) || this.position.entryPrice;
        const pnl = calculatePnL(this.position.side, this.position.entryPrice, currentPrice);
        const pnlSign = pnl >= 0 ? '+' : '';
        console.log(`   Entry price: $${this.position.entryPrice.toFixed(2)} per ETH`);
        console.log(`   Current price: $${currentPrice.toFixed(2)} per ETH`);
        console.log(`   💰 Simulated PnL: ${pnlSign}${pnl.toFixed(2)}% (${this.position.side} position)`);
      }
      
      this.position = null;
    }
  }
}

// ========== Main ==========

async function main() {
  console.log("🚀 Smart Wallet Copy Trading POC");
  console.log("================================\n");
  console.log(`Tracking ${CONFIG.smartWallets.length} wallet(s) across ${CONFIG.diagnosticMode ? 'ALL' : CONFIG.pools.length} pool(s)`);
  
  if (!CONFIG.diagnosticMode) {
    console.log(`\n📍 Monitored Pools:`);
    CONFIG.pools.forEach(pool => console.log(`   - ${pool}`));
  }
  
  console.log(`\n👤 Tracked Wallets:`);
  CONFIG.smartWallets.forEach(wallet => console.log(`   - ${wallet}`));
  console.log(`\n⏱️  Hold Duration: ${CONFIG.holdDuration}s`);
  console.log(`🐛 Debug Mode: ${CONFIG.debug ? 'ON' : 'OFF'}`);
  console.log(`🔬 Diagnostic Mode: ${CONFIG.diagnosticMode ? 'ON (searching all pools)' : 'OFF'}\n`);
  
  if (!CONFIG.bearerToken) {
    console.error("❌ ERROR: HYPERSYNC_BEARER token not found!");
    console.error("   Please create a .env file with your HyperSync token.");
    console.error("   Copy .env.example to .env and add your token.");
    console.error("   Get one at: https://envio.dev\n");
    process.exit(1);
  }
  
  if (!CONFIG.diagnosticMode && CONFIG.pools.length === 0) {
    console.warn("⚠️  No pools configured. Set diagnosticMode: true to search all pools.\n");
  }

  const client = HypersyncClient.new({
    url: CONFIG.hypersyncUrl,
    ...(CONFIG.bearerToken && { bearerToken: CONFIG.bearerToken }),
  });

  // Get starting block
  const currentHeight = await client.getHeight();
  let fromBlock = CONFIG.startBlocksBack 
    ? currentHeight - CONFIG.startBlocksBack 
    : currentHeight;
  
  console.log(`📍 Current chain height: ${currentHeight}`);
  console.log(`📍 Starting from block: ${fromBlock}`);
  console.log(`📍 Scanning ${CONFIG.startBlocksBack} blocks of history\n`);

  const trader = new CopyTrader();
  let lastTimestamp = 0;

  const query = {
    fromBlock,
    logs: [{
      // In diagnostic mode, search ALL pools. Otherwise, use configured pools
      address: CONFIG.diagnosticMode ? undefined : CONFIG.pools,
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
        LogField.TransactionHash,  // 关键：需要这个字段来关联 transaction
        LogField.BlockNumber,
      ],
      transaction: [TransactionField.From, TransactionField.Hash],
    },
    // 注意：即使设置了 JoinMode，logs 和 transactions 仍然是分离的数组
    // 需要手动通过 transactionHash 来 join
    joinMode: JoinMode.JoinTransactions,
  };

  console.log(`\n📋 Query Configuration:`);
  console.log(`   fromBlock: ${fromBlock}`);
  console.log(`   address filter: ${query.logs[0].address ? JSON.stringify(query.logs[0].address) : 'ALL (no filter)'}`);
  console.log(`   topic0 filter: [${SWAP_TOPIC0}]`);
  
  if (CONFIG.diagnosticMode) {
    console.log("\n🔬 DIAGNOSTIC MODE: Searching ALL Uniswap V3 pools for wallet activity");
  }
  console.log();

  let batchCount = 0;
  let totalSwaps = 0;
  let matchedSwaps = 0;
  let lastProgressUpdate = Date.now();
  const PROGRESS_INTERVAL = 10000; // Update every 10 seconds

  while (true) {
    try {
      // Get data using the get() function for real-time monitoring at chain tip
      const res = await client.get(query);
      
      if (!res || !res.data) {
        // No data available, wait and retry
        await new Promise(resolve => setTimeout(resolve, 12000));
        continue;
      }

      const logs = res.data.logs || [];
      const transactions = res.data.transactions || [];
      batchCount++;
      
      // Show progress
      const currentBlock = res.archiveHeight || res.nextBlock || query.fromBlock;
      const swapsInBatch = logs.filter(log => log.topics?.[0]?.toLowerCase() === SWAP_TOPIC0).length;
      totalSwaps += swapsInBatch;
      
      // Get current chain height to check if we're at the tip
      const chainHeight = await client.getHeight();
      const atChainTip = currentBlock >= chainHeight - 5;
      
      // Only show batch info if we have swaps or we're catching up
      if (swapsInBatch > 0 || !atChainTip) {
        console.log(`\n🔍 Batch #${batchCount} | Blocks: ${query.fromBlock} → ${currentBlock} | Swaps found: ${swapsInBatch}`);
      }
      
      // Build transaction hash to transaction mapping
      const txMap = new Map();
      transactions.forEach(tx => {
        if (tx.hash) {
          txMap.set(tx.hash.toLowerCase(), tx);
        }
      });
      
      let matchedInBatch = 0;
      const uniqueWallets = new Set();
      const poolsInBatch = new Set();
      let logsWithoutTx = 0;
      
      for (const log of logs) {
        // Check if this is a Swap event using topics array
        if (!log.topics || log.topics[0]?.toLowerCase() !== SWAP_TOPIC0) continue;
        
        const blockNumber = log.blockNumber || log.block?.number || 0;
        const timestamp = log.block?.timestamp || 0;
        lastTimestamp = timestamp;
        
        // Manually join transaction using transactionHash
        const txHash = log.transactionHash?.toLowerCase();
        const transaction = txHash ? txMap.get(txHash) : null;
        const from = transaction?.from?.toLowerCase();
        const pool = log.address?.toLowerCase();
        
        // Debug: check if transaction is missing
        if (!transaction && txHash) {
          logsWithoutTx++;
          if (CONFIG.debug && logsWithoutTx <= 3) {
            console.log(`⚠️  Transaction not found for hash: ${txHash}`);
          }
        }
        
        if (from) uniqueWallets.add(from);
        if (pool) poolsInBatch.add(pool);
        
        const isTracked = from && CONFIG.smartWallets.includes(from);
        
        if (isTracked) {
          matchedInBatch++;
          matchedSwaps++;
          
          // Attach transaction to log for processing
          log.transaction = transaction;
          await trader.processSwap(log, blockNumber, timestamp);
        }
        
        // Show first few swaps to debug (only in debug mode)
        if (CONFIG.debug && swapsInBatch > 0 && swapsInBatch <= 10) {
          const marker = isTracked ? "🎯 MATCH" : "  ";
          console.log(`   ${marker} From: ${from || 'NO_TX'} | Pool: ${pool?.slice(0, 10)}... | Block: ${blockNumber}`);
        }
      }
      
      if (CONFIG.debug) {
        if (logsWithoutTx > 0) {
          console.log(`⚠️  ${logsWithoutTx} swap logs couldn't find matching transaction`);
        }
        
        if (uniqueWallets.size > 0) {
          console.log(`   📊 ${uniqueWallets.size} unique wallets | ${poolsInBatch.size} unique pools`);
        }

        if (matchedInBatch === 0 && swapsInBatch > 0) {
          console.log(`   ℹ️  No swaps from tracked wallets in this batch`);
        }
      }

      // Check time-based close after processing logs
      if (lastTimestamp > 0) {
        trader.checkTimeBasedClose(lastTimestamp);
      }

      // Periodic summary (every 10 seconds)
      const now = Date.now();
      if (now - lastProgressUpdate > PROGRESS_INTERVAL) {
        const status = trader.position ? 'TRACKING' : 'IDLE';
        console.log(`\n📈 Summary: ${totalSwaps} total swaps scanned | ${matchedSwaps} from tracked wallets | Status: ${status}`);
        lastProgressUpdate = now;
      }

      // Update query for next batch
      if (res.nextBlock) {
        const oldBlock = query.fromBlock;
        query.fromBlock = res.nextBlock;
        
        // Check if we've caught up to the chain head (reuse chainHeight from above)
        if (res.nextBlock >= chainHeight - 2) {
          // We're at or near the chain head
          if (batchCount === 1 || oldBlock < chainHeight - 1000) {
            console.log(`\n✅ Caught up to chain head (block ${chainHeight})`);
            console.log(`   Now monitoring for new swaps in real-time...`);
            console.log(`   Press Ctrl+C to stop\n`);
          }
          // Wait for new blocks (12 seconds = ~1 Ethereum block)
          await new Promise(resolve => setTimeout(resolve, 12000));
        } else {
          // Still catching up, continue quickly
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } else {
        // No more data in this range, wait before trying again
        await new Promise(resolve => setTimeout(resolve, 12000));
      }
      
    } catch (error) {
      console.error("❌ Error:", error.message);
      console.error("   Stack:", error.stack);
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
    }
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
