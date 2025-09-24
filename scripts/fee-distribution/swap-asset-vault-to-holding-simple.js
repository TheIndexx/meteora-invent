#!/usr/bin/env node

/**
 * Simplified Asset Vault to Holding Wallet Swap
 *
 * This script performs a two-step process using Jupiter's standard swap API:
 * 1. Swap ALL SOL in Asset Vault to tokens (simple Jupiter swap)
 * 2. Transfer ALL tokens from Asset Vault to Holding Wallet (SPL token transfer)
 *
 * Platform wallet pays all transaction fees.
 *
 * Usage: node swap-asset-vault-to-holding-simple.js <assetVaultKey> <holdingWalletPubkey> <tokenMint> <platformWalletKey>
 */

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { parsePrivateKey, parsePublicKey } from './utils/solana.js';
import { JupiterSimpleSwap } from './utils/jupiter-simple.js';
import { createSuccessResponse, createErrorResponse, executeWithErrorHandling } from './utils/response.js';

// Environment setup
const RPC_URL = process.env.bands_solana_rpc || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

// SOL mint address (native SOL)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 4) {
    throw new Error('Usage: node swap-asset-vault-to-holding-simple.js <assetVaultKey> <holdingWalletPubkey> <tokenMint> <platformWalletKey>');
  }

  const [assetVaultKey, holdingWalletPubkey, tokenMint, platformWalletKey] = args;

  // Parse and validate inputs
  const assetVaultWallet = parsePrivateKey(assetVaultKey);
  const holdingWallet = parsePublicKey(holdingWalletPubkey);
  const platformWallet = parsePrivateKey(platformWalletKey);
  const tokenMintPubkey = parsePublicKey(tokenMint);

  console.log('🔄 Starting Simplified Asset Vault → Holding Wallet Swap');
  console.log(`   Asset Vault: ${assetVaultWallet.publicKey.toBase58()}`);
  console.log(`   Holding Wallet: ${holdingWallet.toBase58()}`);
  console.log(`   Token Mint: ${tokenMintPubkey.toBase58()}`);
  console.log(`   Platform Wallet: ${platformWallet.publicKey.toBase58()}`);

  // Get initial balances
  const initialAssetVaultBalance = await connection.getBalance(assetVaultWallet.publicKey);
  const initialPlatformBalance = await connection.getBalance(platformWallet.publicKey);

  console.log(`\n💰 Initial Balances:`);
  console.log(`   Asset Vault: ${(initialAssetVaultBalance / 1e9).toFixed(6)} SOL`);
  console.log(`   Platform Wallet: ${(initialPlatformBalance / 1e9).toFixed(6)} SOL`);

  // Calculate SOL amount to swap (all available minus rent exemption)
  const RENT_EXEMPTION = 0.00089; // ~890k lamports for rent exemption
  const actualSolAmount = Math.max(0, (initialAssetVaultBalance / 1e9) - RENT_EXEMPTION);

  if (actualSolAmount < 0.001) {
    throw new Error(`Insufficient balance for swap: ${(initialAssetVaultBalance / 1e9).toFixed(6)} SOL (need > ${RENT_EXEMPTION + 0.001} SOL)`);
  }

  console.log(`\n🎯 Swapping ${actualSolAmount.toFixed(6)} SOL (keeping ${RENT_EXEMPTION} SOL for rent)`);

  // Get token decimals for calculations
  const tokenInfo = await connection.getParsedAccountInfo(tokenMintPubkey);
  let tokenDecimals = 9; // Default fallback
  if (tokenInfo.value && tokenInfo.value.data.parsed && tokenInfo.value.data.parsed.info) {
    tokenDecimals = tokenInfo.value.data.parsed.info.decimals;
  }

  // STEP 1: Simple Jupiter Swap (SOL → Tokens in Asset Vault)
  console.log('\n📈 Step 1: Swapping SOL to tokens (simple Jupiter swap)');

  const jupiter = new JupiterSimpleSwap();

  let swapResult;
  try {
    swapResult = await jupiter.executeSwap({
      walletKey: assetVaultKey,       // Asset vault owns and swaps the SOL
      inputToken: SOL_MINT,            // Swapping from SOL
      outputToken: tokenMint,          // Swapping to specified token
      amount: actualSolAmount,         // Amount of SOL to swap
      feePayerKey: platformWalletKey, // Platform wallet pays transaction fees
      slippageBps: 2000,              // 20% slippage tolerance
      maxRetries: 3
    });
  } catch (error) {
    throw new Error(`Step 1 failed: ${error.message}`);
  }

  console.log(`✅ Step 1 Complete: ${swapResult.signature}`);
  console.log(`   SOL spent: ${swapResult.inputAmountFormatted.toFixed(6)}`);
  console.log(`   Tokens received: ${swapResult.outputAmountFormatted.toFixed(6)}`);
  console.log(`   Swap rate: ${swapResult.swapRate.toFixed(6)} tokens per SOL`);

  // Wait a moment for the swap to settle
  await new Promise(resolve => setTimeout(resolve, 2000));

  // STEP 2: Transfer ALL tokens (Asset Vault → Holding Wallet)
  console.log('\n📤 Step 2: Transferring ALL tokens to Holding Wallet');

  const tokenTransferResult = await transferAllTokens({
    fromWallet: assetVaultWallet,
    toWallet: holdingWallet,
    tokenMint: tokenMintPubkey,
    platformWallet,
    tokenDecimals
  });

  if (!tokenTransferResult.success) {
    throw new Error(`Step 2 failed: ${tokenTransferResult.error || 'Unknown transfer error'}`);
  }

  console.log(`✅ Step 2 Complete: ${tokenTransferResult.signature}`);
  console.log(`   Tokens transferred: ${tokenTransferResult.tokensTransferred}`);

  // Final balances
  const finalAssetVaultBalance = await connection.getBalance(assetVaultWallet.publicKey);
  const finalPlatformBalance = await connection.getBalance(platformWallet.publicKey);

  console.log(`\n💰 Final Balances:`);
  console.log(`   Asset Vault: ${(finalAssetVaultBalance / 1e9).toFixed(6)} SOL`);
  console.log(`   Platform Wallet: ${(finalPlatformBalance / 1e9).toFixed(6)} SOL`);

  // Calculate total fees spent
  const totalFeesSpent = (initialPlatformBalance - finalPlatformBalance) / 1e9;
  console.log(`\n📊 Total transaction fees: ${totalFeesSpent.toFixed(6)} SOL`);

  return createSuccessResponse({
    operation: 'swap-asset-vault-to-holding-simple',
    step1Signature: swapResult.signature,
    step2Signature: tokenTransferResult.signature,
    inputAmount: swapResult.inputAmount,
    outputAmount: swapResult.outputAmount,
    solAmountSpent: actualSolAmount,
    tokenMint: tokenMint,
    assetVaultPubkey: assetVaultWallet.publicKey.toBase58(),
    holdingWalletPubkey: holdingWalletPubkey,
    feeStrategy: 'platform-wallet-pays',
    swapMode: 'ExactIn',
    swapRate: swapResult.swapRate,
    tokensReceived: swapResult.outputAmountFormatted,
    tokensTransferred: tokenTransferResult.tokensTransferred,
    tokenDecimals: tokenDecimals,
    totalFeesSpent: totalFeesSpent,
    initialBalances: {
      assetVault: initialAssetVaultBalance / 1e9,
      platformWallet: initialPlatformBalance / 1e9
    },
    finalBalances: {
      assetVault: finalAssetVaultBalance / 1e9,
      platformWallet: finalPlatformBalance / 1e9
    }
  });
}

