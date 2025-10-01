import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createConnection, parsePrivateKey, parsePublicKey, retry, sleep } from './solana.js';

const JUPITER_API_URL = 'https://lite-api.jup.ag/swap/v1';

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


      // Check balances before Jupiter operations
      const initialFeeWalletBalance = await this.connection.getBalance(feeWallet.publicKey);
      const initialPlatformWalletBalance = await this.connection.getBalance(platformWallet.publicKey);

      // Step 1: Get the Associated Token Account for the destination wallet
      const tokenMintPubkey = parsePublicKey(tokenMint);
      const destinationTokenAccount = await getAssociatedTokenAddress(
        tokenMintPubkey,
        destinationWallet,
        true, // Allow owner to be off curve
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      console.log(`Destination wallet: ${destinationWallet.toBase58()}`);
      console.log(`Token mint: ${tokenMintPubkey.toBase58()}`);
      console.log(`Derived ATA: ${destinationTokenAccount.toBase58()}`);


      // Step 2: Get quote from Jupiter
      const quote = await this.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: tokenMint,
        amount: Math.floor(solAmount * 1e9), // Convert to lamports
        slippageBps
      });


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


      // Check balances after Jupiter swap
      const finalFeeWalletBalance = await this.connection.getBalance(feeWallet.publicKey);
      const finalPlatformWalletBalance = await this.connection.getBalance(platformWallet.publicKey);

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
      destinationTokenAccount, // Direct delivery to destination wallet's ATA
      payer: payerPublicKey, // Platform wallet pays all fees and rent
      useTokenLedger,
      asLegacyTransaction
    };

    console.log('Requesting swap transaction with:', {
      userPublicKey,
      destinationTokenAccount,
      feeAccount: payerPublicKey,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      inAmount: quote.inAmount,
      outAmount: quote.outAmount
    });

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
      // Re-throw error with logs if available
      if (error.logs && Array.isArray(error.logs)) {
        error.message = `${error.message}\nTransaction logs: ${error.logs.join('\n')}`;
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