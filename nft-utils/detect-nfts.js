#!/usr/bin/env node

/**
 * NFT Detection Tool for Solana Wallets
 * Detects all NFTs in a given wallet address using multiple methods
 * 
 * Usage: node detect-nfts.js <wallet_address> [options]
 */

require('dotenv').config();
const {
  Connection,
  PublicKey,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

class NFTDetector {
  constructor(rpcUrl = null, heliusApiKey = null) {
    // Use Helius RPC URL if available, otherwise fallback to public RPC
    const defaultRpcUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl || defaultRpcUrl, 'confirmed');
    this.rpcUrl = rpcUrl || defaultRpcUrl;
    this.heliusApiKey = heliusApiKey;
    
    console.log(`🔗 Using RPC: ${this.rpcUrl}`);
    if (heliusApiKey) {
      console.log(`🔑 Helius API key provided for cNFT detection`);
    }
  }

  async detectNFTs(walletAddress, options = {}) {
    const {
      includeMetadata = true,
      includeCollectionInfo = false,
      verbose = false
    } = options;

    console.log(`🔍 Detecting NFTs in wallet: ${walletAddress}`);
    console.log('=' * 80);

    try {
      // Validate wallet address
      const walletPubkey = new PublicKey(walletAddress);
      
      // Check wallet basic info
      if (verbose) {
        try {
          const balance = await this.connection.getBalance(walletPubkey);
          console.log(`💰 Wallet SOL balance: ${(balance / 1e9).toFixed(6)} SOL`);
          
          const accountInfo = await this.connection.getAccountInfo(walletPubkey);
          console.log(`📊 Account exists: ${accountInfo !== null}`);
          if (accountInfo) {
            console.log(`📊 Account owner: ${accountInfo.owner.toString()}`);
            console.log(`📊 Account data length: ${accountInfo.data.length}`);
          }
        } catch (error) {
          console.log(`⚠️  Could not get wallet info: ${error.message}`);
        }
      }
      
      // Try multiple detection methods
      let nfts = [];
      let method = 'unknown';

      // Method 1: Helius DAS API (most comprehensive - required for cNFTs)
      console.log('📡 Using Helius DAS API (required for compressed NFTs)...');
      try {
        nfts = await this.detectNFTsWithHelius(walletAddress, includeMetadata);
        method = 'helius_das';
        console.log(`✅ Helius DAS API found ${nfts.length} NFTs`);
      } catch (error) {
        console.log(`⚠️  Helius DAS API failed: ${error.message}`);
        console.log(`   Note: Compressed NFTs (cNFTs) can only be detected via Helius DAS API`);
      }

      // Method 2: Token account scanning (fallback)
      if (nfts.length === 0) {
        console.log('📡 Using token account scanning...');
        try {
          nfts = await this.detectNFTsWithTokenAccounts(walletPubkey, includeMetadata, verbose);
          method = 'token_accounts';
          console.log(`✅ Token account scanning found ${nfts.length} NFTs`);
        } catch (error) {
          console.log(`⚠️  Token account scanning failed: ${error.message}`);
        }
      }

      // Method 2.5: Try with different commitment levels
      if (nfts.length === 0) {
        console.log('📡 Trying with different commitment levels...');
        try {
          const tokenAccountsFinalized = await this.connection.getTokenAccountsByOwner(
            walletPubkey,
            { programId: TOKEN_PROGRAM_ID },
            'finalized'
          );
          console.log(`   Finalized: ${tokenAccountsFinalized.value.length} accounts`);
          
          const tokenAccountsProcessed = await this.connection.getTokenAccountsByOwner(
            walletPubkey,
            { programId: TOKEN_PROGRAM_ID },
            'processed'
          );
          console.log(`   Processed: ${tokenAccountsProcessed.value.length} accounts`);
        } catch (error) {
          console.log(`⚠️  Commitment level test failed: ${error.message}`);
        }
      }

      // Method 3: getProgramAccounts (comprehensive but slower)
      if (nfts.length === 0) {
        console.log('📡 Using getProgramAccounts method...');
        try {
          nfts = await this.detectNFTsWithProgramAccounts(walletPubkey, includeMetadata, verbose);
          method = 'program_accounts';
          console.log(`✅ getProgramAccounts found ${nfts.length} NFTs`);
        } catch (error) {
          console.log(`⚠️  getProgramAccounts failed: ${error.message}`);
        }
      }

      // Add collection info if requested
      if (includeCollectionInfo && nfts.length > 0) {
        console.log('🏷️  Fetching collection information...');
        nfts = await this.addCollectionInfo(nfts);
      }

      return {
        success: true,
        wallet: walletAddress,
        nftCount: nfts.length,
        nfts: nfts,
        method: method,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error(`❌ Error detecting NFTs: ${error.message}`);
      return {
        success: false,
        wallet: walletAddress,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  isHeliusRPC() {
    return this.rpcUrl.includes('helius') || this.rpcUrl.includes('rpcpool.com');
  }

  async detectNFTsWithHelius(walletAddress, includeMetadata = true) {
    // Try multiple Helius endpoints for cNFT detection
    const heliusEndpoints = [
      'https://mainnet.helius-rpc.com',
      'https://rpc.helius.xyz', 
      'https://api.helius.xyz',
      // Public endpoints (may have rate limits)
      'https://rpc-proxy.helius.xyz',
      'https://solana-mainnet.rpc.extrnode.com'
    ];

    let apiKey = '';
    
    // Extract API key from RPC URL if available
    if (this.rpcUrl.includes('api-key=')) {
      apiKey = this.rpcUrl.split('api-key=')[1].split('&')[0];
    }

    // If no API key from RPC URL, try environment variable
    if (!apiKey && process.env.HELIUS_API_KEY) {
      apiKey = process.env.HELIUS_API_KEY;
    }
    
    // If no API key from environment, try constructor parameter
    if (!apiKey && this.heliusApiKey) {
      apiKey = this.heliusApiKey;
    }

    // Try with free tier if no API key
    if (!apiKey) {
      console.log('⚠️  No Helius API key found, trying with free tier (limited results)');
    }

    for (const baseUrl of heliusEndpoints) {
      try {
        const dasUrl = apiKey ? `${baseUrl}/?api-key=${apiKey}` : baseUrl;
        
        console.log(`   Trying ${baseUrl}...`);
        
        const response = await fetch(dasUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'nft-detection',
            method: 'getAssetsByOwner',
            params: {
              ownerAddress: walletAddress,
              page: 1,
              limit: 1000,
              displayOptions: {
                showFungible: false,
                showNativeBalance: false,
              },
            },
          }),
        });

        if (!response.ok) {
          console.log(`   ${baseUrl} returned ${response.status}, trying next...`);
          continue;
        }

        const data = await response.json();
        
        if (data.error) {
          console.log(`   ${baseUrl} error: ${data.error.message}, trying next...`);
          continue;
        }

        const assets = data.result?.items || [];
        console.log(`   ✅ ${baseUrl} found ${assets.length} assets`);
        
        return assets.map(asset => ({
          mint: asset.id,
          name: asset.content?.metadata?.name || 'Unknown',
          symbol: asset.content?.metadata?.symbol || '',
          image: asset.content?.files?.[0]?.uri || asset.content?.links?.image || null,
          description: asset.content?.metadata?.description || '',
          collection: asset.grouping?.find(g => g.group_key === 'collection')?.group_value || null,
          collectionName: asset.collection?.name || null,
          attributes: asset.content?.metadata?.attributes || [],
          creators: asset.creators || [],
          royalty: asset.royalty || null,
          burnt: asset.burnt || false,
          compressed: asset.compression?.compressed || false,
          supply: asset.supply?.print_current_supply || 1,
          decimals: 0,
          interface: asset.interface,
          tokenStandard: asset.interface === 'ProgrammableNFT' ? 'ProgrammableNonFungible' : (asset.interface === 'V1_NFT' ? 'NonFungible' : 'Unknown'),
          balance: 1,
          source: 'helius_das',
          endpoint: baseUrl
        }));
        
      } catch (error) {
        console.log(`   ${baseUrl} failed: ${error.message}, trying next...`);
        continue;
      }
    }
    
    throw new Error('All Helius endpoints failed');
  }

  async detectNFTsWithTokenAccounts(walletPubkey, includeMetadata = true, verbose = false) {
    // Get all token accounts for this wallet
    const tokenAccounts = await this.connection.getTokenAccountsByOwner(
      walletPubkey,
      { programId: TOKEN_PROGRAM_ID },
      'confirmed'
    );

    if (verbose) {
      console.log(`📊 Found ${tokenAccounts.value.length} token accounts`);
      
      // Debug: Show some account details
      if (tokenAccounts.value.length > 0) {
        console.log(`   First account: ${tokenAccounts.value[0].pubkey.toString()}`);
        console.log(`   Account data length: ${tokenAccounts.value[0].account.data.length}`);
      }
    }

    const nfts = [];
    let processed = 0;

    for (const account of tokenAccounts.value) {
      try {
        processed++;
        if (verbose && processed % 10 === 0) {
          console.log(`   Processing ${processed}/${tokenAccounts.value.length} accounts...`);
        }

        // Get balance info
        const balanceInfo = await this.connection.getTokenAccountBalance(account.pubkey);
        
        if (!balanceInfo.value) {
          if (verbose) console.log(`   ⚠️  No balance info for account ${account.pubkey.toString().slice(0, 8)}...`);
          continue;
        }

        const balance = balanceInfo.value.uiAmount || 0;
        const decimals = balanceInfo.value.decimals;
        const rawAmount = balanceInfo.value.amount;

        if (verbose) {
          console.log(`   Account ${account.pubkey.toString().slice(0, 8)}... - Balance: ${balance}, Decimals: ${decimals}, Raw: ${rawAmount}`);
        }

        // NFTs typically have balance of 1 and 0 decimals, but let's also check for raw amount = 1
        if ((balance === 1 && decimals === 0) || (rawAmount === "1" && decimals === 0)) {
          // Get mint address from account data
          let mintAddress = null;
          
          if (account.account.data.parsed) {
            mintAddress = account.account.data.parsed.info.mint;
          } else {
            // Decode from raw data
            const accountData = account.account.data;
            if (accountData.length >= 32) {
              const mintBytes = accountData.slice(0, 32);
              mintAddress = new PublicKey(mintBytes).toString();
            }
          }

          if (mintAddress) {
            const nft = {
              mint: mintAddress,
              tokenAccount: account.pubkey.toString(),
              balance: balance,
              decimals: decimals,
              source: 'token_accounts'
            };

            // Add metadata if requested
            if (includeMetadata) {
              try {
                const metadata = await this.getTokenMetadata(mintAddress);
                Object.assign(nft, metadata);
              } catch (error) {
                if (verbose) {
                  console.log(`   ⚠️  Could not fetch metadata for ${mintAddress.slice(0, 8)}...`);
                }
              }
            }

            nfts.push(nft);
          }
        }
      } catch (error) {
        if (verbose) {
          console.log(`   ❌ Error processing account: ${error.message}`);
        }
        continue;
      }
    }

    return nfts;
  }

  async detectNFTsWithProgramAccounts(walletPubkey, includeMetadata = true, verbose = false) {
    // Use getProgramAccounts to find all token accounts owned by the wallet
    const accounts = await this.connection.getProgramAccounts(
      TOKEN_PROGRAM_ID,
      {
        filters: [
          {
            dataSize: 165, // Token account data size
          },
          {
            memcmp: {
              offset: 32, // Owner field offset
              bytes: walletPubkey.toBase58(),
            },
          },
        ],
      }
    );

    if (verbose) {
      console.log(`📊 Found ${accounts.length} token accounts via getProgramAccounts`);
    }

    const nfts = [];
    let processed = 0;

    for (const account of accounts) {
      try {
        processed++;
        if (verbose && processed % 10 === 0) {
          console.log(`   Processing ${processed}/${accounts.length} accounts...`);
        }

        // Parse token account data
        const data = account.account.data;
        if (data.length < 64) continue;

        // Extract mint (first 32 bytes) and amount (bytes 64-72)
        const mintBytes = data.slice(0, 32);
        const amountBytes = data.slice(64, 72);
        
        const mintAddress = new PublicKey(mintBytes).toString();
        const amount = Buffer.from(amountBytes).readBigUInt64LE();

        if (verbose) {
          console.log(`   Account ${account.pubkey.toString().slice(0, 8)}... - Mint: ${mintAddress.slice(0, 8)}..., Amount: ${amount}`);
        }

        // Check if this looks like an NFT (amount = 1)
        if (amount === 1n) {
          // Get additional info from RPC to confirm decimals
          try {
            const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
            const mintData = mintInfo.value?.data?.parsed?.info;
            
            if (verbose) {
              console.log(`   Mint ${mintAddress.slice(0, 8)}... - Decimals: ${mintData?.decimals}, Supply: ${mintData?.supply}`);
            }
            
            if (mintData && mintData.decimals === 0) {
              const nft = {
                mint: mintAddress,
                tokenAccount: account.pubkey.toString(),
                balance: 1,
                decimals: 0,
                source: 'program_accounts'
              };

              // Add metadata if requested
              if (includeMetadata) {
                try {
                  const metadata = await this.getTokenMetadata(mintAddress);
                  Object.assign(nft, metadata);
                } catch (error) {
                  if (verbose) {
                    console.log(`   ⚠️  Could not fetch metadata for ${mintAddress.slice(0, 8)}...`);
                  }
                }
              }

              nfts.push(nft);
            }
          } catch (error) {
            if (verbose) {
              console.log(`   ❌ Error getting mint info for ${mintAddress.slice(0, 8)}...`);
            }
            continue;
          }
        }
      } catch (error) {
        if (verbose) {
          console.log(`   ❌ Error processing account: ${error.message}`);
        }
        continue;
      }
    }

    return nfts;
  }

  async getTokenMetadata(mintAddress) {
    try {
      // Try to get metadata from Metaplex
      const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      
      // Derive metadata PDA
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          TOKEN_METADATA_PROGRAM_ID.toBuffer(),
          new PublicKey(mintAddress).toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
      );

      const metadataAccount = await this.connection.getAccountInfo(metadataPDA);
      
      if (metadataAccount && metadataAccount.data) {
        // Parse metadata (simplified parsing)
        const metadata = this.parseMetadata(metadataAccount.data);
        return metadata;
      }
    } catch (error) {
      // Metadata not found or parsing failed
    }

    return {
      name: 'Unknown NFT',
      symbol: '',
      image: null,
      description: '',
      attributes: [],
      creators: []
    };
  }

  parseMetadata(data) {
    // Simplified metadata parsing
    // In a production environment, you'd want to use @metaplex-foundation/mpl-token-metadata
    try {
      let offset = 1; // Skip first byte (key)
      
      // Skip update authority (32 bytes)
      offset += 32;
      
      // Skip mint (32 bytes)
      offset += 32;
      
      // Read name length and name
      const nameLength = data.readUInt32LE(offset);
      offset += 4;
      const name = data.slice(offset, offset + nameLength).toString('utf8').replace(/\0/g, '');
      offset += nameLength;
      
      // Read symbol length and symbol
      const symbolLength = data.readUInt32LE(offset);
      offset += 4;
      const symbol = data.slice(offset, offset + symbolLength).toString('utf8').replace(/\0/g, '');
      offset += symbolLength;
      
      // Read URI length and URI
      const uriLength = data.readUInt32LE(offset);
      offset += 4;
      const uri = data.slice(offset, offset + uriLength).toString('utf8').replace(/\0/g, '');
      
      return {
        name: name || 'Unknown NFT',
        symbol: symbol || '',
        uri: uri || null,
        image: null, // Would need to fetch from URI
        description: '',
        attributes: [],
        creators: []
      };
    } catch (error) {
      return {
        name: 'Unknown NFT',
        symbol: '',
        image: null,
        description: '',
        attributes: [],
        creators: []
      };
    }
  }

  async addCollectionInfo(nfts) {
    // Group NFTs by collection and add collection stats
    const collections = {};
    
    for (const nft of nfts) {
      if (nft.collection) {
        if (!collections[nft.collection]) {
          collections[nft.collection] = {
            count: 0,
            name: nft.collectionName || 'Unknown Collection'
          };
        }
        collections[nft.collection].count++;
      }
    }

    // Add collection info to each NFT
    return nfts.map(nft => ({
      ...nft,
      collectionInfo: nft.collection ? collections[nft.collection] : null
    }));
  }

  displayResults(result) {
    console.log('\n' + '='.repeat(80));
    console.log('📋 NFT DETECTION RESULTS');
    console.log('='.repeat(80));
    
    if (!result.success) {
      console.log(`❌ Detection failed: ${result.error}`);
      return;
    }

    console.log(`🎨 NFTs Found: ${result.nftCount}`);
    console.log(`📍 Wallet: ${result.wallet}`);
    console.log(`🔧 Method: ${result.method}`);
    console.log(`⏰ Timestamp: ${result.timestamp}`);
    
    if (result.nfts.length > 0) {
      console.log('\n📝 NFT Details:');
      console.log('-'.repeat(80));
      
      result.nfts.forEach((nft, index) => {
        console.log(`${index + 1}. ${nft.name || 'Unknown NFT'}`);
        console.log(`   🏷️  Mint: ${nft.mint}`);
        if (nft.symbol) console.log(`   🎫 Symbol: ${nft.symbol}`);
        if (nft.collectionName) console.log(`   📚 Collection: ${nft.collectionName}`);
        if (nft.image) console.log(`   🖼️  Image: ${nft.image}`);
        if (nft.description) console.log(`   📄 Description: ${nft.description.slice(0, 100)}${nft.description.length > 100 ? '...' : ''}`);
        console.log(`   🔗 Explorer: https://solscan.io/token/${nft.mint}`);
        console.log();
      });

      // Collection summary
      const collections = {};
      result.nfts.forEach(nft => {
        if (nft.collectionName) {
          collections[nft.collectionName] = (collections[nft.collectionName] || 0) + 1;
        }
      });

      if (Object.keys(collections).length > 0) {
        console.log('📚 Collections Summary:');
        console.log('-'.repeat(40));
        Object.entries(collections).forEach(([name, count]) => {
          console.log(`   ${name}: ${count} NFTs`);
        });
        console.log();
      }
    }
  }

  saveResults(result, outputPath = null) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = outputPath || `nft-detection-${result.wallet.slice(0, 8)}-${timestamp}.json`;
      
      require('fs').writeFileSync(filename, JSON.stringify(result, null, 2));
      console.log(`💾 Results saved to: ${filename}`);
      
      return filename;
    } catch (error) {
      console.warn('⚠️  Could not save results file:', error.message);
      return null;
    }
  }
}

