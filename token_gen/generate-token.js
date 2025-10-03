#!/usr/bin/env node

/**
 * Simple SPL Token Launcher
 * Creates a single SPL token with custom metadata and returns the contract address (mint)
 * 
 * Usage: node launch-spl-token.js --name "My Token" --symbol "MTK" [options]
 */

require('dotenv').config();
const {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  PublicKey,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
<<<<<<< HEAD
  setAuthority,
=======
  createSetAuthorityInstruction,
>>>>>>> c0c5220 (removed mint auth)
  AuthorityType,
} = require('@solana/spl-token');
const {
  createCreateMetadataAccountV3Instruction,
  PROGRAM_ID: TOKEN_METADATA_PROGRAM_ID,
} = require('@metaplex-foundation/mpl-token-metadata');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bs58 = require('bs58').default;

class SimpleTokenLauncher {
  constructor(network = 'devnet', walletPath = null, privateKey = null, rpcUrl = null) {
    // Setup connection based on network
    if (network === 'mainnet') {
      const mainnetRpcUrl = rpcUrl || process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(mainnetRpcUrl, 'confirmed');
      console.log(`🌐 Connected to: mainnet-beta`);
      console.log(`🔗 RPC URL: ${mainnetRpcUrl}`);
    } else {
      this.connection = new Connection('https://api.devnet.solana.com', 'confirmed');
      console.log(`🌐 Connected to: devnet`);
    }
    
    this.network = network;
    this.loadWallet(walletPath, privateKey);
  }

