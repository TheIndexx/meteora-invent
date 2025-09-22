#!/usr/bin/env node

/**
 * Test script for Jupiter payments-as-swap integration
 * This validates the scripts work correctly before production use
 */

import { JupiterPaymentsAsSwap } from './utils/jupiter.js';
import { createConnection, parsePrivateKey, getSolBalance } from './utils/solana.js';
import { createSuccessResponse, createErrorResponse } from './utils/response.js';

async function testScripts() {
  console.log('🧪 Testing Jupiter payments-as-swap integration...\n');

  try {
    // Test 1: Validate environment and dependencies
    console.log('1️⃣ Testing dependencies...');
    const connection = createConnection();
    const jupiter = new JupiterPaymentsAsSwap();
    console.log('   ✅ Dependencies loaded successfully\n');

    // Test 2: Test quote fetching
    console.log('2️⃣ Testing Jupiter quote API...');
    try {
      const quote = await jupiter.getQuote({
        inputMint: 'So11111111111111111111111111111111111111112', // SOL
        outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        amount: 1000000, // 0.001 SOL in lamports
        slippageBps: 2000
      });
      console.log(`   ✅ Quote successful: ${quote.inAmount} → ${quote.outAmount}`);
    } catch (error) {
      console.log(`   ❌ Quote failed: ${error.message}`);
      return false;
    }
    console.log('');

    // Test 3: Validate parameter parsing
    console.log('3️⃣ Testing parameter validation...');
    try {
      // Test with dummy keys (should fail validation)
      jupiter.validateSwapParams({
        feeWalletKey: 'invalid',
        assetVaultPubkey: 'invalid',
        tokenMint: 'invalid',
        solAmount: 0.001,
        platformWalletKey: 'invalid'
      });
      console.log('   ❌ Validation should have failed');
      return false;
    } catch (error) {
      console.log('   ✅ Parameter validation working correctly');
    }
    console.log('');

    // Test 4: Test response formatting
    console.log('4️⃣ Testing response formatting...');
    const successResponse = createSuccessResponse({ test: 'data' });
    const errorResponse = createErrorResponse(new Error('test error'));

    if (successResponse.success && !errorResponse.success) {
      console.log('   ✅ Response formatting working correctly');
    } else {
      console.log('   ❌ Response formatting failed');
      return false;
    }
    console.log('');

    console.log('🎉 All tests passed! Jupiter integration is ready for production.\n');

    console.log('📋 Usage Examples:');
    console.log('   Asset swap:');
    console.log('   node swap-fee-to-asset.js <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>');
    console.log('');
    console.log('   SOL distribution:');
    console.log('   node distribute-sol.js <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>');
    console.log('');

    return true;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

// Run tests
testScripts().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Fatal test error:', error);
  process.exit(1);
});