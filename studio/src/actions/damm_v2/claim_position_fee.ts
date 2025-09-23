import { Connection, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { DammV2Config } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { parseConfigFromCli, parseCliArguments, getKeypairFromCliOrConfig } from '../../helpers';
import { claimPositionFee } from '../../lib/damm_v2';

async function main() {
  const config: DammV2Config = (await parseConfigFromCli()) as DammV2Config;
  const cliArguments = parseCliArguments();

  const keypair = await getKeypairFromCliOrConfig(config, cliArguments.walletPk);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  let poolAddress: PublicKey;
  if (cliArguments.poolAddress) {
    console.log('> Using pool address from CLI argument');
    poolAddress = new PublicKey(cliArguments.poolAddress);
  } else {
    if (!config.poolAddress) {
      throw new Error('Missing pool address. Provide --pool-address argument or set poolAddress in configuration');
    }
    poolAddress = new PublicKey(config.poolAddress);
  }

  console.log(`- Using pool address ${poolAddress.toString()}`);

  /// --------------------------------------------------------------------------
  if (config) {
    try {
      await claimPositionFee(config, connection, wallet, poolAddress);
    } catch (error: any) {
      // Check if this is a SendTransactionError and extract logs
      if (error.logs && Array.isArray(error.logs)) {
        console.error('\n>>> Transaction failed with logs:');
        error.logs.forEach((log: string) => console.error(`    ${log}`));
      } else if (error.transactionLogs && Array.isArray(error.transactionLogs)) {
        console.error('\n>>> Transaction failed with logs:');
        error.transactionLogs.forEach((log: string) => console.error(`    ${log}`));
      }

      // Log the full error details
      if (error.signature) {
        console.error(`>>> Failed signature: ${error.signature}`);
      }
      if (error.transactionMessage) {
        console.error(`>>> Error message: ${error.transactionMessage}`);
      }

      // Re-throw to maintain existing behavior
      throw error;
    }
  } else {
    throw new Error('Must provide Dynamic V2 configuration');
  }
}

main();