  loadWallet(customWalletPath, privateKey) {
    // If private key is provided, use it directly
    if (privateKey) {
      try {
        let secretKey;
        
        // Handle different private key formats
        if (typeof privateKey === 'string') {
          if (privateKey.includes(',') || privateKey.includes('[')) {
            // Array format: "[1,2,3,...]" or "1,2,3,..."
            const cleanKey = privateKey.replace(/[\[\]]/g, '');
            secretKey = new Uint8Array(cleanKey.split(',').map(n => parseInt(n.trim())));
          } else {
            // Base58 format
            secretKey = bs58.decode(privateKey);
          }
        } else if (Array.isArray(privateKey)) {
          // Already an array
          secretKey = new Uint8Array(privateKey);
        } else {
          throw new Error('Invalid private key format');
        }
        
        this.payer = Keypair.fromSecretKey(secretKey);
        console.log(`🔑 Using wallet: ${this.payer.publicKey.toString()}`);
        console.log(`🔐 Source: Private key input`);
        return;
      } catch (error) {
        throw new Error(`Failed to load private key: ${error.message}`);
      }
    }

    // Try multiple wallet paths
    const possiblePaths = [
      customWalletPath,
      process.env.WALLET_PATH,
      process.env.MAINNET_WALLET_PATH,
      path.join(os.homedir(), '.config', 'solana', 'id.json'),
      path.join(os.homedir(), '.config', 'solana', 'phantom-super-admin-1.json'),
      path.join(os.homedir(), '.config', 'solana', 'mainnet-wallet.json')
    ].filter(Boolean);

    for (const walletPath of possiblePaths) {
      try {
        if (fs.existsSync(walletPath)) {
          const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
          this.payer = Keypair.fromSecretKey(new Uint8Array(walletData));
          console.log(`🔑 Using wallet: ${this.payer.publicKey.toString()}`);
          console.log(`📁 Wallet path: ${walletPath}`);
          return;
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error(`No valid wallet found. Tried paths: ${possiblePaths.join(', ')}`);
  }

  async createToken(tokenConfig) {
    try {
      console.log(`\n🪙 Creating token: ${tokenConfig.name} (${tokenConfig.symbol})`);
      
      // Check wallet balance
      const balance = await this.connection.getBalance(this.payer.publicKey);
      console.log(`💰 Wallet Balance: ${(balance / 1e9).toFixed(4)} SOL`);
      
      const requiredBalance = tokenConfig.createMetadata ? 0.02 * 1e9 : 0.01 * 1e9;
      const requiredSolText = tokenConfig.createMetadata ? '0.02 SOL for token creation with metadata' : '0.01 SOL for token creation';
      
      if (balance < requiredBalance) {
        throw new Error(`Insufficient SOL balance. Need at least ${requiredSolText}.`);
      }

      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;
      
      // Calculate space needed for mint (standard token program)
      const MINT_SIZE = 82; // Standard SPL token mint size
      const lamports = await this.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      
      console.log(`   📦 Mint address: ${mint.toString()}`);
      console.log(`   💎 Decimals: ${tokenConfig.decimals}`);
      console.log(`   🏭 Total supply: ${(tokenConfig.totalSupply / Math.pow(10, tokenConfig.decimals)).toLocaleString()}`);
      
      // Create mint account
      const createAccountInstruction = SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: mint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      });
      
      // Initialize mint
      const initializeMintInstruction = createInitializeMintInstruction(
        mint,
        tokenConfig.decimals,
        this.payer.publicKey, // mint authority (will be revoked after minting)
        null, // freeze authority (disabled)
        TOKEN_PROGRAM_ID
      );
      
      // Create metadata if specified
      let metadataInstruction = null;
      let metadataAddress = null;
      if (tokenConfig.createMetadata) {
        const metadataResult = await this.createMetadataInstruction(mint, tokenConfig);
        metadataInstruction = metadataResult.instruction;
        metadataAddress = metadataResult.metadataAddress;
        console.log(`   📋 Metadata address: ${metadataAddress.toString()}`);
      }
      
      // Create and send transaction
      const transaction = new Transaction().add(
        createAccountInstruction,
        initializeMintInstruction
      );
      
      // Add metadata instruction if created
      if (metadataInstruction) {
        transaction.add(metadataInstruction);
      }
      
      const signature = await this.connection.sendTransaction(
        transaction,
        [this.payer, mintKeypair],
        { commitment: 'confirmed' }
      );
      
      await this.connection.confirmTransaction(signature, 'confirmed');
      
      console.log(`   ✅ Token created successfully!`);
      if (metadataAddress) {
        console.log(`   ✅ Metadata created successfully!`);
      }
      console.log(`   📝 Creation signature: ${signature}`);
      
      // Mint initial supply if specified
      let tokenAccount = null;
      let mintSignature = null;
      
      if (tokenConfig.totalSupply > 0) {
        console.log(`   🏭 Minting initial supply...`);
        
        tokenAccount = await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.payer,
          mint,
          this.payer.publicKey,
          false,
          'confirmed',
          {},
          TOKEN_PROGRAM_ID
        );
        
        mintSignature = await mintTo(
          this.connection,
          this.payer,
          mint,
          tokenAccount.address,
          this.payer,
          tokenConfig.totalSupply,
          [],
          { commitment: 'confirmed' },
          TOKEN_PROGRAM_ID
        );
        
        console.log(`   ✅ Minted to: ${tokenAccount.address.toString()}`);
        console.log(`   📝 Mint signature: ${mintSignature}`);
      }
      
      // Revoke mint authority to make token immutable
      console.log(`   🔒 Revoking mint authority...`);
      const revokeMintAuthorityInstruction = createSetAuthorityInstruction(
        mint,
        this.payer.publicKey,
        AuthorityType.MintTokens,
        null, // Set authority to null (revoke)
        [],
        TOKEN_PROGRAM_ID
      );
      
      const revokeTransaction = new Transaction().add(revokeMintAuthorityInstruction);
      const revokeSignature = await this.connection.sendTransaction(
        revokeTransaction,
        [this.payer],
        { commitment: 'confirmed' }
      );
      
      await this.connection.confirmTransaction(revokeSignature, 'confirmed');
      console.log(`   ✅ Mint authority revoked successfully!`);
      console.log(`   📝 Revoke signature: ${revokeSignature}`);
      
      const result = {
        name: tokenConfig.name,
        symbol: tokenConfig.symbol,
        mint: mint.toString(),
        decimals: tokenConfig.decimals,
        totalSupply: tokenConfig.totalSupply,
        displaySupply: tokenConfig.totalSupply / Math.pow(10, tokenConfig.decimals),
        tokenAccount: tokenAccount ? tokenAccount.address.toString() : null,
        createSignature: signature,
        mintSignature: mintSignature,
        revokeSignature: revokeSignature,
        metadataAddress: metadataAddress ? metadataAddress.toString() : null,
        hasMetadata: !!tokenConfig.createMetadata,
        description: tokenConfig.description || null,
        imageUri: tokenConfig.imageUri || null,
        mintAuthorityRevoked: true,
        freezeAuthorityRevoked: true,
        network: this.network,
        createdAt: new Date().toISOString(),
        explorerUrl: this.network === 'mainnet' 
          ? `https://solscan.io/token/${mint.toString()}`
          : `https://solscan.io/token/${mint.toString()}?cluster=devnet`
      };
      
      // Disable mint authority by default unless explicitly kept
      if (!tokenConfig.keepMintAuthority) {
        console.log(`\n🔒 Disabling mint authority...`);
        await setAuthority(
          this.connection,
          this.payer,
          mint,
          this.payer.publicKey,
          AuthorityType.MintTokens,
          null,
          [],
          { commitment: 'confirmed' },
          TOKEN_PROGRAM_ID
        );
        console.log(`   ✅ Mint authority set to none`);
      } else {
        console.log(`\n⚠️  Keeping mint authority as requested (--keep-mint-authority).`);
      }

      return result;
      
    } catch (error) {
      console.error(`❌ Failed to create token:`, error.message);
      throw error;
    }
  }

