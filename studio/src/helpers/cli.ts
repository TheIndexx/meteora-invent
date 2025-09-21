import { CliArguments, MeteoraConfig, NetworkConfig } from '../utils/types';
import { parseArgs } from 'util';
import { safeParseJsonFromFile, safeParseKeypairFromFile, parseKeypairFromPrivateKey } from './utils';
import { validateConfig } from './validation';
import { parse } from 'csv-parse';
import fs from 'fs';
import path from 'path';
import * as readline from 'readline';
import { Keypair } from '@solana/web3.js';

export function parseNetworkFlag(): string | undefined {
  const { values } = parseArgs({
    args: process.argv,
    options: {
      network: {
        type: 'string',
        short: 'n',
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return values.network;
}

export function getNetworkConfig(network: string): NetworkConfig {
  switch (network.toLowerCase()) {
    case 'devnet':
      return {
        rpcUrl: 'https://api.devnet.solana.com',
        shouldAirdrop: true,
        airdropAmount: 5,
      };
    case 'localnet':
      return {
        rpcUrl: 'http://localhost:8899',
        shouldAirdrop: true,
        airdropAmount: 5,
      };
    default:
      throw new Error('Invalid network. Please use --network devnet or --network localnet');
  }
}

export function parseCliArguments(): CliArguments {
  const { values } = parseArgs({
    args: process.argv,
    options: {
      config: {
        type: 'string',
      },
      'base-mint': {
        type: 'string',
      },
      'wallet-pk': {
        type: 'string',
      },
      'pool-address': {
        type: 'string',
      },
    },
    strict: false,
    allowPositionals: true,
  });

  return {
    config: typeof values.config === 'string' ? values.config : undefined,
    baseMint: typeof values['base-mint'] === 'string' ? values['base-mint'] : undefined,
    walletPk: typeof values['wallet-pk'] === 'string' ? values['wallet-pk'] : undefined,
    poolAddress: typeof values['pool-address'] === 'string' ? values['pool-address'] : undefined,
  };
}

export async function parseConfigFromCli(): Promise<MeteoraConfig> {
  const cliArguments = parseCliArguments();
  if (!cliArguments.config) {
    throw new Error('Please provide a config file path to --config flag');
  }
  let configFilePath = cliArguments.config!;

  // If the path is relative, resolve it appropriately based on where we're running from
  if (!path.isAbsolute(configFilePath)) {
    const workspaceMarker = path.join(process.cwd(), '../pnpm-workspace.yaml');
    if (fs.existsSync(workspaceMarker)) {
      if (configFilePath.startsWith('./studio/')) {
        configFilePath = configFilePath.replace('./studio/', './');
      }
      configFilePath = path.resolve(process.cwd(), configFilePath);
    } else {
      configFilePath = path.resolve(process.cwd(), configFilePath);
    }
  }

  console.log(`> Using config file: ${configFilePath}`);

  const config: MeteoraConfig = await safeParseJsonFromFile(configFilePath);

  // Override baseMint if provided via CLI
  if (cliArguments.baseMint) {
    console.log(`> Overriding baseMint from CLI: ${cliArguments.baseMint}`);
    config.baseMint = cliArguments.baseMint;
  }

  validateConfig(config);

  return config;
}

export async function getKeypairFromCliOrConfig(config: MeteoraConfig, walletPk?: string): Promise<Keypair> {
  if (walletPk) {
    console.log('> Using wallet private key from CLI argument');
    return parseKeypairFromPrivateKey(walletPk);
  } else {
    console.log(`> Using keypair file path ${config.keypairFilePath}`);
    return await safeParseKeypairFromFile(config.keypairFilePath);
  }
}

export async function parseCsv<T>(filePath: string): Promise<Array<T>> {
  const fileStream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    const parser = parse({
      columns: true, // Use the header row as keys
      skip_empty_lines: true, // Skip empty lines
    });

    const results: T[] = [];

    fileStream
      .pipe(parser)
      .on('data', (row: T) => results.push(row)) // Collect rows
      .on('end', () => resolve(results)) // Resolve the promise with results
      .on('error', (err) => reject(err)); // Reject the promise if error occurs
  });
}

/**
 * Interactive CLI selection helper that displays options and returns user's choice
 * @param options - Array of display strings for each option
 * @param prompt - The question to ask the user
 * @returns Promise that resolves to the selected index (0-based)
 */
export async function promptForSelection(
  options: string[],
  prompt: string = 'Please select an option'
): Promise<number> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(`\n${prompt}:`);
    options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option}`);
    });

    const askQuestion = () => {
      rl.question(`\nEnter your choice (1-${options.length}): `, (answer) => {
        const choice = parseInt(answer.trim(), 10);

        if (isNaN(choice) || choice < 1 || choice > options.length) {
          console.log(`Invalid choice. Please enter a number between 1 and ${options.length}.`);
          askQuestion();
          return;
        }

        rl.close();
        resolve(choice - 1); // Convert to 0-based index
      });
    };

    askQuestion();
  });
}
