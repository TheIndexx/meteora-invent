import { Connection, PublicKey, Keypair, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/**
 * Create a connection to Solana
 */
export function createConnection() {
  return new Connection(SOLANA_RPC_URL, 'confirmed');
}

/**
 * Parse a private key from base58 string
 */
export function parsePrivateKey(privateKeyString) {
  try {
    const keyBytes = bs58.decode(privateKeyString);
    return Keypair.fromSecretKey(keyBytes);
  } catch (error) {
    throw new Error(`Invalid private key format: ${error.message}`);
  }
}

/**
 * Parse a public key from string
 */
export function parsePublicKey(publicKeyString) {
  try {
    return new PublicKey(publicKeyString);
  } catch (error) {
    throw new Error(`Invalid public key format: ${error.message}`);
  }
}

/**
 * Get SOL balance for a wallet
 */
export async function getSolBalance(connection, publicKey) {
  try {
    const balance = await connection.getBalance(publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (error) {
    throw new Error(`Failed to get SOL balance: ${error.message}`);
  }
}

/**
 * Get Associated Token Account address
 */
export async function getTokenAccount(walletPubkey, tokenMint) {
  try {
    return await getAssociatedTokenAddress(
      new PublicKey(tokenMint),
      new PublicKey(walletPubkey),
      false,
      TOKEN_PROGRAM_ID
    );
  } catch (error) {
    throw new Error(`Failed to get token account: ${error.message}`);
  }
}

/**
 * Transfer SOL between wallets
 */
export async function transferSol(connection, fromKeypair, toPubkey, amountSol, feePayer = null) {
  try {
    const transaction = new Transaction();
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: fromKeypair.publicKey,
        toPubkey: new PublicKey(toPubkey),
        lamports
      })
    );

    // Use custom fee payer or default to sender
    const actualFeePayer = feePayer ? parsePrivateKey(feePayer) : fromKeypair;
    transaction.feePayer = actualFeePayer.publicKey;

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;

    // Sign with both fee payer and sender if different
    const signers = [actualFeePayer];
    if (feePayer && fromKeypair.publicKey.toString() !== actualFeePayer.publicKey.toString()) {
      signers.push(fromKeypair);
    }

    transaction.sign(...signers);

    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature, 'confirmed');

    return signature;
  } catch (error) {
    throw new Error(`SOL transfer failed: ${error.message}`);
  }
}

/**
 * Validate input parameters
 */
export function validateRequired(params, requiredFields) {
  for (const field of requiredFields) {
    if (!params[field]) {
      throw new Error(`Missing required parameter: ${field}`);
    }
  }
}

/**
 * Sleep utility
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry utility with exponential backoff
 */
export async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        console.warn(`Attempt ${i + 1} failed, retrying in ${delay}ms:`, error.message);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Failed after ${maxRetries} attempts: ${lastError.message}`);
}