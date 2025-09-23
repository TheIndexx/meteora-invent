import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createConnection, parsePrivateKey, parsePublicKey, retry, sleep } from './solana.js';

const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

/**
 * Jupiter ExactIn Payments-as-Swap Implementation
 * This uses the payments-as-swap approach where:
 * - Fee payer (platform wallet) pays transaction fees
 * - Token source (fee wallet) provides the SOL for swap
 * - Asset vault receives tokens directly
 */
export class JupiterPaymentsAsSwap {
  constructor() {
    this.connection = createConnection();
  }

  /**
   * Execute payment-as-swap with ExactIn mode
   */
  async executePaymentAsSwap({
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount,
    platformWalletKey,
    slippageBps = 2000, // 20% default slippage
    maxRetries = 3
  }) {
    return retry(async () => {
      const feeWallet = parsePrivateKey(feeWalletKey);
      const platformWallet = parsePrivateKey(platformWalletKey);
      const destinationWallet = parsePublicKey(assetVaultPubkey);

      console.log('🔄 Starting Jupiter payments-as-swap...');
      console.log(`  📊 Amount: ${solAmount} SOL`);
      console.log(`  🎯 Asset Vault: ${assetVaultPubkey.slice(0, 8)}...`);
      console.log(`  🔗 Token: ${tokenMint.slice(0, 8)}...`);

      // Check balances before Jupiter operations
      const initialFeeWalletBalance = await this.connection.getBalance(feeWallet.publicKey);
      const initialPlatformWalletBalance = await this.connection.getBalance(platformWallet.publicKey);
      console.log(`  📊 Fee wallet balance before Jupiter: ${initialFeeWalletBalance / 1e9} SOL (${initialFeeWalletBalance} lamports)`);
      console.log(`  📊 Platform wallet balance before Jupiter: ${initialPlatformWalletBalance / 1e9} SOL (${initialPlatformWalletBalance} lamports)`);

      // Step 1: Get the Associated Token Account for the asset vault
      const tokenMintPubkey = parsePublicKey(tokenMint);
      const destinationTokenAccount = await getAssociatedTokenAddress(
        tokenMintPubkey,
        destinationWallet,
        true, // Allow owner to be off curve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      console.log(`  🏦 Destination ATA: ${destinationTokenAccount.toString().slice(0, 8)}...`);

      // Step 2: Get quote from Jupiter
      const quote = await this.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: tokenMint,
        amount: Math.floor(solAmount * 1e9), // Convert to lamports
        slippageBps
      });

      console.log(`  📈 Quote: ${quote.inAmount} lamports → ${quote.outAmount} tokens`);

      // Step 3: Get swap transaction with payments-as-swap configuration
      const swapResponse = await this.getSwapTransaction({
        quote,
        userPublicKey: feeWallet.publicKey.toString(),
        destinationTokenAccount: destinationTokenAccount.toString(), // ATA for the asset vault
        payerPublicKey: platformWallet.publicKey.toString(), // Platform wallet pays all fees
        useTokenLedger: false,
        asLegacyTransaction: false
      });

      // Step 4: Execute the swap transaction
      const signature = await this.executeSwap({
        swapTransaction: swapResponse.swapTransaction,
        feeWallet,
        platformWallet
      });

      console.log(`  ✅ Swap completed: ${signature}`);

      // Check balances after Jupiter swap
      const finalFeeWalletBalance = await this.connection.getBalance(feeWallet.publicKey);
      const finalPlatformWalletBalance = await this.connection.getBalance(platformWallet.publicKey);
      console.log(`  📊 Fee wallet balance after Jupiter: ${finalFeeWalletBalance / 1e9} SOL (${finalFeeWalletBalance} lamports)`);
      console.log(`  📊 Platform wallet balance after Jupiter: ${finalPlatformWalletBalance / 1e9} SOL (${finalPlatformWalletBalance} lamports)`);
      console.log(`  📊 Fee wallet difference: ${(initialFeeWalletBalance - finalFeeWalletBalance) / 1e9} SOL`);
      console.log(`  📊 Platform wallet difference: ${(initialPlatformWalletBalance - finalPlatformWalletBalance) / 1e9} SOL`);

      return {
        success: true,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        destinationAccount: destinationTokenAccount.toString()
      };
    }, maxRetries);
  }

  /**
   * Get quote from Jupiter API
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps }) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      swapMode: 'ExactIn' // Use ExactIn mode as specified
    });

    const response = await fetch(`${JUPITER_API_URL}/quote?${params}`);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jupiter quote failed: ${error}`);
    }

    const quote = await response.json();

    // Validate quote response
    if (!quote.inAmount || !quote.outAmount) {
      throw new Error('Invalid quote response from Jupiter');
    }

    return quote;
  }

  /**
   * Get swap transaction with payments-as-swap configuration
   */
  async getSwapTransaction({
    quote,
    userPublicKey,
    destinationTokenAccount,
    payerPublicKey,
    useTokenLedger = false,
    asLegacyTransaction = false
  }) {
    const requestBody = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      useSharedAccounts: false, // Disable shared accounts for simple AMMs
      destinationTokenAccount, // Direct delivery to asset vault
      payer: payerPublicKey, // Platform wallet pays all fees and rent
      useTokenLedger,
      asLegacyTransaction
    };

    const response = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jupiter swap transaction failed: ${error}`);
    }

    return await response.json();
  }

  /**
   * Execute the swap transaction
   */
  async executeSwap({ swapTransaction, feeWallet, platformWallet }) {
    // Deserialize the transaction
    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    let transaction;

    try {
      // Try as VersionedTransaction first
      transaction = VersionedTransaction.deserialize(transactionBuf);
    } catch (e) {
      try {
        // Fallback to legacy Transaction
        transaction = Transaction.from(transactionBuf);
      } catch (e2) {
        throw new Error(`Failed to deserialize transaction: ${e2.message}`);
      }
    }

    // Sign the transaction with both wallets
    // Jupiter has already set the platform wallet as payer via the payer parameter
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([platformWallet, feeWallet]);
    } else {
      transaction.sign(platformWallet, feeWallet);
    }

    try {
      // Send the transaction
      const rawTransaction = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        maxRetries: 3
      });

      // Wait for confirmation
      await this.connection.confirmTransaction(signature, 'confirmed');

      return signature;
    } catch (error) {
      // If it's a SendTransactionError, log the detailed transaction logs
      if (error.logs && Array.isArray(error.logs)) {
        console.error('  ❌ Transaction failed with detailed logs:');
        error.logs.forEach(log => console.error(`      ${log}`));
      }
      throw error;
    }
  }

  /**
   * Validate swap parameters
   */
  validateSwapParams(params) {
    const required = ['feeWalletKey', 'assetVaultPubkey', 'tokenMint', 'solAmount', 'platformWalletKey'];

    for (const field of required) {
      if (!params[field]) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }

    if (params.solAmount <= 0) {
      throw new Error('SOL amount must be greater than 0');
    }

    // Validate key formats
    try {
      parsePrivateKey(params.feeWalletKey);
      parsePrivateKey(params.platformWalletKey);
      parsePublicKey(params.assetVaultPubkey);
      parsePublicKey(params.tokenMint);
    } catch (error) {
      throw new Error(`Parameter validation failed: ${error.message}`);
    }
  }
}