function parseArguments() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const config = {
    walletAddress: args[0],
    includeMetadata: true,
    includeCollectionInfo: false,
    verbose: false,
    rpcUrl: null,
    output: null,
    heliusApiKey: null
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--no-metadata':
        config.includeMetadata = false;
        break;
      case '--collection-info':
        config.includeCollectionInfo = true;
        break;
      case '--verbose':
        config.verbose = true;
        break;
      case '--rpc-url':
        config.rpcUrl = args[i + 1];
        i++;
        break;
      case '--output':
        config.output = args[i + 1];
        i++;
        break;
      case '--helius-key':
        config.heliusApiKey = args[i + 1];
        i++;
        break;
    }
  }

  return config;
}

function showHelp() {
  console.log(`
🔍 NFT Detection Tool for Solana Wallets

USAGE:
  node detect-nfts.js <wallet_address> [options]

ARGUMENTS:
  wallet_address        Solana wallet address to scan for NFTs

OPTIONS:
  --no-metadata         Skip fetching NFT metadata (faster)
  --collection-info     Include collection statistics
  --verbose             Show detailed processing information
  --rpc-url <url>       Custom RPC URL (defaults to HELIUS_RPC_URL env var)
  --helius-key <key>    Helius API key for cNFT detection (required for compressed NFTs)
  --output <path>       Save results to JSON file
  --help               Show this help message

EXAMPLES:
  # Basic NFT detection (limited - no cNFTs without API key)
  node detect-nfts.js Bjg8CdwzwVu2kAVAHhuZGgHeAE2TkBkdowrMjzZk4Jag

  # With Helius API key for compressed NFTs
  node detect-nfts.js Bjg8CdwzwVu2kAVAHhuZGgHeAE2TkBkdowrMjzZk4Jag --helius-key your_api_key

  # Verbose output with collection info
  node detect-nfts.js Bjg8CdwzwVu2kAVAHhuZGgHeAE2TkBkdowrMjzZk4Jag --verbose --collection-info --helius-key your_api_key

  # Save results to file
  node detect-nfts.js Bjg8CdwzwVu2kAVAHhuZGgHeAE2TkBkdowrMjzZk4Jag --output my-nfts.json --helius-key your_api_key

ENVIRONMENT VARIABLES:
  HELIUS_RPC_URL        Helius RPC URL with API key (recommended for best results)

NOTES:
  • Helius RPC provides the most comprehensive NFT detection
  • The tool tries multiple detection methods automatically
  • Results include mint addresses, metadata, and collection info
  • Large wallets may take some time to process completely
`);
}

async function main() {
  try {
    console.log('🔍 NFT Detection Tool for Solana Wallets\n');

    const config = parseArguments();

    // Validate wallet address
    try {
      new PublicKey(config.walletAddress);
    } catch (error) {
      console.error('❌ Invalid wallet address:', config.walletAddress);
      process.exit(1);
    }

    // Create detector and run detection
    const detector = new NFTDetector(config.rpcUrl, config.heliusApiKey);
    const result = await detector.detectNFTs(config.walletAddress, {
      includeMetadata: config.includeMetadata,
      includeCollectionInfo: config.includeCollectionInfo,
      verbose: config.verbose
    });

    // Display results
    detector.displayResults(result);

    // Save results if requested
    if (config.output) {
      detector.saveResults(result, config.output);
    }

    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.error('\n❌ NFT detection failed:', error.message);
    process.exit(1);
  }
}

// Run the detector if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { NFTDetector };
