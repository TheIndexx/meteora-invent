import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createConnection, parsePrivateKey, parsePublicKey, retry } from './solana.js';

const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

/**
 * Jupiter Simple Swap Implementation
 * This performs a simple token-to-token swap within one wallet
 * with a separate fee payer for transaction costs
 */
export class JupiterSimpleSwap {
  constructor() {
    this.connection = createConnection();
  }

  /**
   * Execute a simple token swap with separate fee payer
   */
  async executeSwap({
    walletKey,
    inputToken,
    outputToken,
    amount,
    feePayerKey,
    slippageBps = 2000, // 20% default slippage
    maxRetries = 3
  }) {
    return retry(async () => {
      const wallet = parsePrivateKey(walletKey);
      const feePayer = parsePrivateKey(feePayerKey);

      // Check balances before swap
      const initialWalletBalance = await this.connection.getBalance(wallet.publicKey);
      const initialFeePayerBalance = await this.connection.getBalance(feePayer.publicKey);

      // Get input token decimals to calculate proper amount
      const inputTokenMint = parsePublicKey(inputToken);
      const inputTokenInfo = await this.connection.getParsedAccountInfo(inputTokenMint);
      let inputTokenDecimals = 9; // Default fallback
      if (inputTokenInfo.value && inputTokenInfo.value.data.parsed && inputTokenInfo.value.data.parsed.info) {
        inputTokenDecimals = inputTokenInfo.value.data.parsed.info.decimals;
      }

      // Get output token decimals for price calculation
      const outputTokenMint = parsePublicKey(outputToken);
      const outputTokenInfo = await this.connection.getParsedAccountInfo(outputTokenMint);
      let outputTokenDecimals = 9; // Default fallback
      if (outputTokenInfo.value && outputTokenInfo.value.data.parsed && outputTokenInfo.value.data.parsed.info) {
        outputTokenDecimals = outputTokenInfo.value.data.parsed.info.decimals;
      }

      // Convert amount to smallest unit for the input token
      const amountInSmallestUnit = Math.floor(parseFloat(amount) * Math.pow(10, inputTokenDecimals));

      // Get quote from Jupiter
      const quote = await this.getQuote({
        inputMint: inputToken,
        outputMint: outputToken,
        amount: amountInSmallestUnit,
        slippageBps
      });

      // Get swap transaction
      const swapResponse = await this.getSwapTransaction({
        quote,
        userPublicKey: wallet.publicKey.toString(),
        payerPublicKey: feePayer.publicKey.toString(),
        useTokenLedger: false,
        asLegacyTransaction: false
      });

      // Execute the swap transaction
      const signature = await this.executeSwapTransaction({
        swapTransaction: swapResponse.swapTransaction,
        wallet,
        feePayer
      });

      // Check balances after swap
      const finalWalletBalance = await this.connection.getBalance(wallet.publicKey);
      const finalFeePayerBalance = await this.connection.getBalance(feePayer.publicKey);

      // Calculate swap metrics
      const inputAmount = parseFloat(quote.inAmount) / Math.pow(10, inputTokenDecimals);
      const outputAmount = parseFloat(quote.outAmount) / Math.pow(10, outputTokenDecimals);
      const swapRate = outputAmount / inputAmount; // output tokens per input token

      return {
        success: true,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount,
        inputAmountFormatted: inputAmount,
        outputAmountFormatted: outputAmount,
        swapRate: swapRate,
        inputTokenDecimals,
        outputTokenDecimals,
        feesSpent: (initialFeePayerBalance - finalFeePayerBalance) / 1e9 // Convert to SOL
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
      swapMode: 'ExactIn'
    });

    const url = `${JUPITER_API_URL}/quote?${params}`;
    console.log(`Fetching Jupiter quote from: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Meteora-Invent/1.0'
        },
        timeout: 10000 // 10 second timeout
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Jupiter API error: ${response.status} ${response.statusText} - ${error}`);
        throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText} - ${error}`);
      }

      const quote = await response.json();
      console.log(`Jupiter quote received: inAmount=${quote.inAmount}, outAmount=${quote.outAmount}`);

      // Validate quote response
      if (!quote.inAmount || !quote.outAmount) {
        console.error('Invalid quote response:', quote);
        throw new Error('Invalid quote response from Jupiter');
      }

      return quote;
    } catch (error) {
      console.error(`Jupiter API fetch failed: ${error.message}`);
      throw new Error(`Jupiter API fetch failed: ${error.message}`);
    }
  }

  /**
   * Get swap transaction
   */
  async getSwapTransaction({
    quote,
    userPublicKey,
    payerPublicKey,
    useTokenLedger = false,
    asLegacyTransaction = false
  }) {
    const requestBody = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      useSharedAccounts: false,
      payer: payerPublicKey, // Fee payer pays all transaction fees
      useTokenLedger,
      asLegacyTransaction
    };

    const url = `${JUPITER_API_URL}/swap`;
    console.log(`Fetching Jupiter swap transaction from: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Meteora-Invent/1.0'
        },
        body: JSON.stringify(requestBody),
        timeout: 15000 // 15 second timeout
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Jupiter swap API error: ${response.status} ${response.statusText} - ${error}`);
        throw new Error(`Jupiter swap transaction failed: ${response.status} ${response.statusText} - ${error}`);
      }

      const result = await response.json();
      console.log(`Jupiter swap transaction received: ${result.swapTransaction ? 'success' : 'failed'}`);
      return result;
    } catch (error) {
      console.error(`Jupiter swap API fetch failed: ${error.message}`);
      throw new Error(`Jupiter swap API fetch failed: ${error.message}`);
    }
  }

  /**
   * Execute the swap transaction
   */
  async executeSwapTransaction({ swapTransaction, wallet, feePayer }) {
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
    // Fee payer is already set as payer via the payer parameter in Jupiter request
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([feePayer, wallet]);
    } else {
      transaction.sign(feePayer, wallet);
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
    const required = ['walletKey', 'inputToken', 'outputToken', 'amount', 'feePayerKey'];

    for (const field of required) {
      if (!params[field]) {
        throw new Error(`Missing required parameter: ${field}`);
      }
    }

    if (parseFloat(params.amount) <= 0) {
      throw new Error('Amount must be greater than 0');
    }

    // Validate key formats
    try {
      parsePrivateKey(params.walletKey);
      parsePrivateKey(params.feePayerKey);
      parsePublicKey(params.inputToken);
      parsePublicKey(params.outputToken);
    } catch (error) {
      throw new Error(`Parameter validation failed: ${error.message}`);
    }

    // Validate that input and output tokens are different
    if (params.inputToken === params.outputToken) {
      throw new Error('Input token and output token must be different');
    }
  }
}
