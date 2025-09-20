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
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  ExtensionType,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
} = require('@solana/spl-token');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bs58 = require('bs58');

class SimpleTokenLauncher {
  constructor(network = 'devnet', walletPath = null, privateKey = null) {
    // Setup connection based on network
    if (network === 'mainnet') {
      const rpcUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
      this.connection = new Connection(rpcUrl, 'confirmed');
      console.log(`🌐 Connected to: mainnet-beta`);
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
      
      if (balance < 0.01 * 1e9) { // Less than 0.01 SOL
        throw new Error('Insufficient SOL balance. Need at least 0.01 SOL for token creation.');
      }

      const mintKeypair = Keypair.generate();
      const mint = mintKeypair.publicKey;
      
      // Calculate space needed for mint with metadata pointer
      const mintLen = getMintLen([ExtensionType.MetadataPointer]);
      const lamports = await this.connection.getMinimumBalanceForRentExemption(mintLen);
      
      console.log(`   📦 Mint address: ${mint.toString()}`);
      console.log(`   💎 Decimals: ${tokenConfig.decimals}`);
      console.log(`   🏭 Total supply: ${(tokenConfig.totalSupply / Math.pow(10, tokenConfig.decimals)).toLocaleString()}`);
      
      // Create mint account
      const createAccountInstruction = SystemProgram.createAccount({
        fromPubkey: this.payer.publicKey,
        newAccountPubkey: mint,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });
      
      // Initialize metadata pointer
      const initializeMetadataPointerInstruction = createInitializeMetadataPointerInstruction(
        mint,
        this.payer.publicKey,
        mint,
        TOKEN_2022_PROGRAM_ID
      );
      
      // Initialize mint
      const initializeMintInstruction = createInitializeMintInstruction(
        mint,
        tokenConfig.decimals,
        this.payer.publicKey, // mint authority
        null, // freeze authority
        TOKEN_2022_PROGRAM_ID
      );
      
      // Create and send transaction
      const transaction = new Transaction().add(
        createAccountInstruction,
        initializeMetadataPointerInstruction,
        initializeMintInstruction
      );
      
      const signature = await this.connection.sendTransaction(
        transaction,
        [this.payer, mintKeypair],
        { commitment: 'confirmed' }
      );
      
      await this.connection.confirmTransaction(signature, 'confirmed');
      
      console.log(`   ✅ Token created successfully!`);
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
          TOKEN_2022_PROGRAM_ID
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
          TOKEN_2022_PROGRAM_ID
        );
        
        console.log(`   ✅ Minted to: ${tokenAccount.address.toString()}`);
        console.log(`   📝 Mint signature: ${mintSignature}`);
      }
      
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
        network: this.network,
        createdAt: new Date().toISOString(),
        explorerUrl: this.network === 'mainnet' 
          ? `https://solscan.io/token/${mint.toString()}`
          : `https://solscan.io/token/${mint.toString()}?cluster=devnet`
      };
      
      return result;
      
    } catch (error) {
      console.error(`❌ Failed to create token:`, error.message);
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
    output: null
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
      case '--output':
        config.output = args[i + 1];
        i++;
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

    // Create token
    const launcher = new SimpleTokenLauncher(config.network, config.walletPath, config.privateKey);
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
      console.log('• You can create pools, add metadata, or distribute tokens');
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
