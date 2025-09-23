#!/usr/bin/env node

/**
 * Single SOL Transfer Script
 *
 * This script handles a single SOL transfer between two wallets with configurable fee payer.
 * Designed for fee distribution where platform wallet typically pays transaction fees.
 *
 * Usage:
 * node distribute-sol.js <fromWalletKey> <toWalletPubkey> <amount> <feePayerWalletKey>
 *
 * Returns JSON response for Python integration
 */

import { transferSol, parsePrivateKey, parsePublicKey, createConnection } from './utils/solana.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';

async function main() {
  const [
    ,, // Skip node and script path
    fromWalletKey,
    toWalletPubkey,
    amount,
    feePayerWalletKey
  ] = process.argv;

  // Validate all required parameters are provided
  if (!fromWalletKey || !toWalletPubkey || !amount || !feePayerWalletKey) {
    throw new Error('Usage: node distribute-sol.js <fromWalletKey> <toWalletPubkey> <amount> <feePayerWalletKey>');
  }

  // Parse and validate amount
  const parsedAmount = parseFloat(amount);

  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new Error(`Invalid amount: ${amount}. Must be a positive number.`);
  }

  // Validate key formats
  const fromWallet = parsePrivateKey(fromWalletKey);
  const toWalletPubkeyObj = parsePublicKey(toWalletPubkey);
  const feePayerWallet = parsePrivateKey(feePayerWalletKey);

  const connection = createConnection();

  // Check initial balance of sender
  const initialBalance = await connection.getBalance(fromWallet.publicKey);
  const initialBalanceSol = initialBalance / 1e9;

  // Perform the transfer
  const txSignature = await transferSol(
    connection,
    fromWallet,
    toWalletPubkeyObj,
    parsedAmount,
    feePayerWalletKey // Custom fee payer
  );

  // Check final balance of sender
  const finalBalance = await connection.getBalance(fromWallet.publicKey);
  const finalBalanceSol = finalBalance / 1e9;

  return createSuccessResponse({
    operation: 'single-sol-transfer',
    fromWallet: fromWallet.publicKey.toString(),
    toWallet: toWalletPubkey,
    amount: parsedAmount,
    txSignature: txSignature,
    feePayer: feePayerWallet.publicKey.toString(),
    initialBalance: initialBalanceSol,
    finalBalance: finalBalanceSol,
    balanceChange: finalBalanceSol - initialBalanceSol
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);