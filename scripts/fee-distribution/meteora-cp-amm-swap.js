#!/usr/bin/env node

/**
 * Meteora CP AMM Direct Pool Swap Script
 *
 * This script performs a token swap directly through a specific Meteora CP AMM pool,
 * bypassing Jupiter's auto-routing. This ensures swaps go through the correct pool.
 *
 * Usage:
 * node meteora-cp-amm-swap.js --wallet-key <key> --pool-address <address> --input-token <mint> --output-token <mint> --amount <amount>
 *
 * Arguments:
 * - --wallet-key: Private key of wallet containing the input tokens (also pays fees)
 * - --pool-address: Meteora CP AMM pool address to use for the swap
 * - --input-token: Mint address of the token to swap from
 * - --output-token: Mint address of the token to swap to
 * - --amount: Amount of input token to swap (in token units, not smallest unit)
 *
 * Note: The wallet-key wallet will both provide the input tokens AND pay transaction fees
 *
 * Returns JSON response for Python integration
 */

import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { createConnection, parsePrivateKey, parsePublicKey } from './utils/solana.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    
    if (!key || !key.startsWith('--') || !value) {
      throw new Error('Invalid argument format. Use --key value pairs.');
    }
    
    const paramName = key.slice(2).replace(/-/g, '_'); // Convert --wallet-key to wallet_key
    parsed[paramName] = value;
  }
  
  return parsed;
}

