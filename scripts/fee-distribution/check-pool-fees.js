#!/usr/bin/env node

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { CpAmm, getUnClaimReward } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import bs58 from 'bs58';

/**
 * Check SOL fees in a Meteora pool before claiming
 * Usage: node check-pool-fees.js <fee_wallet_private_key> <pool_address> <min_sol_threshold>
 */

async function checkPoolSolFees(connection, wallet, poolAddress, minSolThreshold) {
    try {
        const cpAmmInstance = new CpAmm(connection);

        // Step 1: Fetch pool state (required for getUnClaimReward)
        const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

        // Step 2: Get user positions in this pool
        const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

        if (userPositions.length === 0) {
            return {
                success: true,
                poolAddress: poolAddress.toString(),
                totalPositions: 0,
                unclaimedSolLamports: "0",
                unclaimedSolAmount: 0,
                meetsThreshold: false,
                threshold: minSolThreshold,
                message: "No positions found in this pool"
            };
        }

        // Step 3: Calculate unclaimed SOL fees (tokenB only)
        let totalSolFees = new BN(0);
        const positionDetails = [];

        for (const userPosition of userPositions) {
            const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);

            // KEY FUNCTION CALL - this gives us exact unclaimed fees
            const unclaimReward = getUnClaimReward(poolState, positionState);

            // Only accumulate tokenB fees (SOL)
            totalSolFees = totalSolFees.add(unclaimReward.feeTokenB);

            positionDetails.push({
                position: userPosition.position.toString(),
                unclaimedSolLamports: unclaimReward.feeTokenB.toString(),
                unclaimedSolAmount: unclaimReward.feeTokenB.toNumber() / 1e9
            });
        }

        // Step 4: Convert lamports to SOL
        const solAmount = totalSolFees.toNumber() / 1e9;

        // Step 5: Return structured result
        return {
            success: true,
            poolAddress: poolAddress.toString(),
            totalPositions: userPositions.length,
            unclaimedSolLamports: totalSolFees.toString(),
            unclaimedSolAmount: solAmount,
            meetsThreshold: solAmount >= minSolThreshold,
            threshold: minSolThreshold,
            positions: positionDetails
        };

    } catch (error) {
        return {
            success: false,
            error: error.message,
            poolAddress: poolAddress.toString(),
            unclaimedSolAmount: 0,
            meetsThreshold: false,
            threshold: minSolThreshold
        };
    }
}

async function main() {
    try {
        // Parse command line arguments
        const args = process.argv.slice(2);

        if (args.length !== 3) {
            console.error(JSON.stringify({
                success: false,
                error: "Usage: node check-pool-fees.js <fee_wallet_private_key> <pool_address> <min_sol_threshold>"
            }));
            process.exit(1);
        }

        const [feeWalletPrivateKey, poolAddressStr, minThresholdStr] = args;
        const minSolThreshold = parseFloat(minThresholdStr);

        if (isNaN(minSolThreshold)) {
            console.error(JSON.stringify({
                success: false,
                error: "Invalid threshold value. Must be a number."
            }));
            process.exit(1);
        }

        // Setup connection
        const connection = new Connection(
            process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );

        // Create wallet from private key
        const privateKeyBytes = bs58.decode(feeWalletPrivateKey);
        let keypair;

        if (privateKeyBytes.length === 32) {
            // This is just the private key
            keypair = Keypair.fromSeed(privateKeyBytes);
        } else if (privateKeyBytes.length === 64) {
            // This is full keypair
            keypair = Keypair.fromSecretKey(privateKeyBytes);
        } else {
            console.error(JSON.stringify({
                success: false,
                error: `Invalid private key length: ${privateKeyBytes.length}. Expected 32 or 64 bytes.`
            }));
            process.exit(1);
        }

        const wallet = new Wallet(keypair);
        const poolAddress = new PublicKey(poolAddressStr);

        // Check pool fees
        const result = await checkPoolSolFees(connection, wallet, poolAddress, minSolThreshold);

        // Output result as JSON
        console.log(JSON.stringify(result, null, 0));

    } catch (error) {
        console.error(JSON.stringify({
            success: false,
            error: error.message,
            unclaimedSolAmount: 0,
            meetsThreshold: false
        }));
        process.exit(1);
    }
}

// Run the script
main().catch(error => {
    console.error(JSON.stringify({
        success: false,
        error: error.message,
        unclaimedSolAmount: 0,
        meetsThreshold: false
    }));
    process.exit(1);
});