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


  // Check fee wallet balance before swap
  const { createConnection, parsePrivateKey, parsePublicKey } = await import('./utils/solana.js');
  const { PublicKey } = await import('@solana/web3.js');
  const connection = createConnection();
  const feeWallet = parsePrivateKey(feeWalletKey);
  const initialBalance = await connection.getBalance(feeWallet.publicKey);

  // Get token decimals for price calculation
  const tokenMintPubkey = new PublicKey(tokenMint);
  const tokenInfo = await connection.getParsedAccountInfo(tokenMintPubkey);
  let tokenDecimals = 9; // Default fallback
  if (tokenInfo.value && tokenInfo.value.data.parsed && tokenInfo.value.data.parsed.info) {
    tokenDecimals = tokenInfo.value.data.parsed.info.decimals;
  }

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

  // Calculate buy price (SOL per token)
  // inAmount is in lamports (SOL with 9 decimals)
  // outAmount is in token's smallest unit
  const solSpent = parseFloat(result.inputAmount) / 1e9; // Convert lamports to SOL
  const tokensReceived = parseFloat(result.outputAmount) / Math.pow(10, tokenDecimals); // Convert to token units
  const buyPrice = solSpent / tokensReceived; // SOL per token

  return createSuccessResponse({
    operation: 'swap-fee-to-asset',
    txSignature: result.signature,
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    solAmountSpent: parsedSolAmount,
    tokenMint,
    assetVaultPubkey,
    feeStrategy: 'platform-wallet-pays',
    swapMode: 'ExactIn',
    buyPrice: buyPrice, // SOL per token
    tokensReceived: tokensReceived, // Actual tokens received
    tokenDecimals: tokenDecimals
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);