async function getTokenDecimals(connection, tokenMint) {
  try {
    const mintPubkey = parsePublicKey(tokenMint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    
    if (mintInfo.value && mintInfo.value.data.parsed && mintInfo.value.data.parsed.info) {
      return mintInfo.value.data.parsed.info.decimals;
    }
    
    return 9; // Default fallback
  } catch (error) {
    console.warn(`Failed to get token decimals for ${tokenMint}, using default (9):`, error.message);
    return 9;
  }
}

async function main() {
  const args = parseArgs();
  
  const {
    wallet_key: walletKey,
    pool_address: poolAddress,
    input_token: inputToken,
    output_token: outputToken,
    amount
  } = args;

  // Validate all required parameters
  if (!walletKey || !poolAddress || !inputToken || !outputToken || !amount) {
    throw new Error('Usage: node meteora-cp-amm-swap.js --wallet-key <key> --pool-address <address> --input-token <mint> --output-token <mint> --amount <amount>');
  }

  // Parse and validate amount
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new Error(`Invalid amount: ${amount}. Must be a positive number.`);
  }

  console.log('🔄 Initializing Meteora CP AMM direct pool swap...');
  console.log(`📍 Pool: ${poolAddress}`);
  console.log(`📊 Swapping ${parsedAmount} of ${inputToken.slice(0, 8)}... → ${outputToken.slice(0, 8)}...`);

  // Initialize connection and parse keys
  const connection = createConnection();
  const wallet = parsePrivateKey(walletKey);
  const poolPubkey = parsePublicKey(poolAddress);
  const inputTokenMint = parsePublicKey(inputToken);
  const outputTokenMint = parsePublicKey(outputToken);

  // Check initial balance
  const initialWalletBalance = await connection.getBalance(wallet.publicKey);

  console.log(`💰 Wallet SOL: ${(initialWalletBalance / 1e9).toFixed(6)} (also paying fees)`);

  // Get token decimals
  const inputTokenDecimals = await getTokenDecimals(connection, inputToken);
  const outputTokenDecimals = await getTokenDecimals(connection, outputToken);

  console.log(`🔢 Input token decimals: ${inputTokenDecimals}`);
  console.log(`🔢 Output token decimals: ${outputTokenDecimals}`);

  // Convert amount to smallest unit
  const amountInSmallestUnit = new BN(Math.floor(parsedAmount * Math.pow(10, inputTokenDecimals)));

  console.log(`📦 Amount in smallest unit: ${amountInSmallestUnit.toString()}`);

  // Initialize the CP AMM instance
  console.log('🏊 Initializing Meteora CP AMM instance...');
  const cpAmm = new CpAmm(connection);
  
  // Fetch pool state
  console.log('📊 Fetching pool state...');
  const poolState = await cpAmm.fetchPoolState(poolPubkey);
  
  console.log(`🪙 Pool Token A: ${poolState.tokenAMint.toString()}`);
  console.log(`🪙 Pool Token B: ${poolState.tokenBMint.toString()}`);
  console.log(`💧 Pool Liquidity: ${poolState.liquidity.toString()}`);

  // Get token mint details (decimals and program IDs)
  const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
  const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);
  
  const tokenAProgram = tokenAMintInfo?.owner || parsePublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const tokenBProgram = tokenBMintInfo?.owner || parsePublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  
  const tokenAParsedInfo = await connection.getParsedAccountInfo(poolState.tokenAMint);
  const tokenBParsedInfo = await connection.getParsedAccountInfo(poolState.tokenBMint);
  const tokenADecimals = tokenAParsedInfo.value?.data?.parsed?.info?.decimals || 9;
  const tokenBDecimals = tokenBParsedInfo.value?.data?.parsed?.info?.decimals || 9;

  console.log(`🔢 Pool Token A decimals: ${tokenADecimals}`);
  console.log(`🔢 Pool Token B decimals: ${tokenBDecimals}`);
  console.log(`📦 Token A Program: ${tokenAProgram.toString()}`);
  console.log(`📦 Token B Program: ${tokenBProgram.toString()}`);

  // Get current time and slot for quote calculation
  const currentSlot = await connection.getSlot();
  const currentTime = Math.floor(Date.now() / 1000);

  // Get swap quote
  console.log('💭 Getting swap quote...');
  const slippageBps = 2000; // 20% slippage tolerance (same as Jupiter script)
  
  const quoteResult = cpAmm.getQuote({
    inAmount: amountInSmallestUnit,
    inputTokenMint: inputTokenMint,
    slippage: slippageBps / 10000, // Convert bps to decimal (2000 bps = 0.20)
    poolState: poolState,
    currentTime: currentTime,
    currentSlot: currentSlot,
    tokenADecimal: tokenADecimals,
    tokenBDecimal: tokenBDecimals,
  });

  console.log(`📈 Expected output: ${quoteResult.swapOutAmount.toString()} (${(quoteResult.swapOutAmount.toNumber() / Math.pow(10, outputTokenDecimals)).toFixed(6)} tokens)`);
  console.log(`📉 Minimum output: ${quoteResult.minSwapOutAmount.toString()}`);
  console.log(`💸 Total fee: ${quoteResult.totalFee.toString()}`);
  console.log(`📊 Price impact: ${quoteResult.priceImpact.toFixed(4)}%`);

  // Execute the swap through the specific pool
  console.log('🚀 Building swap transaction...');
  
  const swapTx = await cpAmm.swap({
    payer: wallet.publicKey, // Wallet both swaps AND pays fees
    pool: poolPubkey,
    inputTokenMint: inputTokenMint,
    outputTokenMint: outputTokenMint,
    amountIn: amountInSmallestUnit,
    minimumAmountOut: quoteResult.minSwapOutAmount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: tokenAProgram,
    tokenBProgram: tokenBProgram,
    referralTokenAccount: null,
  });

  console.log('⏰ Getting recent blockhash...');
  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();
  swapTx.recentBlockhash = blockhash;
  swapTx.feePayer = wallet.publicKey;

  console.log('✍️  Signing transaction...');
  console.log(`   Wallet (payer + signer): ${wallet.publicKey.toString()}`);
  
  // Sign transaction with wallet
  swapTx.partialSign(wallet);

  console.log('📤 Sending transaction...');
  // Send and confirm transaction
  const signature = await connection.sendRawTransaction(swapTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  console.log(`📝 Transaction signature: ${signature}`);
  console.log('⏳ Confirming transaction...');

  await connection.confirmTransaction(signature, 'confirmed');

  console.log('✅ Transaction confirmed!');

  // Check final balance
  const finalWalletBalance = await connection.getBalance(wallet.publicKey);

  // Calculate metrics
  const inputAmountFormatted = parsedAmount;
  const outputAmountFormatted = quoteResult.swapOutAmount.toNumber() / Math.pow(10, outputTokenDecimals);
  const swapRate = outputAmountFormatted / inputAmountFormatted;
  const feesSpent = (initialWalletBalance - finalWalletBalance) / 1e9;

  console.log(`💸 Fees paid: ${feesSpent.toFixed(6)} SOL`);
  console.log(`📊 Swap rate: ${swapRate.toFixed(6)} output per input`);

  return createSuccessResponse({
    operation: 'meteora-cp-amm-swap',
    txSignature: signature,
    poolAddress: poolAddress,
    inputToken,
    outputToken,
    inputAmount: amountInSmallestUnit.toString(),
    outputAmount: quoteResult.swapOutAmount.toString(),
    inputAmountFormatted: inputAmountFormatted,
    outputAmountFormatted: outputAmountFormatted,
    swapRate: swapRate,
    inputTokenDecimals: inputTokenDecimals,
    outputTokenDecimals: outputTokenDecimals,
    walletAddress: wallet.publicKey.toString(),
    feesSpent: feesSpent,
    swapMode: 'ExactIn',
    slippageBps: slippageBps,
    priceImpact: quoteResult.priceImpact.toNumber()
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);