  async createMetadataInstruction(mint, tokenConfig) {
    try {
      // Derive the metadata PDA
      const [metadataAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
      );

      // Prepare metadata
      const tokenMetadata = {
        name: tokenConfig.name,
        symbol: tokenConfig.symbol,
        uri: tokenConfig.imageUri || '', // Can be empty or point to JSON metadata
        sellerFeeBasisPoints: 0, // No royalties
        creators: null, // No creators array
        collection: null, // No collection
        uses: null, // No uses
      };

      // Create the instruction
      const instruction = createCreateMetadataAccountV3Instruction(
        {
          metadata: metadataAddress,
          mint: mint,
          mintAuthority: this.payer.publicKey,
          payer: this.payer.publicKey,
          updateAuthority: this.payer.publicKey,
        },
        {
          createMetadataAccountArgsV3: {
            data: tokenMetadata,
            isMutable: true,
            collectionDetails: null,
          },
        }
      );

      return {
        instruction,
        metadataAddress,
      };
    } catch (error) {
      console.error('Failed to create metadata instruction:', error);
      throw error;
    }
  }

  saveResult(result, outputPath = null) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = outputPath || `token-${result.symbol.toLowerCase()}-${timestamp}.json`;
      
      fs.writeFileSync(filename, JSON.stringify(result, null, 2));
      console.log(`\n💾 Token details saved to: ${filename}`);
      
      return filename;
    } catch (error) {
      console.warn('⚠️  Could not save result file:', error.message);
      return null;
    }
  }
}

function parseArguments() {
  const args = process.argv.slice(2);
  const config = {
    name: null,
    symbol: null,
    decimals: 9,
    totalSupply: 1000000000000000000, // 1 billion display tokens with 9 decimals (1B * 10^9)
    network: 'devnet',
    walletPath: null,
    privateKey: null,
    rpcUrl: null,
    output: null,
    createMetadata: false,
    description: null,
    imageUri: null,
    keepMintAuthority: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        config.name = args[i + 1];
        i++;
        break;
      case '--symbol':
        config.symbol = args[i + 1];
        i++;
        break;
      case '--decimals':
        config.decimals = parseInt(args[i + 1]);
        i++;
        break;
      case '--supply':
        // Parse supply in display units, convert to raw units
        const displaySupply = parseFloat(args[i + 1]);
        config.totalSupply = Math.floor(displaySupply * Math.pow(10, config.decimals));
        i++;
        break;
      case '--network':
        config.network = args[i + 1];
        i++;
        break;
      case '--wallet':
        config.walletPath = args[i + 1];
        i++;
        break;
      case '--private-key':
        config.privateKey = args[i + 1];
        i++;
        break;
      case '--rpc-url':
        config.rpcUrl = args[i + 1];
        i++;
        break;
      case '--output':
        config.output = args[i + 1];
        i++;
        break;
      case '--metadata':
        config.createMetadata = true;
        break;
      case '--description':
        config.description = args[i + 1];
        config.createMetadata = true; // Auto-enable metadata if description provided
        i++;
        break;
      case '--image':
        config.imageUri = args[i + 1];
        config.createMetadata = true; // Auto-enable metadata if image provided
        i++;
        break;
      case '--keep-mint-authority':
        config.keepMintAuthority = true;
        break;
      case '--help':
        showHelp();
        process.exit(0);
        break;
    }
  }

  return config;
}

function validateConfig(config) {
  const errors = [];

  if (!config.name) errors.push('Token name is required (--name)');
  if (!config.symbol) errors.push('Token symbol is required (--symbol)');
  
  if (config.decimals < 0 || config.decimals > 9) {
    errors.push('Decimals must be between 0 and 9');
  }
  
  if (config.totalSupply <= 0) {
    errors.push('Total supply must be greater than 0');
  }
  
  if (!['devnet', 'mainnet'].includes(config.network)) {
    errors.push('Network must be either "devnet" or "mainnet"');
  }

  if (config.symbol.length > 10) {
    errors.push('Symbol should be 10 characters or less');
  }

  return errors;
}

