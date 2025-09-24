#!/usr/bin/env node

/**
 * Test Script for Simplified Asset Vault → Holding Wallet Swap
 *
 * This script tests the simplified pattern:
 * 1. Asset Vault SOL → Asset Vault tokens (Simple Jupiter swap)
 * 2. Asset Vault tokens → Holding Wallet (SPL token transfer)
 *
 * Usage: node test-asset-vault-to-holding.js
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

class AssetVaultToHoldingTester {
    constructor() {
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            throw new Error('Missing Supabase credentials');
        }

        this.supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        this.testResults = [];
    }

    async runTest() {
        console.log('🧪 Testing SIMPLIFIED Asset Vault → Holding Wallet Swap');
        console.log('🎯 Using standard Jupiter swap API (not payments-as-swap)');
        console.log('='.repeat(60));

        try {
            // Get test bands
            const bands = await this.fetchTestBands();

            if (bands.length === 0) {
                console.log('❌ No bands found for testing');
                return { success: false, error: 'No bands found' };
            }

            console.log(`📊 Found ${bands.length} bands to test`);

            // Test each band
            for (let i = 0; i < bands.length; i++) {
                const band = bands[i];
                console.log(`\n🎯 Testing band ${i + 1}/${bands.length}: ${band.id}`);

                try {
                    const result = await this.testBandAssetVaultToHolding(band);
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

            // Generate report
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
                    holding_wallet_pubkey,
                    assets (
                        id,
                        token_mint,
                        percentage,
                        asset_vault_pubkey,
                        asset_vault_key
                    )
                `)
                .eq('token_band', true)
                .not('holding_wallet_pubkey', 'is', null)
                .limit(2); // Test with 2 bands

            if (error) {
                throw new Error(`Supabase error: ${error.message}`);
            }

            if (!data || data.length === 0) {
                return [];
            }

            // Filter bands that have all required data
            const validBands = data.filter(band => {
                if (!band.holding_wallet_pubkey || !band.assets) {
                    console.log(`⏭️ Skipping band ${band.id} - missing required fields`);
                    return false;
                }

                // Filter valid assets
                const validAssets = band.assets.filter(asset =>
                    asset.token_mint &&
                    asset.percentage &&
                    asset.asset_vault_pubkey &&
                    asset.asset_vault_key && // Need private key for both steps
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

    async testBandAssetVaultToHolding(band) {
        const bandId = band.id;

        try {
            console.log(`📋 Testing band: ${bandId}`);
            console.log(`   Holding wallet: ${band.holding_wallet_pubkey.substring(0, 8)}...`);
            console.log(`   Assets: ${band.assets.length}`);

            const swapResults = [];
            
            // Test up to 2 assets per band
            for (let i = 0; i < Math.min(band.assets.length, 2); i++) {
                const asset = band.assets[i];
                
                // HARDCODED: Always use pump token for testing
                const hardcodedTokenMint = '792MmiKWnR6PaegL8xWFajuqRcRVnJhoqk56r67ppump';

                console.log(`\n🔄 Testing SIMPLIFIED asset vault → holding swap ${i + 1}`);
                console.log(`   ⚡ Using standard Jupiter swap (not payments-as-swap)`);
                console.log(`   🎯 HARDCODED Token: ${hardcodedTokenMint.substring(0, 8)}... (pump)`);
                console.log(`   Asset Vault: ${asset.asset_vault_pubkey.substring(0, 8)}... (swaps ALL SOL)`);
                console.log(`   Holding Wallet: ${band.holding_wallet_pubkey.substring(0, 8)}...`);

                const swapResult = await this.testAssetVaultToHoldingSwap(
                    asset.asset_vault_key,     // Asset vault (private key)
                    band.holding_wallet_pubkey, // Holding wallet (public key)
                    hardcodedTokenMint         // HARDCODED: Use pump token
                );

                swapResults.push({
                    tokenMint: `${hardcodedTokenMint.substring(0, 8)} (pump)`,
                    originalTokenMint: asset.token_mint.substring(0, 8),
                    assetVault: asset.asset_vault_pubkey.substring(0, 8),
                    success: swapResult.success,
                    step1Signature: swapResult.step1Signature,
                    step2Signature: swapResult.step2Signature,
                    tokensTransferred: swapResult.tokensTransferred,
                    error: swapResult.error
                });

                if (swapResult.success) {
                    console.log(`    ✅ Success:`);
                    console.log(`       Step 1 (Swap): ${swapResult.step1Signature}`);
                    console.log(`       Step 2 (Transfer): ${swapResult.step2Signature}`);
                    console.log(`       Tokens transferred: ${swapResult.tokensTransferred}`);
                } else {
                    console.log(`    ❌ Failed: ${swapResult.error}`);
                }
            }

            // Calculate overall success
            const successCount = swapResults.filter(r => r.success).length;
            const overallSuccess = successCount > 0;

            return {
                bandId,
                success: overallSuccess,
                swaps: {
                    results: swapResults,
                    successful: successCount,
                    total: swapResults.length
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

    async testAssetVaultToHoldingSwap(assetVaultKey, holdingWalletPubkey, tokenMint) {
        try {
            // Use the new simplified asset vault to holding swap script
            const cmd = `node fee-distribution/swap-asset-vault-to-holding-simple.js "${assetVaultKey}" "${holdingWalletPubkey}" "${tokenMint}" "${PLATFORM_WALLET_KEY}"`;

            console.log(`    📝 Running simplified swap command...`);
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: __dirname,
                timeout: 120000 // 2 minute timeout for two-step process
            });

            let result;
            try {
                // Extract JSON from output
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
        console.log('🔄 SIMPLIFIED ASSET VAULT → HOLDING WALLET TEST REPORT');
        console.log('⚡ Using Standard Jupiter Swap API');
        console.log('='.repeat(60));
        console.log(`📊 Total Bands Tested: ${totalTests}`);
        console.log(`✅ Successful Tests: ${successfulTests}`);
        console.log(`❌ Failed Tests: ${failedTests}`);
        console.log(`📈 Success Rate: ${((successfulTests / totalTests) * 100).toFixed(1)}%`);

        if (successfulTests > 0) {
            console.log('\n✅ SUCCESSFUL ASSET VAULT → HOLDING SWAPS:');
            this.testResults.forEach(result => {
                if (result.success) {
                    console.log(`  • ${result.bandId}: ${result.swaps.successful}/${result.swaps.total} swaps successful`);
                }
            });
        }

        if (failedTests > 0) {
            console.log('\n❌ FAILED ASSET VAULT → HOLDING SWAPS:');
            this.testResults.forEach(result => {
                if (!result.success) {
                    console.log(`  • ${result.bandId}: ${result.error || 'Unknown error'}`);
                }
            });
        }

        console.log('\n🎯 DETAILED ASSET VAULT → HOLDING RESULTS:');
        this.testResults.forEach(result => {
            console.log(`\n📋 Band: ${result.bandId}`);
            if (result.success) {
                console.log(`  ✅ Overall: SUCCESS - ${result.swaps.successful}/${result.swaps.total} swaps worked`);
                result.swaps.results.forEach(swap => {
                    const status = swap.success ? '✅' : '❌';
                    console.log(`    - ${swap.tokenMint} (${swap.assetVault}): ${status}`);
                    if (swap.success) {
                        console.log(`      Swap: ${swap.step1Signature}`);
                        console.log(`      Transfer: ${swap.step2Signature}`);
                        console.log(`      Tokens: ${swap.tokensTransferred}`);
                    } else {
                        console.log(`      Error: ${swap.error}`);
                    }
                });
            } else {
                console.log(`  ❌ Overall: FAILED - ${result.error}`);
            }
        });

        if (successfulTests === totalTests) {
            console.log('\n🎉 ALL ASSET VAULT → HOLDING SWAPS PASSED! This pattern works perfectly!');
        } else if (successfulTests > 0) {
            console.log('\n⚠️ PARTIAL SUCCESS: Asset Vault → Holding swaps work for some bands.');
        } else {
            console.log('\n🚨 ALL ASSET VAULT → HOLDING SWAPS FAILED: This pattern needs investigation.');
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
            'bands_platform_wallet'
        ];

        const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
        if (missingVars.length > 0) {
            console.error('❌ Missing required environment variables:', missingVars.join(', '));
            process.exit(1);
        }

        console.log('🚀 SIMPLIFIED Asset Vault → Holding Wallet Test Suite');
        console.log('⚡ Testing standard Jupiter swap implementation');
        console.log('📅 Started at:', new Date().toISOString());

        const tester = new AssetVaultToHoldingTester();
        const result = await tester.runTest();

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

export { AssetVaultToHoldingTester };
