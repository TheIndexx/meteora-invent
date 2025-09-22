#!/usr/bin/env node

/**
 * Jupiter Payments-as-Swap Script for Fee Distribution
 *
 * This script implements the payments-as-swap approach where:
 * - Platform wallet pays all transaction fees (fee payer)
 * - Fee wallet provides the SOL for the swap (token source)
 * - Asset vault receives tokens directly (destination)
 * - Uses ExactIn mode with Jupiter SDK
 *
 * Usage:
 * node swap-fee-to-asset.js <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>
 *
 * Returns JSON response for Python integration
 */

import { JupiterPaymentsAsSwap } from './utils/jupiter.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';

async function main() {
  const [
    ,, // Skip node and script path
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount,
    platformWalletKey
  ] = process.argv;

  // Validate all required parameters are provided
  if (!feeWalletKey || !assetVaultPubkey || !tokenMint || !solAmount || !platformWalletKey) {
    throw new Error('Usage: node swap-fee-to-asset.js <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>');
  }

  // Parse and validate SOL amount
  const parsedSolAmount = parseFloat(solAmount);
  if (isNaN(parsedSolAmount) || parsedSolAmount <= 0) {
    throw new Error(`Invalid SOL amount: ${solAmount}. Must be a positive number.`);
  }

  // Initialize Jupiter payments-as-swap
  const jupiter = new JupiterPaymentsAsSwap();

  // Validate parameters before execution
  jupiter.validateSwapParams({
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount: parsedSolAmount,
    platformWalletKey
  });

  console.log('🚀 Starting Jupiter payments-as-swap...');
  console.log(`  💰 Amount: ${parsedSolAmount} SOL`);
  console.log(`  🎯 Asset Vault: ${assetVaultPubkey.slice(0, 8)}...${assetVaultPubkey.slice(-8)}`);
  console.log(`  🪙 Token: ${tokenMint.slice(0, 8)}...${tokenMint.slice(-8)}`);
  console.log(`  💳 Fee Payer: Platform Wallet`);
  console.log(`  📊 Mode: ExactIn`);

  // Check fee wallet balance before swap
  const { createConnection, parsePrivateKey } = await import('./utils/solana.js');
  const connection = createConnection();
  const feeWallet = parsePrivateKey(feeWalletKey);
  const initialBalance = await connection.getBalance(feeWallet.publicKey);
  console.log(`  📊 Fee wallet balance before swap: ${initialBalance / 1e9} SOL (${initialBalance} lamports)`);

  // Execute the payments-as-swap
  const result = await jupiter.executePaymentAsSwap({
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount: parsedSolAmount,
    platformWalletKey,
    slippageBps: 2000, // 20% slippage tolerance for reliability
    maxRetries: 3
  });

  // Check fee wallet balance after swap
  const finalBalance = await connection.getBalance(feeWallet.publicKey);
  console.log(`  📊 Fee wallet balance after swap: ${finalBalance / 1e9} SOL (${finalBalance} lamports)`);
  console.log(`  📊 Balance difference: ${(initialBalance - finalBalance) / 1e9} SOL`);
  console.log(`  📊 Expected difference: ${parsedSolAmount} SOL`);

  return createSuccessResponse({
    operation: 'swap-fee-to-asset',
    txSignature: result.signature,
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    solAmountSpent: parsedSolAmount,
    tokenMint,
    assetVaultPubkey,
    feeStrategy: 'platform-wallet-pays',
    swapMode: 'ExactIn'
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);