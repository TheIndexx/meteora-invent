import {
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  PublicKey
} from '@solana/web3.js';
import { createConnection, parsePrivateKey, parsePublicKey } from './solana.js';

const JUPITER_API_URL = 'https://lite-api.jup.ag/swap/v1';

/**
 * Silent Jupiter Custom Transaction Builder (no console output)
 * Builds swap transactions with platform wallet as fee payer
 */
export class JupiterCustomTxBuilderSilent {
  constructor() {
    this.connection = createConnection();
  }

  /**
   * Execute swap with custom fee payer
   */
  async executeSwapWithCustomPayer({
    feeWalletKey,
    assetVaultPubkey,
    tokenMint,
    solAmount,
    platformWalletKey,
    slippageBps = 2000,
    maxRetries = 3,
    maxAccounts = null // For internal retry logic
  }) {
    const feeWallet = parsePrivateKey(feeWalletKey);
    const platformWallet = parsePrivateKey(platformWalletKey);

    // Step 1: Get quote with progressive fallback
    const quote = await this.getQuote({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: tokenMint,
      amount: Math.floor(solAmount * 1e9),
      slippageBps,
      maxAccounts
    });

    // Step 2: Calculate the destination ATA for the asset vault
    const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const tokenMintPubkey = parsePublicKey(tokenMint);
    const assetVaultPubkey_parsed = parsePublicKey(assetVaultPubkey);

    const destinationATA = await getAssociatedTokenAddress(
      tokenMintPubkey,
      assetVaultPubkey_parsed,
      true, // Allow owner to be off curve
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Step 3: Get swap instructions (not full transaction)
    const instructions = await this.getSwapInstructions({
      quote,
      userPublicKey: feeWallet.publicKey.toString(),
      destinationTokenAccount: destinationATA.toString(),
      wrapAndUnwrapSol: true
    });

    // Step 4: Build custom transaction with platform wallet as fee payer
    const tx = await this.buildCustomTransaction({
      instructions,
      feeWallet,
      platformWallet,
      connection: this.connection
    });

    // Step 5: Send transaction with fallback for size issues
    try {
      const signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3
      });

      await this.connection.confirmTransaction(signature, 'confirmed');

      return {
        success: true,
        signature,
        inputAmount: quote.inAmount,
        outputAmount: quote.outAmount
      };
    } catch (error) {
      // Check if transaction is too large
      if (error.message.includes('too large') && !maxAccounts) {
        // Progressive fallback: try with account limits
        const fallbackLimits = [40, 30, 25];

        for (const limit of fallbackLimits) {
          try {
            return await this.executeSwapWithCustomPayer({
              feeWalletKey,
              assetVaultPubkey,
              tokenMint,
              solAmount,
              platformWalletKey,
              slippageBps,
              maxRetries,
              maxAccounts: limit
            });
          } catch (fallbackError) {
            // If it's still a size error, try next limit
            if (fallbackError.message.includes('too large')) {
              continue;
            }
            // If it's a different error, throw it
            throw fallbackError;
          }
        }

        // If all fallbacks failed, throw original error
        throw new Error(`Transaction too large even with account limits. Original error: ${error.message}`);
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get quote from Jupiter
   */
  async getQuote({ inputMint, outputMint, amount, slippageBps, maxAccounts }) {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      swapMode: 'ExactIn'
    });

    // Add maxAccounts if provided
    if (maxAccounts) {
      params.set('maxAccounts', maxAccounts.toString());
    }

    const response = await fetch(`${JUPITER_API_URL}/quote?${params}`);
    if (!response.ok) {
      throw new Error(`Jupiter quote failed: ${await response.text()}`);
    }

    return await response.json();
  }

  /**
   * Get swap instructions from Jupiter
   */
  async getSwapInstructions({ quote, userPublicKey, destinationTokenAccount, wrapAndUnwrapSol }) {
    const response = await fetch(`${JUPITER_API_URL}/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        destinationTokenAccount,
        wrapAndUnwrapSol,
        useSharedAccounts: false, // Don't use shared accounts for compatibility
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto'
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to get swap instructions: ${await response.text()}`);
    }

    const result = await response.json();
    if (result.error) {
      throw new Error(`Swap instructions error: ${result.error}`);
    }

    return result;
  }

  /**
   * Build custom transaction with platform wallet as fee payer
   */
  async buildCustomTransaction({ instructions, feeWallet, platformWallet, connection }) {
    const {
      tokenLedgerInstruction,
      computeBudgetInstructions,
      setupInstructions,
      swapInstruction,
      cleanupInstruction,
      addressLookupTableAddresses
    } = instructions;

    // Deserialize instructions
    const deserializeInstruction = (instruction) => {
      return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, "base64"),
      });
    };

    // Get ALT accounts if needed
    const addressLookupTableAccounts = await this.getAddressLookupTableAccounts(
      addressLookupTableAddresses || [],
      connection
    );

    // Build transaction instructions array
    const txInstructions = [];

    // Add compute budget instructions if provided
    if (computeBudgetInstructions && computeBudgetInstructions.length > 0) {
      txInstructions.push(...computeBudgetInstructions.map(deserializeInstruction));
    }

    // Add setup instructions if needed
    if (setupInstructions && setupInstructions.length > 0) {
      txInstructions.push(...setupInstructions.map(deserializeInstruction));
    }

    // Add token ledger instruction if provided
    if (tokenLedgerInstruction) {
      txInstructions.push(deserializeInstruction(tokenLedgerInstruction));
    }

    // Add the main swap instruction
    txInstructions.push(deserializeInstruction(swapInstruction));

    // Add cleanup instruction if needed
    if (cleanupInstruction) {
      txInstructions.push(deserializeInstruction(cleanupInstruction));
    }

    // Get latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();

    // Build versioned transaction with platform wallet as payer
    const messageV0 = new TransactionMessage({
      payerKey: platformWallet.publicKey, // PLATFORM WALLET AS FEE PAYER
      recentBlockhash: blockhash,
      instructions: txInstructions,
    }).compileToV0Message(addressLookupTableAccounts);

    const transaction = new VersionedTransaction(messageV0);

    // Sign with both wallets
    // Platform wallet signs as fee payer
    // Fee wallet signs as source of funds
    transaction.sign([platformWallet, feeWallet]);

    return transaction;
  }

  /**
   * Get Address Lookup Table accounts
   */
  async getAddressLookupTableAccounts(keys, connection) {
    if (!keys || keys.length === 0) {
      return [];
    }

    const accountInfos = await connection.getMultipleAccountsInfo(
      keys.map((key) => new PublicKey(key))
    );

    return accountInfos.reduce((acc, accountInfo, index) => {
      if (accountInfo) {
        const addressLookupTableAccount = new AddressLookupTableAccount({
          key: new PublicKey(keys[index]),
          state: AddressLookupTableAccount.deserialize(accountInfo.data),
        });
        acc.push(addressLookupTableAccount);
      }
      return acc;
    }, []);
  }
}