function showHelp() {
  console.log(`
🚀 Simple SPL Token Launcher

USAGE:
  node generate-token.js --name "Token Name" --symbol "SYMBOL" [options]

REQUIRED ARGUMENTS:
  --name <string>       Token name (e.g., "My Token")
  --symbol <string>     Token symbol (e.g., "MTK")

OPTIONAL ARGUMENTS:
  --decimals <number>   Token decimals (default: 9)
  --supply <number>     Initial token supply in display units (default: 1000000000)
  --network <string>    Network: devnet or mainnet (default: devnet)
  --wallet <path>       Path to wallet keypair file
  --private-key <key>   Private key (base58 or array format)
  --rpc-url <url>       Custom RPC URL
  --output <path>       Output file path for token details
  --keep-mint-authority Keep the mint authority (by default it is disabled)

METADATA ARGUMENTS:
  --metadata            Enable metadata creation (automatically enabled with --description or --image)
  --description <text>  Token description for metadata
  --image <uri>         Image URI for token logo (IPFS, Arweave, or HTTP URL)

EXAMPLES:
  # Basic token without metadata
  node generate-token.js --name "My Token" --symbol "MTK"

  # Token with metadata
  node generate-token.js --name "My Token" --symbol "MTK" --metadata --description "A sample token"

  # Token with complete metadata
  node generate-token.js --name "My Token" --symbol "MTK" \\
    --description "A sample token for testing" \\
    --image "https://example.com/logo.png"

  # Production token on mainnet
  node generate-token.js --name "Production Token" --symbol "PROD" \\
    --network mainnet --supply 1000000 \\
    --description "Production ready token" \\
    --image "https://example.com/logo.png"

NOTES:
  • Metadata makes tokens discoverable by wallets and dApps
  • Images should be publicly accessible URLs (IPFS recommended)
  • Mainnet requires real SOL for transaction fees
  • Minimum balance: 0.02 SOL (for metadata creation)
  • Mint and freeze authorities are automatically revoked for security
`);
}

async function main() {
  try {
    console.log('🚀 Simple SPL Token Launcher\n');

    const config = parseArguments();
    const errors = validateConfig(config);

    if (errors.length > 0) {
      console.error('❌ Configuration errors:');
      errors.forEach(error => console.error(`   ${error}`));
      console.log('\nUse --help for usage information.');
      process.exit(1);
    }

    // Show configuration
    console.log('📋 Token Configuration:');
    console.log(`   Name: ${config.name}`);
    console.log(`   Symbol: ${config.symbol}`);
    console.log(`   Decimals: ${config.decimals}`);
    console.log(`   Total Supply: ${(config.totalSupply / Math.pow(10, config.decimals)).toLocaleString()} ${config.symbol}`);
    console.log(`   Network: ${config.network}`);
    if (config.createMetadata) {
      console.log(`   📋 Metadata: Enabled`);
      if (config.description) console.log(`   📝 Description: ${config.description}`);
      if (config.imageUri) console.log(`   🖼️  Image URI: ${config.imageUri}`);
    } else {
      console.log(`   📋 Metadata: Disabled`);
    }

    // Create token
    const launcher = new SimpleTokenLauncher(config.network, config.walletPath, config.privateKey, config.rpcUrl);
    const result = await launcher.createToken(config);

    // Save results
    launcher.saveResult(result, config.output);

    // Display results
    console.log('\n🎉 Token Launch Successful!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📍 Contract Address (CA): ${result.mint}`);
    console.log(`🏷️  Token Name: ${result.name}`);
    console.log(`🎫 Symbol: ${result.symbol}`);
    console.log(`🌐 Network: ${result.network}`);
    console.log(`🔗 Explorer: ${result.explorerUrl}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (config.network === 'devnet') {
      console.log('\n💡 Next Steps:');
      console.log('• Token is ready for use on devnet');
      if (result.hasMetadata) {
        console.log('• Metadata is on-chain and discoverable by wallets and dApps');
      } else {
        console.log('• You can add metadata later with --metadata flag');
      }
      console.log('• You can create pools or distribute tokens');
      console.log('• For mainnet, re-run with --network mainnet');
    }

  } catch (error) {
    console.error('\n❌ Token launch failed:', error.message);
    process.exit(1);
  }
}

// Run the launcher if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { SimpleTokenLauncher };
