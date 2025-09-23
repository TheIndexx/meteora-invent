#!/usr/bin/env node

/**
 * SOL Distribution Script
 *
 * This script handles SOL transfers for fee distribution where:
 * - Platform wallet pays transaction fees for all transfers
 * - Fee wallet sends SOL to platform and creator wallets
 * - Simple SOL transfers, no token swaps involved
 *
 * Usage:
 * node distribute-sol.js <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>
 *
 * Returns JSON response for Python integration
 */

import { transferSol, parsePrivateKey, parsePublicKey, createConnection } from './utils/solana.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';

async function main() {
  const [
    ,, // Skip node and script path
    feeWalletKey,
    platformPubkey,
    creatorPubkey,
    platformAmount,
    creatorAmount,
    platformWalletKey
  ] = process.argv;

  // Validate all required parameters are provided
  if (!feeWalletKey || !platformPubkey || !creatorPubkey || !platformAmount || !creatorAmount || !platformWalletKey) {
    throw new Error('Usage: node distribute-sol.js <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>');
  }

  // Parse and validate amounts
  const parsedPlatformAmount = parseFloat(platformAmount);
  const parsedCreatorAmount = parseFloat(creatorAmount);

  if (isNaN(parsedPlatformAmount) || parsedPlatformAmount < 0) {
    throw new Error(`Invalid platform amount: ${platformAmount}. Must be a non-negative number.`);
  }

  if (isNaN(parsedCreatorAmount) || parsedCreatorAmount < 0) {
    throw new Error(`Invalid creator amount: ${creatorAmount}. Must be a non-negative number.`);
  }

  // Validate key formats
  const feeWallet = parsePrivateKey(feeWalletKey);
  const platformPubkeyObj = parsePublicKey(platformPubkey);
  const creatorPubkeyObj = parsePublicKey(creatorPubkey);
  const platformWallet = parsePrivateKey(platformWalletKey);

  const connection = createConnection();
  const results = [];


  // Check initial balance of fee wallet
  const initialBalance = await connection.getBalance(feeWallet.publicKey);

  // Transfer to platform wallet (if amount > 0)
  if (parsedPlatformAmount > 0.0001) { // Only transfer meaningful amounts

    const platformTxSignature = await transferSol(
      connection,
      feeWallet,
      platformPubkeyObj,
      parsedPlatformAmount,
      platformWalletKey // Platform wallet pays fees
    );

    results.push({
      recipient: 'platform',
      amount: parsedPlatformAmount,
      pubkey: platformPubkey,
      txSignature: platformTxSignature
    });

  } else {
  }

  // Transfer to creator wallet
  if (parsedCreatorAmount > 0.0001) { // Only transfer meaningful amounts

    const creatorTxSignature = await transferSol(
      connection,
      feeWallet,
      creatorPubkeyObj,
      parsedCreatorAmount,
      platformWalletKey // Platform wallet pays fees
    );

    results.push({
      recipient: 'creator',
      amount: parsedCreatorAmount,
      pubkey: creatorPubkey,
      txSignature: creatorTxSignature
    });

  } else {
  }

  const totalTransferred = results.reduce((sum, result) => sum + result.amount, 0);

  // Check final balance of fee wallet
  const finalBalance = await connection.getBalance(feeWallet.publicKey);

  return createSuccessResponse({
    operation: 'distribute-sol',
    transfers: results,
    totalTransferred,
    platformAmount: parsedPlatformAmount,
    creatorAmount: parsedCreatorAmount,
    feeStrategy: 'platform-wallet-pays',
    transferCount: results.length
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);