/**
 * Transfer ALL tokens from asset vault to holding wallet
 */
async function transferAllTokens({ fromWallet, toWallet, tokenMint, platformWallet, tokenDecimals }) {
  try {
    console.log(`   From: ${fromWallet.publicKey.toBase58()}`);
    console.log(`   To: ${toWallet.toBase58()}`);

    // Get ATAs for both wallets
    const fromATA = await getAssociatedTokenAddress(
      tokenMint,
      fromWallet.publicKey,
      true, // Allow owner to be off curve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const toATA = await getAssociatedTokenAddress(
      tokenMint,
      toWallet,
      true, // Allow owner to be off curve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log(`   From ATA: ${fromATA.toBase58()}`);
    console.log(`   To ATA: ${toATA.toBase58()}`);

    // Get current token balance in source ATA
    const fromATAInfo = await connection.getTokenAccountBalance(fromATA);
    if (!fromATAInfo.value || fromATAInfo.value.uiAmount === 0) {
      throw new Error('No tokens found in source account');
    }

    const tokenAmount = fromATAInfo.value.amount; // Raw amount (with decimals)
    const uiAmount = fromATAInfo.value.uiAmount; // Human readable amount

    console.log(`   Available tokens: ${uiAmount} (${tokenAmount} raw)`);

    // Check if destination ATA exists, create if needed
    const toATAInfo = await connection.getAccountInfo(toATA);
    const transaction = new Transaction();

    if (!toATAInfo) {
      console.log(`   Creating destination ATA...`);

      transaction.add(
        createAssociatedTokenAccountInstruction(
          platformWallet.publicKey, // payer
          toATA, // ata
          toWallet, // owner
          tokenMint, // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Add transfer instruction for ALL tokens
    transaction.add(
      createTransferInstruction(
        fromATA, // source
        toATA, // destination
        fromWallet.publicKey, // owner of source account
        BigInt(tokenAmount), // transfer ALL tokens
        [], // multiSigners (empty for single signer)
        TOKEN_PROGRAM_ID
      )
    );

    // Set recent blockhash and fee payer
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = platformWallet.publicKey;

    // Sign transaction with both wallets
    // Platform wallet pays fees, asset vault authorizes token transfer
    transaction.sign(platformWallet, fromWallet);

    // Send transaction
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');

    return {
      success: true,
      signature,
      fromATA: fromATA.toBase58(),
      toATA: toATA.toBase58(),
      amount: tokenAmount,
      tokensTransferred: uiAmount
    };

  } catch (error) {
    console.error(`Token transfer failed: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Execute with error handling
executeWithErrorHandling(main);