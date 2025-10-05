#!/usr/bin/env node

/**
 * NFT Transfer Tool for Solana Wallets
 * Transfers all NFTs (both regular and compressed) from source wallet to destination wallet
 * 
 * Usage: node transfer-nfts.js <source_private_key> <destination_public_key> [options]
 */

require('dotenv').config();
const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} = require('@solana/spl-token');
const { NFTDetector } = require('./detect-nfts');
const bs58 = require('bs58').default;
const {
  transferV1,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  findMetadataPda,
  findMasterEditionPda,
  getTransferV1InstructionDataSerializer
} = require('@metaplex-foundation/mpl-token-metadata');

class NFTTransfer {
  constructor(rpcUrl = null) {
    const defaultRpcUrl = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
    this.connection = new Connection(rpcUrl || defaultRpcUrl, 'confirmed');
    this.rpcUrl = rpcUrl || defaultRpcUrl;
    
    console.log(`🔗 Using RPC: ${this.rpcUrl}`);
  }

  async transferAllNFTs(sourcePrivateKey, destinationPublicKey, options = {}) {
    const {
      verbose = false,
      outputPath = null
    } = options;

    console.log('🚀 Starting NFT Transfer Process...');
    console.log('=' * 80);

    try {
      // Create keypairs - handle both base58 and base64 encoded private keys
      let sourceKeypair;
      try {
        // First try base64 (original format)
        sourceKeypair = Keypair.fromSecretKey(
          Buffer.from(sourcePrivateKey, 'base64')
        );
      } catch (base64Error) {
        try {
          // If base64 fails, try base58 format
          sourceKeypair = Keypair.fromSecretKey(
            bs58.decode(sourcePrivateKey)
          );
          console.log('🔄 Converted base58 private key to keypair');
        } catch (base58Error) {
          throw new Error(`Invalid private key format. Must be either base64 or base58 encoded. Base64 error: ${base64Error.message}, Base58 error: ${base58Error.message}`);
        }
      }
      const destinationPubkey = new PublicKey(destinationPublicKey);

      console.log(`📤 Source wallet: ${sourceKeypair.publicKey.toString()}`);
      console.log(`📥 Destination wallet: ${destinationPublicKey}`);

      // Detect all NFTs in source wallet
      console.log('\n🔍 Detecting NFTs in source wallet...');
      const detector = new NFTDetector(this.rpcUrl);
      const detectionResult = await detector.detectNFTs(sourceKeypair.publicKey.toString(), {
        includeMetadata: true,
        verbose: verbose
      });

      if (!detectionResult.success) {
        throw new Error(`NFT detection failed: ${detectionResult.error}`);
      }

      const nfts = detectionResult.nfts;
      console.log(`📦 Found ${nfts.length} NFTs to transfer`);

      if (nfts.length === 0) {
        return {
          success: true,
          message: 'No NFTs found to transfer',
          sourceWallet: sourceKeypair.publicKey.toString(),
          destinationWallet: destinationPublicKey,
          nftsFound: 0,
          transferred: 0,
          failed: 0,
          results: []
        };
      }

      // Log NFT details
      console.log('\n📋 NFTs to transfer:');
      nfts.forEach((nft, index) => {
        const type = nft.compressed ? 'compressed' : 'regular';
        console.log(`  ${index + 1}. ${nft.name || 'Unknown'} (${nft.mint.slice(0, 8)}...) - ${type}`);
      });

      // Transfer each NFT
      const results = [];
      let transferred = 0;
      let failed = 0;

      for (let i = 0; i < nfts.length; i++) {
        const nft = nfts[i];
        const isCompressed = nft.compressed;
        
        console.log(`\n🔄 Transferring ${i + 1}/${nfts.length}: ${nft.name || 'Unknown'} (${isCompressed ? 'compressed' : 'regular'})`);
        
        try {
          let txHash = null;
          
          if (isCompressed) {
            // Transfer compressed NFT
            txHash = await this.transferCompressedNFT(nft, sourceKeypair, destinationPubkey);
          } else {
            // Transfer regular NFT
            txHash = await this.transferRegularNFT(nft, sourceKeypair, destinationPubkey);
          }

          if (txHash) {
            transferred++;
            console.log(`✅ Successfully transferred: ${txHash.slice(0, 8)}...`);
            results.push({
              mint: nft.mint,
              name: nft.name || 'Unknown',
              compressed: isCompressed,
              success: true,
              txHash: txHash
            });
          } else {
            failed++;
            console.log(`❌ Failed to transfer NFT`);
            results.push({
              mint: nft.mint,
              name: nft.name || 'Unknown',
              compressed: isCompressed,
              success: false,
              error: 'Transfer returned null'
            });
          }

          // Small delay between transfers
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          failed++;
          console.log(`❌ Error transferring NFT: ${error.message}`);
          results.push({
            mint: nft.mint,
            name: nft.name || 'Unknown',
            compressed: isCompressed,
            success: false,
            error: error.message
          });
        }
      }

      const finalResult = {
        success: true,
        sourceWallet: sourceKeypair.publicKey.toString(),
        destinationWallet: destinationPublicKey,
        nftsFound: nfts.length,
        transferred: transferred,
        failed: failed,
        results: results,
        timestamp: new Date().toISOString()
      };

      console.log(`\n🎯 Transfer complete: ${transferred}/${nfts.length} NFTs transferred successfully`);
      
      if (outputPath) {
        this.saveResults(finalResult, outputPath);
      }

      return finalResult;

    } catch (error) {
      console.error(`❌ NFT transfer failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        sourceWallet: sourcePrivateKey.slice(0, 8) + '...',
        destinationWallet: destinationPublicKey
      };
    }
  }

  async transferRegularNFT(nft, sourceKeypair, destinationPubkey) {
    try {
      const mintPubkey = new PublicKey(nft.mint);
      
      // Get source token account
      const sourceTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        sourceKeypair.publicKey
      );

      // Check source token account state
      const sourceAccountInfo = await this.connection.getAccountInfo(sourceTokenAccount);
      console.log(`🔍 Source token account: ${sourceTokenAccount.toString()}`);
      console.log(`🔍 Source account exists: ${sourceAccountInfo !== null}`);
      
      if (sourceAccountInfo) {
        // Parse the token account data to check if it's frozen
        const accountData = sourceAccountInfo.data;
        if (accountData.length >= 165) {
          const state = accountData[108]; // Token account state is at offset 108
          console.log(`🔍 Source account state: ${state} (0=Uninitialized, 1=Initialized, 2=Frozen)`);
          if (state === 2) {
            console.log('⚠️  Source token account is frozen. Trying alternative transfer method...');
            return await this.transferNFTWithMetaplex(nft, sourceKeypair, destinationPubkey);
          }
        }
      }

      // Get or create destination token account
      const destinationTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        destinationPubkey
      );

      // Check if destination token account exists
      const destinationAccountInfo = await this.connection.getAccountInfo(destinationTokenAccount);
      
      const transaction = new Transaction();

      // Create destination token account if it doesn't exist
      if (!destinationAccountInfo) {
        const createATAInstruction = createAssociatedTokenAccountInstruction(
          sourceKeypair.publicKey, // payer
          destinationTokenAccount,
          destinationPubkey, // owner
          mintPubkey
        );
        transaction.add(createATAInstruction);
      }

      // Create transfer instruction
      const transferInstruction = createTransferInstruction(
        sourceTokenAccount,
        destinationTokenAccount,
        sourceKeypair.publicKey,
        1, // NFTs have amount of 1
        []
      );
      transaction.add(transferInstruction);

      // Send transaction
      const txHash = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [sourceKeypair],
        { commitment: 'confirmed' }
      );

      return txHash;

    } catch (error) {
      console.error(`Regular NFT transfer error: ${error.message}`);
      throw error;
    }
  }

  async transferNFTWithMetaplex(nft, sourceKeypair, destinationPubkey) {
    try {
      console.log('🔄 Attempting Metaplex UMI-based transfer for frozen NFT...');
      
      // Use UMI for proper Metaplex handling
      const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
      const { keypairIdentity, publicKey } = require('@metaplex-foundation/umi');
      const { transferV1 } = require('@metaplex-foundation/mpl-token-metadata');
      
      // Create UMI instance with required programs
      const umi = createUmi(this.rpcUrl);
      
      // Add required programs
      const { mplTokenMetadata } = require('@metaplex-foundation/mpl-token-metadata');
      umi.use(mplTokenMetadata());
      
      // Convert Solana keypair to UMI keypair
      const umiKeypair = {
        publicKey: publicKey(sourceKeypair.publicKey.toString()),
        secretKey: sourceKeypair.secretKey
      };
      umi.use(keypairIdentity(umiKeypair));
      
      // Convert addresses to UMI format
      const mintAddress = publicKey(nft.mint);
      const destinationAddress = publicKey(destinationPubkey.toString());
      
      // Get token accounts
      const sourceTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(nft.mint),
        sourceKeypair.publicKey
      );
      
      const destinationTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(nft.mint),
        destinationPubkey
      );
      
      // Check if destination token account exists, create if not
      const destinationAccountInfo = await this.connection.getAccountInfo(destinationTokenAccount);
      if (!destinationAccountInfo) {
        console.log('🔧 Creating destination token account...');
        const createATAInstruction = createAssociatedTokenAccountInstruction(
          sourceKeypair.publicKey, // payer
          destinationTokenAccount,
          destinationPubkey, // owner
          new PublicKey(nft.mint)
        );
        
        const createATATransaction = new Transaction().add(createATAInstruction);
        await sendAndConfirmTransaction(
          this.connection,
          createATATransaction,
          [sourceKeypair],
          { commitment: 'confirmed' }
        );
        console.log('✅ Destination token account created');
      }
      
      // Perform the transfer using UMI
      console.log('🚀 Executing UMI transfer...');
      
      try {
        // Check if we need to create token records first
        console.log('🔍 Checking NFT type...');
        
        // Use the tokenStandard from the NFT detection if available
        let tokenStandard = nft.tokenStandard || 'NonFungible';
        console.log('📋 Token standard from detection:', tokenStandard);
        
        // Try to fetch metadata to confirm
        const { fetchMetadata } = require('@metaplex-foundation/mpl-token-metadata');
        try {
          const metadata = await fetchMetadata(umi, mintAddress);
          console.log('📋 Metadata found, token standard:', metadata.tokenStandard);
          tokenStandard = metadata.tokenStandard;
        } catch (metadataError) {
          console.log('⚠️  Could not fetch metadata, using detected standard:', tokenStandard);
        }
        
        let result;
        const isProgrammable = tokenStandard === 'ProgrammableNonFungible';
        
        if (isProgrammable) {
          console.log('🔍 Detected Programmable NFT, handling token records...');
          
          // For programmable NFTs, we need to explicitly provide token records and edition
          const { findTokenRecordPda, findMasterEditionPda } = require('@metaplex-foundation/mpl-token-metadata');
          
          const sourceTokenPubkey = publicKey(sourceTokenAccount.toString());
          const destTokenPubkey = publicKey(destinationTokenAccount.toString());
          
          const [sourceTokenRecord] = findTokenRecordPda(umi, {
            mint: mintAddress,
            token: sourceTokenPubkey
          });
          
          const [destTokenRecord] = findTokenRecordPda(umi, {
            mint: mintAddress,
            token: destTokenPubkey
          });
          
          const [masterEdition] = findMasterEditionPda(umi, {
            mint: mintAddress
          });
          
          console.log('📝 Source token record:', sourceTokenRecord);
          console.log('📝 Dest token record:', destTokenRecord);
          console.log('📝 Master edition:', masterEdition);
          
          try {
            result = await transferV1(umi, {
              mint: mintAddress,
              authority: umiKeypair,
              tokenOwner: publicKey(sourceKeypair.publicKey.toString()),
              destinationOwner: destinationAddress,
              tokenStandard: 'ProgrammableNonFungible',
              token: sourceTokenPubkey,
              destinationToken: destTokenPubkey,
              tokenRecord: sourceTokenRecord,
              destinationTokenRecord: destTokenRecord,
              edition: masterEdition,
              transferArgs: {
                __kind: 'V1',
                amount: 1,
                authorizationData: null
              }
            }).sendAndConfirm(umi, { 
              confirm: { commitment: 'confirmed' },
              send: { skipPreflight: false }
            });
          } catch (pnftError) {
            console.log('⚠️  Programmable NFT transfer failed:', pnftError.message);
            throw pnftError;
          }
        } else {
          console.log('🔍 Treating as regular NonFungible NFT...');
          result = await transferV1(umi, {
            mint: mintAddress,
            authority: umiKeypair,
            tokenOwner: publicKey(sourceKeypair.publicKey.toString()),
            destinationOwner: destinationAddress,
            tokenStandard: 'NonFungible',
            transferArgs: {
              __kind: 'V1',
              amount: 1,
              authorizationData: null
            }
          }).sendAndConfirm(umi, { 
            confirm: { commitment: 'confirmed' },
            send: { skipPreflight: false }
          });
        }
        
        console.log('✅ Metaplex UMI transfer successful!');
        return result.signature;
        
      } catch (umiError) {
        // Check if it's just a confirmation timeout but transaction might have succeeded
        if (umiError.message.includes('expired') || umiError.message.includes('block height')) {
          console.log('⚠️  Transaction may have succeeded but confirmation timed out');
          console.log('🔍 Checking if NFT was actually transferred...');
          
          // Wait a bit and check if the NFT moved
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          const currentBalance = await this.connection.getTokenAccountBalance(sourceTokenAccount);
          if (currentBalance.value.uiAmount === 0) {
            console.log('✅ NFT transfer confirmed! (was successful despite timeout)');
            // Extract signature from error message if possible
            const signatureMatch = umiError.message.match(/Signature ([A-Za-z0-9]{87,88})/);
            return signatureMatch ? signatureMatch[1] : 'transfer_successful_but_signature_unknown';
          }
        }
        throw umiError;
      }
      
    } catch (error) {
      console.error(`Metaplex UMI transfer error: ${error.message}`);
      
      // Fallback to manual instruction building if UMI fails
      console.log('🔄 Falling back to manual instruction building...');
      return await this.transferNFTWithManualInstruction(nft, sourceKeypair, destinationPubkey);
    }
  }
  
  async transferNFTWithManualInstruction(nft, sourceKeypair, destinationPubkey) {
    try {
      console.log('🔧 Building manual Metaplex transfer instruction...');
      
      // For now, return an informative error
      throw new Error('Manual instruction building not yet implemented. The NFT appears to be frozen and requires specialized handling. Please try transferring it through Phantom wallet first to unfreeze it, then run this script again.');
      
    } catch (error) {
      console.error(`Manual transfer error: ${error.message}`);
      throw error;
    }
  }

  async transferCompressedNFT(nft, sourceKeypair, destinationPubkey) {
    try {
      // Get asset data and proof for compressed NFT
      const assetData = await this.getAssetData(nft.mint);
      const assetProof = await this.getAssetProof(nft.mint);

      if (!assetData || !assetProof) {
        throw new Error('Failed to get asset data or proof for compressed NFT');
      }

      // Extract compression data
      const compression = assetData.compression;
      if (!compression) {
        throw new Error('No compression data found for NFT');
      }

      const treeId = compression.tree;
      const leafId = compression.leaf_id;
      const dataHash = compression.data_hash;
      const creatorHash = compression.creator_hash;

      if (!treeId || leafId === undefined || !dataHash || !creatorHash) {
        throw new Error('Missing required compression data');
      }

      // Build compressed NFT transfer instruction using Metaplex Bubblegum
      const { createTransferInstruction: createBubblegumTransferInstruction } = await import('@metaplex-foundation/mpl-bubblegum');
      const { publicKey } = await import('@metaplex-foundation/umi');
      const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
      const { keypairIdentity } = await import('@metaplex-foundation/umi');

      // Create UMI instance
      const umi = createUmi(this.rpcUrl);
      
      // Convert Solana keypair to UMI keypair
      const umiKeypair = {
        publicKey: publicKey(sourceKeypair.publicKey.toString()),
        secretKey: sourceKeypair.secretKey
      };
      umi.use(keypairIdentity(umiKeypair));

      // Create transfer instruction
      const transferIx = createBubblegumTransferInstruction(umi, {
        treeOwner: publicKey(sourceKeypair.publicKey.toString()),
        leafOwner: publicKey(sourceKeypair.publicKey.toString()),
        leafDelegate: publicKey(sourceKeypair.publicKey.toString()),
        newLeafOwner: publicKey(destinationPubkey.toString()),
        merkleTree: publicKey(treeId),
        root: assetProof.root,
        dataHash: dataHash,
        creatorHash: creatorHash,
        nonce: leafId,
        index: leafId,
        proof: assetProof.proof.map(p => publicKey(p))
      });

      // Send transaction
      const result = await transferIx.sendAndConfirm(umi);
      return result.signature;

    } catch (error) {
      console.error(`Compressed NFT transfer error: ${error.message}`);
      
      // Fallback: Try using raw instruction building
      try {
        return await this.transferCompressedNFTRaw(nft, sourceKeypair, destinationPubkey);
      } catch (fallbackError) {
        console.error(`Compressed NFT fallback transfer error: ${fallbackError.message}`);
        throw new Error(`Both compressed NFT transfer methods failed: ${error.message} | ${fallbackError.message}`);
      }
    }
  }

  async transferCompressedNFTRaw(nft, sourceKeypair, destinationPubkey) {
    try {
      // Get asset data and proof
      const assetData = await this.getAssetData(nft.mint);
      const assetProof = await this.getAssetProof(nft.mint);

      if (!assetData || !assetProof) {
        throw new Error('Failed to get asset data or proof');
      }

      const compression = assetData.compression;
      const treeId = compression.tree;
      const leafId = compression.leaf_id;
      const dataHash = compression.data_hash;
      const creatorHash = compression.creator_hash;

      // Program IDs
      const BUBBLEGUM_PROGRAM_ID = new PublicKey('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
      const SPL_ACCOUNT_COMPRESSION_PROGRAM_ID = new PublicKey('cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK');
      const SPL_NOOP_PROGRAM_ID = new PublicKey('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

      const treePubkey = new PublicKey(treeId);

      // Build instruction data
      const instructionData = Buffer.alloc(1000); // Allocate enough space
      let offset = 0;

      // Transfer instruction discriminator (8 bytes)
      const discriminator = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
      discriminator.copy(instructionData, offset);
      offset += 8;

      // Helper function to decode base58 to bytes
      const base58ToBytes = (base58String) => {
        return bs58.decode(base58String);
      };

      // Add root (32 bytes)
      const rootBytes = base58ToBytes(assetProof.root);
      rootBytes.copy(instructionData, offset);
      offset += 32;

      // Add data_hash (32 bytes)
      const dataHashBytes = base58ToBytes(dataHash);
      dataHashBytes.copy(instructionData, offset);
      offset += 32;

      // Add creator_hash (32 bytes)
      const creatorHashBytes = base58ToBytes(creatorHash);
      creatorHashBytes.copy(instructionData, offset);
      offset += 32;

      // Add nonce (leaf_id as u64, 8 bytes)
      const nonceBuffer = Buffer.alloc(8);
      nonceBuffer.writeBigUInt64LE(BigInt(leafId), 0);
      nonceBuffer.copy(instructionData, offset);
      offset += 8;

      // Add index (leaf_id as u32, 4 bytes)
      const indexBuffer = Buffer.alloc(4);
      indexBuffer.writeUInt32LE(leafId, 0);
      indexBuffer.copy(instructionData, offset);
      offset += 4;

      // Trim instruction data to actual size
      const finalInstructionData = instructionData.slice(0, offset);

      // Build accounts array
      const accounts = [
        { pubkey: treePubkey, isSigner: false, isWritable: true }, // tree_authority
        { pubkey: sourceKeypair.publicKey, isSigner: true, isWritable: false }, // leaf_owner
        { pubkey: sourceKeypair.publicKey, isSigner: true, isWritable: false }, // leaf_delegate
        { pubkey: destinationPubkey, isSigner: false, isWritable: false }, // new_leaf_owner
        { pubkey: treePubkey, isSigner: false, isWritable: true }, // merkle_tree
        { pubkey: SPL_NOOP_PROGRAM_ID, isSigner: false, isWritable: false }, // log_wrapper
        { pubkey: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID, isSigner: false, isWritable: false }, // compression_program
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      ];

      // Add proof accounts
      for (const proofItem of assetProof.proof) {
        accounts.push({
          pubkey: new PublicKey(proofItem),
          isSigner: false,
          isWritable: false
        });
      }

      // Create transaction instruction
      const transferInstruction = {
        programId: BUBBLEGUM_PROGRAM_ID,
        keys: accounts,
        data: finalInstructionData
      };

      // Create and send transaction
      const transaction = new Transaction().add(transferInstruction);
      const txHash = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [sourceKeypair],
        { commitment: 'confirmed' }
      );

      return txHash;

    } catch (error) {
      console.error(`Raw compressed NFT transfer error: ${error.message}`);
      throw error;
    }
  }

  async getAssetData(assetId) {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'asset-data',
          method: 'getAsset',
          params: { id: assetId }
        })
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(`Asset data error: ${data.error.message}`);
      }

      return data.result;
    } catch (error) {
      console.error(`Failed to get asset data: ${error.message}`);
      return null;
    }
  }

  async getAssetProof(assetId) {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'asset-proof',
          method: 'getAssetProof',
          params: { id: assetId }
        })
      });

      const data = await response.json();
      if (data.error) {
        throw new Error(`Asset proof error: ${data.error.message}`);
      }

      return data.result;
    } catch (error) {
      console.error(`Failed to get asset proof: ${error.message}`);
      return null;
    }
  }

  saveResults(result, outputPath) {
    try {
      const fs = require('fs');
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`💾 Results saved to: ${outputPath}`);
    } catch (error) {
      console.warn('⚠️  Could not save results file:', error.message);
    }
  }
}

function parseArguments() {
  const args = process.argv.slice(2);
  
  if (args.length < 2 || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const config = {
    sourcePrivateKey: args[0],
    destinationPublicKey: args[1],
    verbose: false,
    rpcUrl: null,
    output: null
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
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
    }
  }

  return config;
}

function showHelp() {
  console.log(`
🚀 NFT Transfer Tool for Solana Wallets

USAGE:
  node transfer-nfts.js <source_private_key> <destination_public_key> [options]

ARGUMENTS:
  source_private_key      Private key of source wallet (base64 or base58 encoded)
  destination_public_key  Public key of destination wallet

OPTIONS:
  --verbose              Show detailed processing information
  --rpc-url <url>        Custom RPC URL (defaults to HELIUS_RPC_URL env var)
  --output <path>        Save results to JSON file
  --help                 Show this help message

EXAMPLES:
  # Transfer all NFTs
  node transfer-nfts.js <base64_private_key> <destination_pubkey>

  # Verbose output with results saved
  node transfer-nfts.js <base64_private_key> <destination_pubkey> --verbose --output results.json

ENVIRONMENT VARIABLES:
  HELIUS_RPC_URL        Helius RPC URL with API key (required for compressed NFTs)

NOTES:
  • Supports both regular and compressed NFTs
  • Requires Helius RPC for compressed NFT transfers
  • Creates associated token accounts automatically
  • Includes retry logic and error handling
`);
}

async function main() {
  try {
    console.log('🚀 NFT Transfer Tool for Solana Wallets\n');

    const config = parseArguments();

    // Validate destination public key
    try {
      new PublicKey(config.destinationPublicKey);
    } catch (error) {
      console.error('❌ Invalid destination public key:', config.destinationPublicKey);
      process.exit(1);
    }

    // Create transfer instance and run transfer
    const transfer = new NFTTransfer(config.rpcUrl);
    const result = await transfer.transferAllNFTs(
      config.sourcePrivateKey,
      config.destinationPublicKey,
      {
        verbose: config.verbose,
        outputPath: config.output
      }
    );

    // Display summary
    console.log('\n' + '='.repeat(80));
    console.log('📋 TRANSFER SUMMARY');
    console.log('='.repeat(80));
    console.log(`✅ Success: ${result.success}`);
    console.log(`📦 NFTs Found: ${result.nftsFound || 0}`);
    console.log(`✅ Transferred: ${result.transferred || 0}`);
    console.log(`❌ Failed: ${result.failed || 0}`);

    if (result.results && result.results.length > 0) {
      console.log('\n📝 Transfer Details:');
      result.results.forEach((r, i) => {
        const status = r.success ? '✅' : '❌';
        const type = r.compressed ? 'compressed' : 'regular';
        console.log(`  ${i + 1}. ${status} ${r.name} (${type})`);
        if (r.success && r.txHash) {
          console.log(`     TX: ${r.txHash}`);
        } else if (!r.success && r.error) {
          console.log(`     Error: ${r.error}`);
        }
      });
    }

    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);

  } catch (error) {
    console.error('\n❌ NFT transfer failed:', error.message);
    process.exit(1);
  }
}

// Run the transfer if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = { NFTTransfer };
