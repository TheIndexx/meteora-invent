#!/usr/bin/env node

/**
 * Comprehensive JavaScript Test for Fee Distribution
 *
 * This script:
 * 1. Connects to Supabase to get real band data
 * 2. Tests SOL distributions using distribute-sol.js
 * 3. Tests asset swaps using swap-fee-to-asset.js
 * 4. Generates comprehensive test report
 *
 * Usage: node test-fee-distribution.js
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Environment variables
const SUPABASE_URL = process.env.bands_supabase_url;
const SUPABASE_KEY = process.env.bands_supabase_key;
const PLATFORM_WALLET_KEY = process.env.bands_platform_wallet;
const PLATFORM_WALLET_PUBKEY = process.env.bands_platform_wallet_pubkey;
const RPC_URL = process.env.bands_solana_rpc || "https://api.mainnet-beta.solana.com";

class FeeDistributionTester {
    constructor() {
        // Initialize Supabase client
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            throw new Error('Missing Supabase credentials');
        }

        this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        this.testResults = [];
    }

    async runComprehensiveTest() {
        console.log('🧪 Starting comprehensive JavaScript fee distribution test');
        console.log('='.repeat(60));

        try {
            // Step 1: Get real band data from Supabase
            const bands = await this.fetchTestBands();

            if (bands.length === 0) {
                console.log('❌ No bands found for testing');
                return { success: false, error: 'No bands found' };
            }

            console.log(`📊 Found ${bands.length} bands to test`);

            // Step 2: Test each band
            for (let i = 0; i < bands.length; i++) {
                const band = bands[i];
                console.log(`\n🎯 Testing band ${i + 1}/${bands.length}: ${band.id}`);

                try {
                    const result = await this.testBandFeeDistribution(band);
                    this.testResults.push(result);

                    if (result.success) {
                        console.log(`✅ Band ${band.id} test PASSED`);
                    } else {
                        console.log(`❌ Band ${band.id} test FAILED: ${result.error}`);
                    }
                } catch (error) {
                    console.log(`💥 Band ${band.id} test CRASHED: ${error.message}`);
                    this.testResults.push({
                        bandId: band.id,
                        success: false,
                        error: error.message
                    });
                }
            }

            // Step 3: Generate comprehensive report
            this.generateTestReport();

            const successCount = this.testResults.filter(r => r.success).length;
            return {
                success: successCount > 0,
                totalTests: this.testResults.length,
                successfulTests: successCount,
                failedTests: this.testResults.length - successCount,
                results: this.testResults
            };

        } catch (error) {
            console.error('💥 Test suite failed:', error.message);
            return { success: false, error: error.message };
        }
    }

    async fetchTestBands() {
        console.log('📋 Fetching band data from Supabase...');

        try {
            const { data, error } = await this.supabase
                .from('bands')
                .select(`
                    id,
                    fee_wallet_key,
                    creator_wallet,
                    assets (
                        id,
                        token_mint,
                        percentage,
                        sell_multiple,
                        asset_vault_pubkey
                    )
                `)
                .eq('token_band', true)
                .limit(2); // Test with 2 bands

            if (error) {
                throw new Error(`Supabase error: ${error.message}`);
            }

            if (!data || data.length === 0) {
                return [];
            }

            // Filter bands that have all required data
            const validBands = data.filter(band => {
                if (!band.fee_wallet_key || !band.creator_wallet || !band.assets) {
                    console.log(`⏭️ Skipping band ${band.id} - missing required fields`);
                    return false;
                }

                // Filter valid assets
                const validAssets = band.assets.filter(asset =>
                    asset.token_mint &&
                    asset.percentage &&
                    asset.asset_vault_pubkey &&
                    parseFloat(asset.percentage) > 0
                );

                if (validAssets.length === 0) {
                    console.log(`⏭️ Skipping band ${band.id} - no valid assets`);
                    return false;
                }

                // Update band with only valid assets
                band.assets = validAssets;
                return true;
            });

            console.log(`✅ Found ${validBands.length} valid bands for testing`);
            return validBands;

        } catch (error) {
            console.error('Failed to fetch bands:', error.message);
            throw error;
        }
    }

    async testBandFeeDistribution(band) {
        const bandId = band.id;

        try {
            console.log(`📋 Testing band: ${bandId}`);
            console.log(`   Fee wallet: ${band.fee_wallet_key.substring(0, 8)}...`);
            console.log(`   Creator: ${band.creator_wallet.substring(0, 8)}...`);
            console.log(`   Assets: ${band.assets.length}`);

            // Test parameters (small amounts for safe testing)
            const testSolAmount = 0.005; // 5 mSOL
            const assetPoolSol = testSolAmount * 0.80;
            const creatorSol = testSolAmount * 0.10;
            const platformSol = testSolAmount * 0.10;

            console.log(`💰 Test amounts:`);
            console.log(`   Total: ${testSolAmount} SOL`);
            console.log(`   Assets: ${assetPoolSol} SOL`);
            console.log(`   Creator: ${creatorSol} SOL`);
            console.log(`   Platform: ${platformSol} SOL`);

            // Step 1: Test SOL distributions
            console.log('\n💸 Testing SOL distributions...');

            const platformResult = await this.testSolDistribution(
                band.fee_wallet_key,
                PLATFORM_WALLET_PUBKEY,
                platformSol,
                'platform'
            );

            const creatorResult = await this.testSolDistribution(
                band.fee_wallet_key,
                band.creator_wallet,
                creatorSol,
                'creator'
            );

            // Step 2: Test asset swaps
            console.log('\n🔄 Testing asset swaps...');

            const assetResults = [];
            for (let i = 0; i < Math.min(band.assets.length, 2); i++) {
                const asset = band.assets[i];
                const assetSol = assetPoolSol * (parseFloat(asset.percentage) / 100);

                if (assetSol < 0.001) {
                    console.log(`  ⏭️ Skipping ${asset.token_mint.substring(0, 8)} - amount too small (${assetSol})`);
                    continue;
                }

                console.log(`  🎯 Testing swap: ${assetSol} SOL → ${asset.token_mint.substring(0, 8)}`);

                const swapResult = await this.testAssetSwap(
                    band.fee_wallet_key,
                    asset.asset_vault_pubkey,
                    asset.token_mint,
                    assetSol
                );

                assetResults.push({
                    tokenMint: asset.token_mint.substring(0, 8),
                    solAmount: assetSol,
                    success: swapResult.success,
                    signature: swapResult.signature,
                    error: swapResult.error
                });

                if (swapResult.success) {
                    console.log(`    ✅ Success: ${swapResult.signature}`);
                } else {
                    console.log(`    ❌ Failed: ${swapResult.error}`);
                }
            }

            // Calculate overall success
            const solSuccess = platformResult.success && creatorResult.success;
            const assetSuccessCount = assetResults.filter(r => r.success).length;
            const overallSuccess = solSuccess && assetSuccessCount > 0;

            return {
                bandId,
                success: overallSuccess,
                solDistributions: {
                    platform: platformResult,
                    creator: creatorResult,
                    success: solSuccess
                },
                assetSwaps: {
                    results: assetResults,
                    successful: assetSuccessCount,
                    total: assetResults.length
                }
            };

        } catch (error) {
            console.error(`Band ${bandId} test failed:`, error.message);
            return {
                bandId,
                success: false,
                error: error.message
            };
        }
    }

    async testSolDistribution(feeWalletKey, recipientPubkey, amountSol, type) {
        try {
            console.log(`  💸 Testing ${type} distribution: ${amountSol} SOL`);

            // distribute-sol.js expects: <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>
            // For individual distributions, we'll use 0 for the other type
            const platformAmount = type === 'platform' ? amountSol : 0;
            const creatorAmount = type === 'creator' ? amountSol : 0;

            const cmd = `node fee-distribution/distribute-sol.js "${feeWalletKey}" "${PLATFORM_WALLET_PUBKEY}" "${recipientPubkey}" ${platformAmount} ${creatorAmount} "${PLATFORM_WALLET_KEY}"`;

            const { stdout, stderr } = await execAsync(cmd, {
                cwd: __dirname,
                timeout: 30000 // 30 second timeout
            });

            let result;
            try {
                // Extract JSON from output - look for content between first { and last }
                const output = stdout.trim();
                const firstBrace = output.indexOf('{');
                const lastBrace = output.lastIndexOf('}');

                if (firstBrace === -1 || lastBrace === -1) {
                    throw new Error('No JSON found in output');
                }

                const jsonStr = output.substring(firstBrace, lastBrace + 1);
                result = JSON.parse(jsonStr);
            } catch (e) {
                throw new Error(`Invalid JSON response: ${stdout}`);
            }

            if (result.success) {
                console.log(`    ✅ ${type} distribution success: ${result.signature}`);
            } else {
                console.log(`    ❌ ${type} distribution failed: ${result.error}`);
            }

            return result;

        } catch (error) {
            console.log(`    ❌ ${type} distribution error: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async testAssetSwap(feeWalletKey, assetVaultPubkey, tokenMint, solAmount) {
        try {
            // swap-fee-to-asset.js expects: <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>
            const cmd = `node fee-distribution/swap-fee-to-asset.js "${feeWalletKey}" "${assetVaultPubkey}" "${tokenMint}" ${solAmount} "${PLATFORM_WALLET_KEY}"`;

            const { stdout, stderr } = await execAsync(cmd, {
                cwd: __dirname,
                timeout: 60000 // 60 second timeout for swaps
            });

            let result;
            try {
                // Extract JSON from output - look for content between first { and last }
                const output = stdout.trim();
                const firstBrace = output.indexOf('{');
                const lastBrace = output.lastIndexOf('}');

                if (firstBrace === -1 || lastBrace === -1) {
                    throw new Error('No JSON found in output');
                }

                const jsonStr = output.substring(firstBrace, lastBrace + 1);
                result = JSON.parse(jsonStr);
            } catch (e) {
                throw new Error(`Invalid JSON response: ${stdout}`);
            }

            return result;

        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    generateTestReport() {
        const totalTests = this.testResults.length;
        const successfulTests = this.testResults.filter(r => r.success).length;
        const failedTests = totalTests - successfulTests;

        console.log('\n' + '='.repeat(60));
        console.log('🧪 COMPREHENSIVE JAVASCRIPT TEST REPORT');
        console.log('='.repeat(60));
        console.log(`📊 Total Bands Tested: ${totalTests}`);
        console.log(`✅ Successful Tests: ${successfulTests}`);
        console.log(`❌ Failed Tests: ${failedTests}`);
        console.log(`📈 Success Rate: ${((successfulTests / totalTests) * 100).toFixed(1)}%`);

        if (successfulTests > 0) {
            console.log('\n✅ SUCCESSFUL BANDS:');
            this.testResults.forEach(result => {
                if (result.success) {
                    const assetInfo = result.assetSwaps ?
                        `Assets: ${result.assetSwaps.successful}/${result.assetSwaps.total}` :
                        'Assets: N/A';
                    console.log(`  • ${result.bandId}: SOL ✅, ${assetInfo}`);
                }
            });
        }

        if (failedTests > 0) {
            console.log('\n❌ FAILED BANDS:');
            this.testResults.forEach(result => {
                if (!result.success) {
                    console.log(`  • ${result.bandId}: ${result.error || 'Unknown error'}`);
                }
            });
        }

        console.log('\n🎯 DETAILED RESULTS:');
        this.testResults.forEach(result => {
            console.log(`\n📋 Band: ${result.bandId}`);
            if (result.success) {
                console.log('  ✅ Overall: SUCCESS');
                if (result.solDistributions) {
                    console.log(`  💸 SOL Distributions: ${result.solDistributions.success ? '✅' : '❌'}`);
                    console.log(`    - Platform: ${result.solDistributions.platform.success ? '✅' : '❌'}`);
                    console.log(`    - Creator: ${result.solDistributions.creator.success ? '✅' : '❌'}`);
                }
                if (result.assetSwaps) {
                    console.log(`  🔄 Asset Swaps: ${result.assetSwaps.successful}/${result.assetSwaps.total} successful`);
                    result.assetSwaps.results.forEach(swap => {
                        const status = swap.success ? '✅' : '❌';
                        console.log(`    - ${swap.tokenMint}: ${status} ${swap.success ? swap.signature : swap.error}`);
                    });
                }
            } else {
                console.log(`  ❌ Overall: FAILED - ${result.error}`);
            }
        });

        if (successfulTests === totalTests) {
            console.log('\n🎉 ALL TESTS PASSED! JavaScript implementation working perfectly!');
        } else if (successfulTests > 0) {
            console.log('\n⚠️ PARTIAL SUCCESS: Core functionality works, some issues detected.');
        } else {
            console.log('\n🚨 ALL TESTS FAILED: Major issues with JavaScript implementation.');
        }

        console.log('='.repeat(60));
    }
}

// Main execution
async function main() {
    try {
        // Validate environment variables
        const requiredEnvVars = [
            'bands_supabase_url',
            'bands_supabase_key',
            'bands_platform_wallet',
            'bands_platform_wallet_pubkey'
        ];

        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        if (missingVars.length > 0) {
            console.error('❌ Missing required environment variables:', missingVars.join(', '));
            process.exit(1);
        }

        console.log('🚀 JavaScript Fee Distribution Test Suite');
        console.log('📅 Started at:', new Date().toISOString());

        const tester = new FeeDistributionTester();
        const result = await tester.runComprehensiveTest();

        console.log('\n📄 Final Result:', result.success ? '✅ SUCCESS' : '❌ FAILURE');

        // Exit with appropriate code
        process.exit(result.success ? 0 : 1);

    } catch (error) {
        console.error('💥 Test suite crashed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { FeeDistributionTester };