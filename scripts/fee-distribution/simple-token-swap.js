#!/usr/bin/env node

/**
 * Jupiter Simple Token Swap Script
 *
 * This script performs a simple token-to-token swap within one wallet
 * with a separate fee payer for transaction costs.
 *
 * Usage:
 * node simple-token-swap.js --wallet-key <key> --input-token <mint> --output-token <mint> --amount <amount> --fee-payer-key <key>
 *
 * Arguments:
 * - --wallet-key: Private key of wallet containing the input tokens
 * - --input-token: Mint address of the token to swap from
 * - --output-token: Mint address of the token to swap to
 * - --amount: Amount of input token to swap (in token units, not smallest unit)
 * - --fee-payer-key: Private key of wallet that will pay transaction fees
 *
 * Returns JSON response for Python integration
 */

import { JupiterSimpleSwap } from './utils/jupiter-simple.js';
import { executeWithErrorHandling, createSuccessResponse } from './utils/response.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    
    if (!key || !key.startsWith('--') || !value) {
      throw new Error('Invalid argument format. Use --key value pairs.');
    }
    
    const paramName = key.slice(2).replace(/-/g, '_'); // Convert --wallet-key to wallet_key
    parsed[paramName] = value;
  }
  
  return parsed;
}

async function main() {
  const args = parseArgs();
  
  const {
    wallet_key: walletKey,
    input_token: inputToken,
    output_token: outputToken,
    amount,
    fee_payer_key: feePayerKey
  } = args;

  // Validate all required parameters are provided
  if (!walletKey || !inputToken || !outputToken || !amount || !feePayerKey) {
    throw new Error('Usage: node simple-token-swap.js --wallet-key <key> --input-token <mint> --output-token <mint> --amount <amount> --fee-payer-key <key>');
  }

  // Parse and validate amount
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new Error(`Invalid amount: ${amount}. Must be a positive number.`);
  }

  // Initialize Jupiter simple swap
  const jupiter = new JupiterSimpleSwap();

  // Validate parameters before execution
  jupiter.validateSwapParams({
    walletKey,
    inputToken,
    outputToken,
    amount: parsedAmount,
    feePayerKey
  });

  // Check wallet balances before swap
  const { createConnection, parsePrivateKey } = await import('./utils/solana.js');
  const connection = createConnection();
  const wallet = parsePrivateKey(walletKey);
  const feePayer = parsePrivateKey(feePayerKey);
  
  const initialWalletBalance = await connection.getBalance(wallet.publicKey);
  const initialFeePayerBalance = await connection.getBalance(feePayer.publicKey);

  // Execute the token swap
  const result = await jupiter.executeSwap({
    walletKey,
    inputToken,
    outputToken,
    amount: parsedAmount,
    feePayerKey,
    slippageBps: 2000, // 20% slippage tolerance for reliability
    maxRetries: 3
  });

  // Check wallet balances after swap
  const finalWalletBalance = await connection.getBalance(wallet.publicKey);
  const finalFeePayerBalance = await connection.getBalance(feePayer.publicKey);

  return createSuccessResponse({
    operation: 'simple-token-swap',
    txSignature: result.signature,
    inputToken,
    outputToken,
    inputAmount: result.inputAmount, // Raw amount in smallest unit
    outputAmount: result.outputAmount, // Raw amount in smallest unit
    inputAmountFormatted: result.inputAmountFormatted, // Human-readable amount
    outputAmountFormatted: result.outputAmountFormatted, // Human-readable amount
    swapRate: result.swapRate, // Output tokens per input token
    inputTokenDecimals: result.inputTokenDecimals,
    outputTokenDecimals: result.outputTokenDecimals,
    walletAddress: wallet.publicKey.toString(),
    feePayerAddress: feePayer.publicKey.toString(),
    feesSpent: result.feesSpent, // SOL spent on transaction fees
    swapMode: 'ExactIn',
    slippageBps: 2000
  });
}

// Execute with proper error handling and JSON output
executeWithErrorHandling(main);
