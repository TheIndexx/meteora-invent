#!/usr/bin/env node

/**
 * Silent SOL Distribution Script for Testing
 *
 * Same as distribute-sol.js but with no console output
 * Only outputs JSON for test script parsing
 */

import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';
import { createConnection, parsePrivateKey, parsePublicKey } from './utils/solana.js';
import { SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';

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

  // Validate parameters
  if (!feeWalletKey || !platformPubkey || !creatorPubkey || platformAmount === undefined || creatorAmount === undefined || !platformWalletKey) {
    throw new Error('Usage: node distribute-sol-silent.js <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>');
  }

  const parsedPlatformAmount = parseFloat(platformAmount);
  const parsedCreatorAmount = parseFloat(creatorAmount);

  if (isNaN(parsedPlatformAmount) || isNaN(parsedCreatorAmount)) {
    throw new Error('Platform and creator amounts must be valid numbers');
  }

  if (parsedPlatformAmount < 0 || parsedCreatorAmount < 0) {
    throw new Error('Amounts must be non-negative');
  }

  // Initialize wallets and connection
  const connection = createConnection();
  const feeWallet = parsePrivateKey(feeWalletKey);
  const platformWallet = parsePrivateKey(platformWalletKey);
  const platformPubkeyParsed = parsePublicKey(platformPubkey);
  const creatorPubkeyParsed = parsePublicKey(creatorPubkey);

  // Check initial balance
  const initialBalance = await connection.getBalance(feeWallet.publicKey);

  const transfers = [];
  let totalTransferred = 0;

  // Platform transfer
  if (parsedPlatformAmount > 0.0001) {
    const platformLamports = Math.floor(parsedPlatformAmount * LAMPORTS_PER_SOL);

    // Create platform transfer transaction
    const platformTx = SystemProgram.transfer({
      fromPubkey: feeWallet.publicKey,
      toPubkey: platformPubkeyParsed,
      lamports: platformLamports,
    });

    // Create transaction with platform wallet as fee payer
    const { Transaction } = await import('@solana/web3.js');
    const transaction = new Transaction().add(platformTx);
    transaction.feePayer = platformWallet.publicKey;

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Sign with both wallets
    transaction.sign(platformWallet, feeWallet);

    // Send transaction
    const platformTxSignature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(platformTxSignature, 'confirmed');

    transfers.push({
      recipient: 'platform',
      amount: parsedPlatformAmount,
      pubkey: platformPubkey,
      txSignature: platformTxSignature
    });

    totalTransferred += parsedPlatformAmount;
  }

  // Creator transfer
  if (parsedCreatorAmount > 0.0001) {
    const creatorLamports = Math.floor(parsedCreatorAmount * LAMPORTS_PER_SOL);

    // Create creator transfer transaction
    const creatorTx = SystemProgram.transfer({
      fromPubkey: feeWallet.publicKey,
      toPubkey: creatorPubkeyParsed,
      lamports: creatorLamports,
    });

    // Create transaction with platform wallet as fee payer
    const { Transaction } = await import('@solana/web3.js');
    const transaction = new Transaction().add(creatorTx);
    transaction.feePayer = platformWallet.publicKey;

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Sign with both wallets
    transaction.sign(platformWallet, feeWallet);

    // Send transaction
    const creatorTxSignature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(creatorTxSignature, 'confirmed');

    transfers.push({
      recipient: 'creator',
      amount: parsedCreatorAmount,
      pubkey: creatorPubkey,
      txSignature: creatorTxSignature
    });

    totalTransferred += parsedCreatorAmount;
  }

  // Check final balance
  const finalBalance = await connection.getBalance(feeWallet.publicKey);

  return createSuccessResponse({
    operation: 'distribute-sol',
    transfers: transfers,
    totalTransferred: totalTransferred,
    platformAmount: parsedPlatformAmount,
    creatorAmount: parsedCreatorAmount,
    feeStrategy: 'platform-wallet-pays',
    transferCount: transfers.length
  });
}

// Execute with error handling
executeWithErrorHandling(main);