#!/usr/bin/env node

/**
 * Silent Jupiter Custom Transaction Swap Script for Testing
 *
 * Same as swap-fee-to-asset-custom.js but with no console output
 * Only outputs JSON for test script parsing
 */

import { JupiterCustomTxBuilderSilent } from './utils/jupiter-custom-tx-silent.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';
import { createConnection, parsePrivateKey } from './utils/solana.js';

async function main() {
  const [
    ,, // Skip node and script path
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount,
    platformWalletKey
  ] = process.argv;

  // Validate parameters
  if (!feeWalletKey || !assetVaultPubkey || !tokenMint || !solAmount || !platformWalletKey) {
    throw new Error('Usage: node swap-fee-to-asset-silent.js <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>');
  }

  const parsedSolAmount = parseFloat(solAmount);
  if (isNaN(parsedSolAmount) || parsedSolAmount <= 0) {
    throw new Error(`Invalid SOL amount: ${solAmount}`);
  }

  // Check initial balances (silently)
  const connection = createConnection();
  const feeWallet = parsePrivateKey(feeWalletKey);
  const platformWallet = parsePrivateKey(platformWalletKey);

  const initialFeeBalance = await connection.getBalance(feeWallet.publicKey);
  const initialPlatformBalance = await connection.getBalance(platformWallet.publicKey);

  // Validate balances
  if (initialFeeBalance < parsedSolAmount * 1e9) {
    throw new Error(`Insufficient fee wallet balance: ${initialFeeBalance / 1e9} SOL < ${parsedSolAmount} SOL`);
  }

  if (initialPlatformBalance < 0.01 * 1e9) {
    throw new Error(`Insufficient platform wallet balance for fees: ${initialPlatformBalance / 1e9} SOL`);
  }

  // Execute swap with custom transaction
  const builder = new JupiterCustomTxBuilderSilent();
  const result = await builder.executeSwapWithCustomPayer({
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount: parsedSolAmount,
    platformWalletKey,
    slippageBps: 2000,
    maxRetries: 3
  });

  // Check final balances
  const finalFeeBalance = await connection.getBalance(feeWallet.publicKey);
  const finalPlatformBalance = await connection.getBalance(platformWallet.publicKey);

  return createSuccessResponse({
    operation: 'swap-fee-to-asset-custom',
    signature: result.signature,
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    solAmountSpent: parsedSolAmount,
    tokenMint,
    assetVaultPubkey,
    feeStrategy: 'platform-wallet-pays-fees',
    swapMode: 'Custom Transaction',
    feeWalletSpent: (initialFeeBalance - finalFeeBalance) / 1e9,
    platformWalletFeesSpent: (initialPlatformBalance - finalPlatformBalance) / 1e9
  });
}

// Execute with error handling
executeWithErrorHandling(main);