#!/usr/bin/env node

import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { 
  createAssociatedTokenAccountInstruction,
  createApproveInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { Command } from 'commander';
import fetch from 'node-fetch';
import bs58 from 'bs58';

// Jupiter Trigger API types (now using JSDoc comments)
/**
 * @typedef {Object} TriggerOrderParams
 * @property {string} ownerAddress
 * @property {string} inToken
 * @property {string} outToken
 * @property {string} inAmount
 * @property {string} targetPrice
 * @property {number} [slippageBps]
 * @property {number} [expiredAt]
 */

/**
 * @typedef {Object} TriggerOrderResponse
 * @property {string} orderId
 * @property {boolean} success
 * @property {string} [error]
 */

/**
 * @typedef {Object} OrderStatus
 * @property {string} orderId
 * @property {'active'|'filled'|'cancelled'|'expired'} status
 * @property {string} inToken
 * @property {string} outToken
 * @property {string} inAmount
 * @property {string} targetPrice
 * @property {number} createdAt
 */

// Example tokens - SOL to USDC
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_PROGRAM_ID = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

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
        ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID // ATA program is the same for both
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

class JupiterLimitOrderCLI {
  constructor() {
    this.connection = new Connection('https://api.mainnet-beta.solana.com');
    this.wallet = null;
    this.feePayerWallet = null;
  }

  // Initialize wallet from private key
  initializeWallet(privateKeyString) {
    try {
      const keypair = this._createKeypairFromString(privateKeyString);
      this.wallet = keypair;
      console.log(`✅ Wallet initialized: ${keypair.publicKey.toString()}`);
      return true;
    } catch (error) {
      console.error(`❌ Error initializing wallet: ${error}`);
      return false;
    }
  }

  // Initialize fee payer wallet from private key
  initializeFeePayerWallet(privateKeyString) {
    try {
      const keypair = this._createKeypairFromString(privateKeyString);
      this.feePayerWallet = keypair;
      console.log(`✅ Fee payer wallet initialized: ${keypair.publicKey.toString()}`);
      return true;
    } catch (error) {
      console.error(`❌ Error initializing fee payer wallet: ${error}`);
      return false;
    }
  }

  // Helper method to create keypair from string (supports multiple formats)
  _createKeypairFromString(privateKeyString) {
    let secretKey;
    
    // Handle different private key formats
    if (privateKeyString.startsWith('[') && privateKeyString.endsWith(']')) {
      // Array format: "[123,45,67,...]"
      const keyArray = JSON.parse(privateKeyString);
      secretKey = new Uint8Array(keyArray);
    } else if (privateKeyString.includes(',')) {
      // Comma-separated format: "123,45,67,..."
      const keyArray = privateKeyString.split(',').map(num => parseInt(num.trim()));
      secretKey = new Uint8Array(keyArray);
    } else {
      // Base58 format
      try {
        secretKey = bs58.decode(privateKeyString);
      } catch {
        // Try base64 format
        secretKey = Keypair.fromSecretKey(
          Buffer.from(privateKeyString, 'base64')
        ).secretKey;
      }
    }
    
    if (secretKey.length !== 64) {
      throw new Error('Invalid private key length. Please provide a valid 64-byte private key.');
    }

    return Keypair.fromSecretKey(secretKey);
  }

  // Get or create associated token account
  async getOrCreateTokenAccount(mint, owner, tokenProgram = TOKEN_PROGRAM_ID, ataProgram = ASSOCIATED_TOKEN_PROGRAM_ID) {
    const mintPubkey = new PublicKey(mint);
    
    // Use the correct ATA calculation based on token program
    // For both Token Program and Token 2022, use the same ATA calculation method
    const tokenAccount = await getAssociatedTokenAddress(
      mintPubkey, 
      owner, 
      true, // allowOwnerOffCurve - this is important for Token 2022
      tokenProgram, // Use the detected token program
      ataProgram
    );
    
    console.log(`🔍 Looking for token account: ${tokenAccount.toString()}`);
    console.log(`🔍 For mint: ${mint}`);
    console.log(`🔍 For owner: ${owner.toString()}`);
    
    const existingAccount = await this.connection.getAccountInfo(tokenAccount);
    if (existingAccount) {
      console.log(`✅ Token account already exists`);
      return tokenAccount;
    }
    
    // Account doesn't exist, create it
    console.log(`🔄 Creating associated token account...`);
    const feePayer = this.feePayerWallet || this.wallet;
    const transaction = new Transaction();
    
    // Set the fee payer
    transaction.feePayer = feePayer.publicKey;
    transaction.add(
      createAssociatedTokenAccountInstruction(
        feePayer.publicKey, // payer (fee payer)
        tokenAccount, // token account
        owner, // owner
        mintPubkey, // mint
        tokenProgram,
        ataProgram
      )
    );
    
    try {
      await sendAndConfirmTransaction(this.connection, transaction, [feePayer]);
      console.log(`✅ Token account created: ${tokenAccount.toString()}`);
      console.log(`💰 Creation fees paid by: ${feePayer.publicKey.toString()}`);
      return tokenAccount;
    } catch (error) {
      console.error(`❌ Failed to create token account: ${error}`);
      throw error;
    }
  }

  // Approve Jupiter to spend tokens
  async approveTokenSpending(mint, amount, tokenProgram = TOKEN_PROGRAM_ID, ataProgram = ASSOCIATED_TOKEN_PROGRAM_ID) {
    if (!this.wallet) {
      console.error('❌ Wallet not initialized');
      return false;
    }

    try {
      const tokenAccount = await this.getOrCreateTokenAccount(mint, this.wallet.publicKey, tokenProgram, ataProgram);
      
      // Verify token account exists and get its info
      const tokenAccountInfo = await this.connection.getAccountInfo(tokenAccount);
      if (!tokenAccountInfo) {
        console.error(`❌ Token account not found: ${tokenAccount.toString()}`);
        return false;
      }
      
      console.log(`🔍 Token account found: ${tokenAccount.toString()}`);
      console.log(`🔍 Token account owner: ${tokenAccountInfo.owner.toString()}`);
      console.log(`🔍 Token account data length: ${tokenAccountInfo.data.length}`);
      
      const approveInstruction = createApproveInstruction(
        tokenAccount,
        JUPITER_PROGRAM_ID,
        this.wallet.publicKey,
        BigInt(amount),
        [], // multiSigners
        tokenProgram
      );

      const feePayer = this.feePayerWallet || this.wallet;
      const transaction = new Transaction();
      
      // Set the fee payer
      transaction.feePayer = feePayer.publicKey;
      transaction.add(approveInstruction);
      
      // If fee payer is different from wallet owner, need both signatures
      // Fee payer must be first signer
      const signers = this.feePayerWallet && this.feePayerWallet !== this.wallet 
        ? [this.feePayerWallet, this.wallet] 
        : [this.wallet];
      
      const signature = await sendAndConfirmTransaction(this.connection, transaction, signers);
      
      console.log(`✅ Token approval successful: ${signature}`);
      console.log(`💰 Fees paid by: ${feePayer.publicKey.toString()}`);
      return true;
    } catch (error) {
      console.error(`❌ Token approval failed: ${error}`);
      return false;
    }
  }

  // Get token decimals from mint
  async getTokenDecimals(mintAddress) {
    try {
      if (mintAddress === SOL_MINT) {
        return 9; // SOL has 9 decimals
      }
      
      const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
      if (mintInfo.value && mintInfo.value.data.parsed) {
        return mintInfo.value.data.parsed.info.decimals;
      }
      
      // Fallback: assume 6 decimals (common for many tokens)
      console.log(`⚠️ Could not fetch decimals for ${mintAddress}, assuming 6 decimals`);
      return 6;
    } catch (error) {
      console.error(`❌ Error fetching token decimals for ${mintAddress}: ${error}`);
      // Fallback: assume 6 decimals
      return 6;
    }
  }

  // Create limit order using Jupiter Trigger API
  async createLimitOrder(
    inToken,
    outToken,
    inAmount,
    targetPrice,
    slippageBps = 0
  ) {
    if (!this.wallet) {
      console.error('❌ Wallet not initialized');
      return null;
    }

    console.log('🔄 Creating limit order...');
    
    try {
      // Detect token program for input token
      console.log('🔍 Detecting token program...');
      const { tokenProgram, ataProgram } = await detectTokenProgram(this.connection, new PublicKey(inToken));
      console.log(`🔍 Using token program: ${tokenProgram.toBase58()}`);
      
      // Get token decimals for proper price calculation
      console.log('🔍 Fetching token decimals...');
      const inTokenDecimals = await this.getTokenDecimals(inToken);
      const outTokenDecimals = await this.getTokenDecimals(outToken);
      
      console.log(`🔍 Input token decimals: ${inTokenDecimals}`);
      console.log(`🔍 Output token decimals: ${outTokenDecimals}`);
      
      // Handle "ALL" amount parameter to use all available tokens
      let finalInAmount = inAmount;
      
      // Only approve token spending for SPL tokens, not native SOL
      if (inToken !== SOL_MINT) {
        console.log('🔄 Checking token balance and approving token spending...');
        
        // Check token balance first
        const tokenAccount = await this.getOrCreateTokenAccount(inToken, this.wallet.publicKey, tokenProgram, ataProgram);
        const balance = await this.connection.getTokenAccountBalance(tokenAccount);
        console.log(`🔍 Token balance: ${balance.value.amount} (${balance.value.uiAmount})`);
        
        // Handle "ALL" parameter - use all available tokens
        if (inAmount === "ALL" || inAmount === "all") {
          finalInAmount = balance.value.amount;
          console.log(`🔄 Using ALL available tokens: ${finalInAmount}`);
        } else {
          finalInAmount = inAmount;
          console.log(`🔍 Required amount: ${finalInAmount}`);
          
          if (BigInt(balance.value.amount) < BigInt(finalInAmount)) {
            console.error(`❌ Insufficient token balance. Have: ${balance.value.amount}, Need: ${finalInAmount}`);
            return null;
          }
        }
        
        // Ensure we have tokens to trade
        if (BigInt(finalInAmount) <= 0) {
          console.error(`❌ No tokens available to trade. Balance: ${balance.value.amount}`);
          return null;
        }
        
        const approvalSuccess = await this.approveTokenSpending(inToken, finalInAmount, tokenProgram, ataProgram);
        if (!approvalSuccess) {
          return null;
        }
      } else {
        console.log('ℹ️ Using native SOL - no token approval needed');
        finalInAmount = inAmount;
      }

      // Calculate the correct taking amount based on price and decimals
      // targetPrice is the price per token in terms of output token
      // For example: if selling TOKEN for SOL, targetPrice is SOL per TOKEN
      const inAmountBigInt = BigInt(finalInAmount);
      const targetPriceBigInt = BigInt(Math.floor(parseFloat(targetPrice) * Math.pow(10, outTokenDecimals)));
      const takingAmount = (inAmountBigInt * targetPriceBigInt / BigInt(Math.pow(10, inTokenDecimals))).toString();
      
      console.log(`🔍 Price calculation:`);
      console.log(`   Input amount: ${finalInAmount} (raw units)`);
      console.log(`   Target price: ${targetPrice} ${outToken === SOL_MINT ? 'SOL' : 'tokens'} per input token`);
      console.log(`   Calculated taking amount: ${takingAmount} (raw units)`);
      console.log(`   Effective price: ${parseFloat(takingAmount) / parseFloat(finalInAmount) * Math.pow(10, inTokenDecimals - outTokenDecimals)}`);

      // Create trigger order using the new Jupiter v1 API format
      const feePayer = this.feePayerWallet || this.wallet;
      const orderParams = {
        inputMint: inToken,
        outputMint: outToken,
        maker: this.wallet.publicKey.toString(),
        payer: feePayer.publicKey.toString(),
        params: {
          makingAmount: finalInAmount,
          takingAmount: takingAmount,
          slippageBps: slippageBps.toString(),
          expiredAt: Math.floor((Date.now() + (24 * 60 * 60 * 1000)) / 1000).toString() // 24 hours from now in unix seconds
        },
        computeUnitPrice: "auto",
        wrapAndUnwrapSol: true
      };

      console.log('🔄 Submitting order to Jupiter...');
      console.log('📤 Order params:', JSON.stringify(orderParams, null, 2));
      
      const response = await fetch('https://lite-api.jup.ag/trigger/v1/createOrder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(orderParams)
      });

      console.log(`📥 Response status: ${response.status} ${response.statusText}`);
      
      const result = await response.json();
      console.log('📥 Response body:', JSON.stringify(result, null, 2));
      
      if (result.order) {
        console.log(`✅ Limit order created successfully! Order ID: ${result.order}`);
        console.log(`🔧 Request ID: ${result.requestId}`);
        
        // Jupiter returns a transaction that needs to be submitted
        if (result.transaction) {
          console.log(`🔍 Transaction returned by Jupiter - submitting to execute the order...`);
          try {
            const executeSuccess = await this.executeJupiterTransaction(result.transaction);
            if (executeSuccess) {
              console.log(`✅ Order transaction executed successfully`);
              
              // Wait a moment for the order to be indexed
              console.log(`⏳ Waiting 5 seconds for order to be indexed...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              
              console.log(`🔍 Checking if order now appears in system...`);
              const orders = await this.fetchOrders();
              if (orders.length > 0) {
                console.log(`✅ Order found! Total orders: ${orders.length}`);
                orders.forEach((order, index) => {
                  console.log(`   ${index + 1}. Order ID: ${order.id || order.orderId}`);
                });
              } else {
                console.log(`❌ Order still not found after transaction execution`);
              }
            } else {
              console.log(`❌ Order transaction execution failed`);
            }
          } catch (error) {
            console.error(`❌ Error executing order transaction: ${error}`);
          }
        } else {
          console.log(`⚠️ No transaction returned by Jupiter - this is unexpected`);
        }
        
        return result.order;
      } else {
        console.error(`❌ Failed to create limit order. Full response:`, result);
        return null;
      }
    } catch (error) {
      console.error(`❌ Error creating limit order: ${error}`);
      return null;
    }
  }

  // Fetch active orders
  async fetchOrders() {
    if (!this.wallet) {
      console.error('❌ Wallet not initialized');
      return [];
    }

    try {
      const url = `https://lite-api.jup.ag/trigger/v1/getTriggerOrders?wallet=${this.wallet.publicKey.toString()}&orderStatus=active`;
      console.log(`🔍 Fetching orders from: ${url}`);
      
      const response = await fetch(url);
      console.log(`📥 Response status: ${response.status} ${response.statusText}`);
      
      const result = await response.json();
      console.log(`📥 API response:`, JSON.stringify(result, null, 2));
      
      return result.orders || [];
    } catch (error) {
      console.error('❌ Error fetching orders:', error);
      return [];
    }
  }

  // Execute Jupiter transaction by signing and submitting manually
  async executeJupiterTransaction(transactionBase64) {
    try {
      console.log(`🔍 Signing and submitting transaction manually...`);
      
      // Decode the transaction
      const transactionBuffer = Buffer.from(transactionBase64, 'base64');
      
      let transaction;
      try {
        // Try versioned transaction first (Jupiter v1 uses versioned transactions)
        transaction = VersionedTransaction.deserialize(transactionBuffer);
        console.log(`🔍 Using VersionedTransaction`);
      } catch (error) {
        // Fallback to legacy transaction
        transaction = Transaction.from(transactionBuffer);
        console.log(`🔍 Using legacy Transaction`);
      }
      
      // Set up signers
      const feePayer = this.feePayerWallet || this.wallet;
      const signers = [feePayer];
      
      // Add wallet if different from fee payer
      if (this.wallet && this.wallet.publicKey.toString() !== feePayer.publicKey.toString()) {
        signers.push(this.wallet);
      }
      
      console.log(`🔍 Signing with ${signers.length} signers`);
      
      if (transaction instanceof VersionedTransaction) {
        // For versioned transactions
        console.log(`🔍 Signing versioned transaction...`);
        transaction.sign(signers);
      } else {
        // For legacy transactions
        console.log(`🔍 Signing legacy transaction...`);
        console.log(`🔍 Transaction has ${transaction.instructions.length} instructions`);
        console.log(`🔍 Fee payer: ${transaction.feePayer?.toString()}`);
        
        // Get recent blockhash for legacy transactions
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.feePayer = feePayer.publicKey;
        
        transaction.sign(...signers);
      }
      
      console.log(`🔍 Submitting transaction to Solana...`);
      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      
      console.log(`📤 Transaction submitted: ${signature}`);
      
      console.log(`⏳ Confirming transaction...`);
      const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
      
      if (confirmation.value.err) {
        console.error(`❌ Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        return false;
      } else {
        console.log(`✅ Transaction confirmed: ${signature}`);
        return true;
      }
    } catch (error) {
      console.error(`❌ Error executing transaction: ${error}`);
      return false;
    }
  }

  // Check order status by ID
  async checkOrderStatus(orderId) {
    try {
      const response = await fetch(`https://lite-api.jup.ag/trigger/v1/getOrder?order=${orderId}`);
      console.log(`📥 Response status: ${response.status} ${response.statusText}`);
      
      const result = await response.json();
      console.log(`📥 Order status response:`, JSON.stringify(result, null, 2));
      
      return result;
    } catch (error) {
      console.error(`❌ Error checking order status: ${error}`);
      return null;
    }
  }

  // Cancel an order
  async cancelOrder(orderId) {
    if (!this.wallet) {
      console.error('❌ Wallet not initialized');
      return false;
    }

    try {
      const response = await fetch(`https://lite-api.jup.ag/trigger/v1/cancelOrder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          order: orderId,
          maker: this.wallet.publicKey.toString()
        })
      });

      if (response.ok) {
        console.log(`✅ Order ${orderId} cancelled successfully`);
        return true;
      } else {
        console.error(`❌ Failed to cancel order ${orderId}`);
        return false;
      }
    } catch (error) {
      console.error(`❌ Error cancelling order: ${error}`);
      return false;
    }
  }

  // Example: Create SOL to USDC limit order
  async createExampleOrder() {
    const solAmount = (0.1 * LAMPORTS_PER_SOL).toString(); // 0.1 SOL
    const targetPrice = '150'; // Target price: 150 USDC per SOL
    
    await this.createLimitOrder(SOL_MINT, USDC_MINT, solAmount, targetPrice, 0);
  }

  // Fetch orders with different parameters (for debugging)
  async fetchOrdersWithDebug() {
    if (!this.wallet) {
      console.error('❌ Wallet not initialized');
      return [];
    }

    const walletAddress = this.wallet.publicKey.toString();
    console.log(`🔍 Testing different API endpoints for wallet: ${walletAddress}`);
    
    // Try different parameter combinations
    const endpoints = [
      `https://lite-api.jup.ag/trigger/v1/getTriggerOrders?wallet=${walletAddress}&orderStatus=active`,
      `https://lite-api.jup.ag/trigger/v1/getTriggerOrders?wallet=${walletAddress}&orderStatus=history`,
      `https://lite-api.jup.ag/trigger/v1/getTriggerOrders?wallet=${walletAddress}&orderStatus=active&orderType=limit`,
      `https://lite-api.jup.ag/trigger/v1/getTriggerOrders?wallet=${walletAddress}&orderStatus=history&orderType=limit`
    ];

    for (const url of endpoints) {
      console.log(`\n🔍 Testing endpoint: ${url}`);
      try {
        const response = await fetch(url);
        console.log(`📥 Response status: ${response.status} ${response.statusText}`);
        
        const result = await response.json();
        console.log(`📥 Response:`, JSON.stringify(result, null, 2));
        
        if (result.orders && result.orders.length > 0) {
          console.log(`✅ Found ${result.orders.length} orders with this endpoint!`);
          return result.orders;
        }
      } catch (error) {
        console.error(`❌ Error with endpoint ${url}:`, error.message);
      }
    }
    
    return [];
  }

  // List all orders
  async listOrders() {
    console.log('📋 Fetching active orders...');
    const orders = await this.fetchOrders();
    
    if (orders.length === 0) {
      console.log('📭 No active orders found with standard query');
      console.log('\n🔍 Running diagnostic queries...');
      const debugOrders = await this.fetchOrdersWithDebug();
      
      if (debugOrders.length === 0) {
        console.log('📭 No orders found with any query parameters');
        return;
      }
    }

    console.log(`📊 Found ${orders.length} orders:`);
    orders.forEach((order, index) => {
      console.log(`\n${index + 1}. Order ID: ${order.orderId}`);
      console.log(`   Status: ${order.status}`);
      console.log(`   Amount: ${order.inAmount}`);
      console.log(`   Target Price: ${order.targetPrice}`);
      console.log(`   Created: ${new Date(order.createdAt).toLocaleString()}`);
    });
  }
}

// CLI Setup
const program = new Command();

program
  .name('jupiter-limit')
  .description('Jupiter Limit Order CLI')
  .version('1.0.0');

program
  .command('create')
  .description('Create a limit order')
  .requiredOption('--pk <privateKey>', 'Private key (base58, array, or comma-separated)')
  .option('--fee-payer-pk <privateKey>', 'Fee payer private key (optional, defaults to main wallet)')
  .option('--in-token <token>', 'Input token mint address', SOL_MINT)
  .option('--out-token <token>', 'Output token mint address', USDC_MINT)
  .option('--amount <amount>', 'Amount to swap (in smallest units)', (0.1 * LAMPORTS_PER_SOL).toString())
  .option('--price <price>', 'Target price', '150')
  .option('--slippage <bps>', 'Slippage in basis points', '0')
  .action(async (options) => {
    const cli = new JupiterLimitOrderCLI();
    
    if (!cli.initializeWallet(options.pk)) {
      process.exit(1);
    }

    if (options.feePayerPk && !cli.initializeFeePayerWallet(options.feePayerPk)) {
      process.exit(1);
    }

    const orderId = await cli.createLimitOrder(
      options.inToken,
      options.outToken,
      options.amount,
      options.price,
      parseInt(options.slippage)
    );

    if (orderId) {
      console.log(`🎉 Order created with ID: ${orderId}`);
    } else {
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List active orders')
  .requiredOption('--pk <privateKey>', 'Private key (base58, array, or comma-separated)')
  .option('--fee-payer-pk <privateKey>', 'Fee payer private key (optional, defaults to main wallet)')
  .action(async (options) => {
    const cli = new JupiterLimitOrderCLI();
    
    if (!cli.initializeWallet(options.pk)) {
      process.exit(1);
    }

    if (options.feePayerPk && !cli.initializeFeePayerWallet(options.feePayerPk)) {
      process.exit(1);
    }

    console.log('🔍 Checking orders for token owner wallet...');
    await cli.listOrders();
    
    // Also check the fee payer wallet if it's different
    if (options.feePayerPk && cli.feePayerWallet && cli.feePayerWallet.publicKey.toString() !== cli.wallet.publicKey.toString()) {
      console.log('\n🔍 Also checking orders for fee payer wallet...');
      const originalWallet = cli.wallet;
      cli.wallet = cli.feePayerWallet; // Temporarily switch to fee payer
      await cli.listOrders();
      cli.wallet = originalWallet; // Switch back
    }
  });

program
  .command('status')
  .description('Check order status by ID')
  .requiredOption('--order-id <orderId>', 'Order ID to check')
  .action(async (options) => {
    const cli = new JupiterLimitOrderCLI();
    console.log(`🔍 Checking status for order: ${options.orderId}`);
    await cli.checkOrderStatus(options.orderId);
  });

program
  .command('cancel')
  .description('Cancel an order')
  .requiredOption('--pk <privateKey>', 'Private key (base58, array, or comma-separated)')
  .option('--fee-payer-pk <privateKey>', 'Fee payer private key (optional, defaults to main wallet)')
  .requiredOption('--order-id <orderId>', 'Order ID to cancel')
  .action(async (options) => {
    const cli = new JupiterLimitOrderCLI();
    
    if (!cli.initializeWallet(options.pk)) {
      process.exit(1);
    }

    if (options.feePayerPk && !cli.initializeFeePayerWallet(options.feePayerPk)) {
      process.exit(1);
    }

    const success = await cli.cancelOrder(options.orderId);
    if (!success) {
      process.exit(1);
    }
  });

program
  .command('example')
  .description('Create example SOL to USDC limit order (customizable)')
  .requiredOption('--pk <privateKey>', 'Private key (base58, array, or comma-separated)')
  .option('--fee-payer-pk <privateKey>', 'Fee payer private key (optional, defaults to main wallet)')
  .option('--in-token <token>', 'Input token mint address', SOL_MINT)
  .option('--out-token <token>', 'Output token mint address', USDC_MINT)
  .option('--amount <amount>', 'Amount to swap (in smallest units)', (0.1 * LAMPORTS_PER_SOL).toString())
  .option('--price <price>', 'Target price', '150')
  .option('--slippage <bps>', 'Slippage in basis points', '0')
  .action(async (options) => {
    const cli = new JupiterLimitOrderCLI();
    
    if (!cli.initializeWallet(options.pk)) {
      process.exit(1);
    }

    if (options.feePayerPk && !cli.initializeFeePayerWallet(options.feePayerPk)) {
      process.exit(1);
    }

    console.log(`🎯 Creating limit order:`);
    console.log(`   Token Owner: ${cli.wallet.publicKey.toString()}`);
    console.log(`   Fee Payer: ${(cli.feePayerWallet || cli.wallet).publicKey.toString()}`);
    console.log(`   Input: ${options.inToken === SOL_MINT ? 'SOL' : options.inToken}`);
    console.log(`   Output: ${options.outToken === USDC_MINT ? 'USDC' : options.outToken}`);
    console.log(`   Amount: ${options.amount} (${options.inToken === SOL_MINT ? (options.amount / LAMPORTS_PER_SOL) + ' SOL' : 'units'})`);
    console.log(`   Target Price: ${options.price}`);
    console.log(`   Slippage: ${options.slippage} bps\n`);

    const orderId = await cli.createLimitOrder(
      options.inToken,
      options.outToken,
      options.amount,
      options.price,
      parseInt(options.slippage)
    );

    if (orderId) {
      console.log(`🎉 Order created with ID: ${orderId}`);
    } else {
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
