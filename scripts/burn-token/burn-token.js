#!/usr/bin/env node

/**
 * SPL Token Burn Utility
 * 
 * Burns a specified amount of SPL tokens from a wallet.
 * 
 * Usage:
 *   node burn-token.js --wallet <private_key> --mint <token_mint> --amount <amount>
 * 
 * Example:
 *   node burn-token.js --wallet e2TnZygamUdb8PHCLD32aZqicBXLF1DWEmQhccmKGRT5qXBVL884LDH7Sj9x9PUXQZGNz7QyFCeGBKCZkoDAfK1 --mint 3fqLKodK2oGgHuk3hrSfJeHTmv2g7472bq3F33o5apjx --amount 100
 */

import { Command } from 'commander';
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  burn,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import bs58 from 'bs58';

// Configuration
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const COMMITMENT = 'confirmed';

/**
 * Parse private key from base58 string
 */
function parsePrivateKey(privateKeyB58) {
  try {
    const privateKeyBytes = bs58.decode(privateKeyB58);
    return Keypair.fromSecretKey(privateKeyBytes);
  } catch (error) {
    throw new Error(`Invalid private key format: ${error.message}`);
  }
}

/**
 * Get token account information
 */
async function getTokenAccountInfo(connection, tokenAccount) {
  try {
    const accountInfo = await getAccount(connection, tokenAccount);
    return {
      balance: accountInfo.amount,
      mint: accountInfo.mint,
      owner: accountInfo.owner
    };
  } catch (error) {
    console.error(`Error getting token account info: ${error.message}`);
    return null;
  }
}

/**
 * Get token mint information including decimals
 */
async function getTokenMintInfo(connection, mintAddress) {
  try {
    const mintInfo = await getMint(connection, mintAddress);
    return {
      decimals: mintInfo.decimals,
      supply: mintInfo.supply
    };
  } catch (error) {
    throw new Error(`Error getting mint info: ${error.message}`);
  }
}

/**
 * Burn SPL tokens
 */
async function burnTokens(walletPrivateKey, tokenMint, burnAmount) {
  console.log('🔥 Starting token burn process...');
  console.log(`Token Mint: ${tokenMint}`);
  console.log(`Amount to burn: ${burnAmount}`);
  
  // Parse wallet
  const wallet = parsePrivateKey(walletPrivateKey);
  console.log(`Wallet: ${wallet.publicKey.toString()}`);
  
  // Create connection
  const connection = new Connection(RPC_ENDPOINT, COMMITMENT);
  
  try {
    // Parse mint address
    const mintAddress = new PublicKey(tokenMint);
    
    // Get mint info to determine decimals
    console.log('\n📊 Getting token information...');
    const mintInfo = await getTokenMintInfo(connection, mintAddress);
    console.log(`Token decimals: ${mintInfo.decimals}`);
    console.log(`Current total supply: ${mintInfo.supply.toString()}`);
    
    // Calculate associated token account
    const tokenAccount = await getAssociatedTokenAddress(
      mintAddress,
      wallet.publicKey
    );
    console.log(`Token account: ${tokenAccount.toString()}`);
    
    // Get token account info
    const accountInfo = await getTokenAccountInfo(connection, tokenAccount);
    if (!accountInfo) {
      throw new Error('Token account not found or empty');
    }
    
    // Calculate balances
    const currentBalance = Number(accountInfo.balance) / Math.pow(10, mintInfo.decimals);
    const burnAmountRaw = BigInt(burnAmount * Math.pow(10, mintInfo.decimals));
    
    console.log(`\n💰 Current token balance: ${currentBalance}`);
    console.log(`Amount to burn (raw units): ${burnAmountRaw.toString()}`);
    
    // Validate balance
    if (currentBalance < burnAmount) {
      throw new Error(`Insufficient balance. Have ${currentBalance}, need ${burnAmount}`);
    }
    
    // Execute burn transaction
    console.log('\n🔨 Executing burn transaction...');
    console.log('📤 Sending burn transaction...');
    
    // The burn function handles the entire transaction
    const signature = await burn(
      connection,          // Connection
      wallet,              // Payer
      tokenAccount,        // Token account
      mintAddress,         // Mint
      wallet,              // Owner
      burnAmountRaw,       // Amount to burn
      [],                  // Multi-signers (empty for single signer)
      {
        commitment: COMMITMENT,
        preflightCommitment: COMMITMENT
      }
    );
    
    console.log('\n✅ BURN SUCCESSFUL!');
    console.log(`Transaction signature: ${signature}`);
    console.log(`Solscan link: https://solscan.io/tx/${signature}`);
    console.log(`Tokens burned: ${burnAmount}`);
    
    // Get new balance
    const newAccountInfo = await getTokenAccountInfo(connection, tokenAccount);
    if (newAccountInfo) {
      const newBalance = Number(newAccountInfo.balance) / Math.pow(10, mintInfo.decimals);
      console.log(`New token balance: ${newBalance}`);
      console.log(`Tokens actually burned: ${currentBalance - newBalance}`);
    }
    
    // Get new supply
    const newMintInfo = await getTokenMintInfo(connection, mintAddress);
    console.log(`New total supply: ${newMintInfo.supply.toString()}`);
    
    return signature;
    
  } catch (error) {
    console.error('\n❌ BURN FAILED!');
    console.error(`Error: ${error.message}`);
    
    // Additional error context
    if (error.message.includes('0x1')) {
      console.error('Hint: Insufficient lamports for rent');
    } else if (error.message.includes('0x11')) {
      console.error('Hint: Invalid program for this token account');
    } else if (error.message.includes('0x5')) {
      console.error('Hint: Not enough tokens to burn');
    }
    
    throw error;
  }
}

/**
 * Main CLI function
 */
async function main() {
  const program = new Command();
  
  program
    .name('burn-token')
    .description('Burn SPL tokens from a wallet')
    .version('1.0.0')
    .requiredOption('-w, --wallet <private_key>', 'Wallet private key (base58)')
    .requiredOption('-m, --mint <token_mint>', 'Token mint address')
    .requiredOption('-a, --amount <amount>', 'Amount of tokens to burn', parseFloat)
    .option('-r, --rpc <url>', 'Custom RPC endpoint', RPC_ENDPOINT)
    .option('--dry-run', 'Show what would be burned without executing')
    .parse();
  
  const options = program.opts();
  
  // Validate inputs
  if (options.amount <= 0) {
    console.error('❌ Amount must be greater than 0');
    process.exit(1);
  }
  
  try {
    // Parse and validate addresses
    new PublicKey(options.mint);
    parsePrivateKey(options.wallet);
  } catch (error) {
    console.error(`❌ Invalid input: ${error.message}`);
    process.exit(1);
  }
  
  // Show warning
  console.log('⚠️  WARNING: This will permanently burn tokens!');
  console.log(`Wallet: ${parsePrivateKey(options.wallet).publicKey.toString()}`);
  console.log(`Token Mint: ${options.mint}`);
  console.log(`Amount: ${options.amount}`);
  
  if (options.dryRun) {
    console.log('\n🧪 DRY RUN - No tokens will actually be burned');
    return;
  }
    
  try {
    const signature = await burnTokens(
      options.wallet,
      options.mint,
      options.amount
    );
    
    console.log('\n🎉 Burn completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n💥 Burn failed!');
    console.error(error.message);
    process.exit(1);
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Run the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { burnTokens, parsePrivateKey, getTokenAccountInfo };
