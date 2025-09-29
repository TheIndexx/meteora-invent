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
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID as ATA_PROGRAM_ID
} from '@solana/spl-token';
import { parsePrivateKey, parsePublicKey } from './utils/solana.js';
import { JupiterSimpleSwap } from './utils/jupiter-simple.js';
import { createSuccessResponse, createErrorResponse, executeWithErrorHandling } from './utils/response.js';

// Environment setup
const RPC_URL = process.env.bands_solana_rpc || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, 'confirmed');

// SOL mint address (native SOL)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Detect which token program a mint uses
 */
async function detectTokenProgram(connection, mintAddress) {
  try {
    const mintInfo = await connection.getAccountInfo(mintAddress);
    
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mintAddress.toBase58()}`);
    }
    
    const owner = mintInfo.owner.toBase58();
    
    if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) {
      console.log(`🔍 Detected Token 2022 Program for mint: ${mintAddress.toBase58()}`);
      return {
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        ataProgram: ATA_PROGRAM_ID // ATA program is the same for both
      };
    } else if (owner === TOKEN_PROGRAM_ID.toBase58()) {
      console.log(`🔍 Detected Standard Token Program for mint: ${mintAddress.toBase58()}`);
      return {
        tokenProgram: TOKEN_PROGRAM_ID,
        ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID
      };
    } else {
      console.log(`⚠️ Unknown token program owner: ${owner}, defaulting to standard Token Program`);
      return {
        tokenProgram: TOKEN_PROGRAM_ID,
        ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID
      };
    }
  } catch (error) {
    console.error(`❌ Error detecting token program: ${error.message}`);
    // Default to standard Token Program on error
    return {
      tokenProgram: TOKEN_PROGRAM_ID,
      ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID
    };
  }
}

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
  const RENT_EXEMPTION = 0.0025; // Increased to 1.5k lamports for better safety margin
  const actualSolAmount = Math.max(0, (initialAssetVaultBalance / 1e9) - RENT_EXEMPTION);

  console.log(`\n📊 Balance Analysis:`);
  console.log(`   Total Asset Vault Balance: ${(initialAssetVaultBalance / 1e9).toFixed(6)} SOL`);
  console.log(`   Rent Exemption Reserved: ${RENT_EXEMPTION.toFixed(6)} SOL`);
  console.log(`   Available for Swap: ${actualSolAmount.toFixed(6)} SOL`);

  if (actualSolAmount < 0.001) {
    throw new Error(`Insufficient balance for swap: ${(initialAssetVaultBalance / 1e9).toFixed(6)} SOL (need > ${RENT_EXEMPTION + 0.001} SOL)`);
  }

  console.log(`\n🎯 Proceeding with swap of ${actualSolAmount.toFixed(6)} SOL`);

  // Get token decimals and detect token program
  console.log(`\n🔍 Token Information:`);
  console.log(`   Token Mint: ${tokenMintPubkey.toBase58()}`);
  
  const tokenInfo = await connection.getParsedAccountInfo(tokenMintPubkey);
  let tokenDecimals = 9; // Default fallback
  if (tokenInfo.value && tokenInfo.value.data.parsed && tokenInfo.value.data.parsed.info) {
    tokenDecimals = tokenInfo.value.data.parsed.info.decimals;
    console.log(`   Token Decimals: ${tokenDecimals}`);
  } else {
    console.log(`   ⚠️  Could not fetch token info, using default decimals: ${tokenDecimals}`);
  }

  // Detect token program
  const { tokenProgram, ataProgram } = await detectTokenProgram(connection, tokenMintPubkey);
  console.log(`   Token Program: ${tokenProgram.toBase58()}`);
  console.log(`   ATA Program: ${ataProgram.toBase58()}`);

  // STEP 1: Simple Jupiter Swap (SOL → Tokens in Asset Vault)
  console.log('\n📈 Step 1: Swapping SOL to tokens (simple Jupiter swap)');
  console.log(`   Input: ${actualSolAmount.toFixed(6)} SOL`);
  console.log(`   Output: ${tokenMintPubkey.toBase58()}`);
  console.log(`   Slippage: 20%`);

  const jupiter = new JupiterSimpleSwap();

  let swapResult;
  try {
    console.log(`\n🔄 Executing Jupiter swap...`);
    swapResult = await jupiter.executeSwap({
      walletKey: assetVaultKey,       // Asset vault owns and swaps the SOL
      inputToken: SOL_MINT,            // Swapping from SOL
      outputToken: tokenMint,          // Swapping to specified token
      amount: actualSolAmount,         // Amount of SOL to swap
      feePayerKey: platformWalletKey, // Platform wallet pays transaction fees
      slippageBps: 2000,              // 20% slippage tolerance
      maxRetries: 3
    });
    console.log(`✅ Jupiter swap completed successfully`);
  } catch (error) {
    console.error(`❌ Jupiter swap failed: ${error.message}`);
    throw new Error(`Step 1 failed: ${error.message}`);
  }

  console.log(`\n📊 Step 1 Results:`);
  console.log(`   Transaction: ${swapResult.signature}`);
  console.log(`   SOL spent: ${swapResult.inputAmountFormatted.toFixed(6)}`);
  console.log(`   Tokens received: ${swapResult.outputAmountFormatted.toFixed(6)}`);
  console.log(`   Swap rate: ${swapResult.swapRate.toFixed(6)} tokens per SOL`);

  // Wait a moment for the swap to settle
  console.log(`\n⏳ Waiting 2 seconds for swap to settle...`);
  await new Promise(resolve => setTimeout(resolve, 2000));

  // STEP 2: Transfer ALL tokens (Asset Vault → Holding Wallet)
  console.log('\n📤 Step 2: Transferring ALL tokens to Holding Wallet');
  console.log(`   From: ${assetVaultWallet.publicKey.toBase58()}`);
  console.log(`   To: ${holdingWallet.toBase58()}`);
  console.log(`   Token: ${tokenMintPubkey.toBase58()}`);

  const tokenTransferResult = await transferAllTokens({
    fromWallet: assetVaultWallet,
    toWallet: holdingWallet,
    tokenMint: tokenMintPubkey,
    platformWallet,
    tokenDecimals,
    tokenProgram,
    ataProgram
  });

  if (!tokenTransferResult.success) {
    console.error(`❌ Token transfer failed: ${tokenTransferResult.error}`);
    throw new Error(`Step 2 failed: ${tokenTransferResult.error || 'Unknown transfer error'}`);
  }

  console.log(`\n📊 Step 2 Results:`);
  console.log(`   Transaction: ${tokenTransferResult.signature}`);
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
async function transferAllTokens({ fromWallet, toWallet, tokenMint, platformWallet, tokenDecimals, tokenProgram, ataProgram }) {
  try {
    console.log(`\n🔍 Transfer Details:`);
    console.log(`   From Wallet: ${fromWallet.publicKey.toBase58()}`);
    console.log(`   To Wallet: ${toWallet.toBase58()}`);
    console.log(`   Token Mint: ${tokenMint.toBase58()}`);

    // Get ATAs for both wallets using detected token program
    const fromATA = await getAssociatedTokenAddress(
      tokenMint,
      fromWallet.publicKey,
      true, // Allow owner to be off curve
      tokenProgram,
      ataProgram
    );

    const toATA = await getAssociatedTokenAddress(
      tokenMint,
      toWallet,
      true, // Allow owner to be off curve
      tokenProgram,
      ataProgram
    );

    console.log(`\n🏦 Token Account Addresses:`);
    console.log(`   From ATA: ${fromATA.toBase58()}`);
    console.log(`   To ATA: ${toATA.toBase58()}`);

    // Check if source ATA exists
    console.log(`\n🔍 Checking source token account...`);
    const fromATAInfo = await connection.getAccountInfo(fromATA);
    if (!fromATAInfo) {
      throw new Error(`Source token account does not exist: ${fromATA.toBase58()}`);
    }
    console.log(`✅ Source token account exists`);

    // Get current token balance in source ATA
    console.log(`\n💰 Checking token balance...`);
    const fromATABalance = await connection.getTokenAccountBalance(fromATA);
    if (!fromATABalance.value || fromATABalance.value.uiAmount === 0) {
      throw new Error('No tokens found in source account');
    }

    const tokenAmount = fromATABalance.value.amount; // Raw amount (with decimals)
    const uiAmount = fromATABalance.value.uiAmount; // Human readable amount

    console.log(`✅ Token balance found:`);
    console.log(`   UI Amount: ${uiAmount}`);
    console.log(`   Raw Amount: ${tokenAmount}`);

    // Check if destination ATA exists, create if needed
    console.log(`\n🔍 Checking destination token account...`);
    const toATAInfo = await connection.getAccountInfo(toATA);
    const transaction = new Transaction();

    if (!toATAInfo) {
      console.log(`📝 Creating destination ATA...`);
      console.log(`   ATA Address: ${toATA.toBase58()}`);
      console.log(`   Owner: ${toWallet.toBase58()}`);
      console.log(`   Token Mint: ${tokenMint.toBase58()}`);

      transaction.add(
        createAssociatedTokenAccountInstruction(
          platformWallet.publicKey, // payer
          toATA, // ata
          toWallet, // owner
          tokenMint, // mint
          tokenProgram,
          ataProgram
        )
      );
    } else {
      console.log(`✅ Destination ATA already exists`);
    }

    // Add transfer instruction for ALL tokens
    console.log(`\n💸 Adding transfer instruction...`);
    console.log(`   Transferring: ${uiAmount} tokens (${tokenAmount} raw)`);
    console.log(`   Using ${tokenProgram === TOKEN_2022_PROGRAM_ID ? 'TransferChecked' : 'Transfer'} instruction`);
    
    if (tokenProgram === TOKEN_2022_PROGRAM_ID) {
      // Token 2022 requires transferChecked instruction
      transaction.add(
        createTransferCheckedInstruction(
          fromATA, // source
          tokenMint, // mint (required for transferChecked)
          toATA, // destination
          fromWallet.publicKey, // owner of source account
          BigInt(tokenAmount), // transfer ALL tokens
          tokenDecimals, // decimals (required for transferChecked)
          [], // multiSigners (empty for single signer)
          tokenProgram
        )
      );
    } else {
      // Standard Token Program uses regular transfer instruction
      transaction.add(
        createTransferInstruction(
          fromATA, // source
          toATA, // destination
          fromWallet.publicKey, // owner of source account
          BigInt(tokenAmount), // transfer ALL tokens
          [], // multiSigners (empty for single signer)
          tokenProgram
        )
      );
    }

    // Set recent blockhash and fee payer
    console.log(`\n🔧 Setting up transaction...`);
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = platformWallet.publicKey;

    console.log(`   Fee Payer: ${platformWallet.publicKey.toBase58()}`);
    console.log(`   Blockhash: ${blockhash}`);

    // Sign transaction with both wallets
    // Platform wallet pays fees, asset vault authorizes token transfer
    console.log(`\n✍️  Signing transaction...`);
    transaction.sign(platformWallet, fromWallet);

    // Send transaction
    console.log(`\n📡 Sending transaction...`);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    console.log(`   Transaction signature: ${signature}`);

    // Wait for confirmation
    console.log(`\n⏳ Waiting for confirmation...`);
    await connection.confirmTransaction(signature, 'confirmed');
    console.log(`✅ Transaction confirmed`);

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