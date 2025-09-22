# Fee Distribution Scripts

Jupiter payments-as-swap implementation for reliable fee distribution using TypeScript SDK.

## Overview

These scripts replace the unreliable Python Jupiter HTTP API with a robust TypeScript SDK implementation using the "payments-as-swap" approach.

### Key Features

- **ExactIn Mode**: Specify exact SOL input amount to spend
- **Platform Wallet Fee Payment**: Platform wallet pays all transaction fees
- **Direct Token Delivery**: Tokens go straight to asset vault (no intermediate transfers)
- **No Slippage Management**: Let Jupiter handle slippage automatically
- **JSON Response Format**: Easy integration with Python subprocess calls

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Fee Wallet    │───▶│  Jupiter Swap    │───▶│  Asset Vault    │
│ (SOL Source)    │    │ (Platform Pays)  │    │ (Token Dest)    │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Scripts

### 1. swap-fee-to-asset.js

Main payment-as-swap script for token purchases.

**Usage:**
```bash
node swap-fee-to-asset.js <feeWalletKey> <assetVaultPubkey> <tokenMint> <solAmount> <platformWalletKey>
```

**Parameters:**
- `feeWalletKey`: Private key of fee wallet (base58 encoded)
- `assetVaultPubkey`: Public key of destination asset vault
- `tokenMint`: Token mint address to purchase
- `solAmount`: Exact SOL amount to spend (decimal number)
- `platformWalletKey`: Private key of platform wallet (fee payer)

**Example:**
```bash
node swap-fee-to-asset.js \
  "5KJv...wallet_key" \
  "GZx7...vault_pubkey" \
  "EPj...token_mint" \
  "0.5" \
  "4Nh...platform_key"
```

### 2. distribute-sol.js

SOL distribution script for platform and creator payments.

**Usage:**
```bash
node distribute-sol.js <feeWalletKey> <platformPubkey> <creatorPubkey> <platformAmount> <creatorAmount> <platformWalletKey>
```

**Parameters:**
- `feeWalletKey`: Private key of fee wallet (SOL source)
- `platformPubkey`: Public key of platform wallet
- `creatorPubkey`: Public key of creator wallet
- `platformAmount`: SOL amount for platform (decimal)
- `creatorAmount`: SOL amount for creator (decimal)
- `platformWalletKey`: Private key of platform wallet (fee payer)

**Example:**
```bash
node distribute-sol.js \
  "5KJv...wallet_key" \
  "GZx7...platform_pubkey" \
  "4Nh8...creator_pubkey" \
  "0.1" \
  "0.1" \
  "4Nh...platform_key"
```

## Installation

```bash
cd /meteora-invent/scripts/fee-distribution
npm install
```

## Dependencies

- `@jup-ag/api`: Jupiter TypeScript SDK
- `@solana/web3.js`: Solana JavaScript SDK
- `@solana/spl-token`: SPL Token utilities
- `bn.js`: Big number handling
- `bs58`: Base58 encoding/decoding

## Response Format

All scripts return JSON responses for Python integration:

### Success Response
```json
{
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "operation": "swap-fee-to-asset",
  "txSignature": "5KJv...signature",
  "inputAmount": "500000000",
  "outputAmount": "1000000",
  "solAmountSpent": 0.5,
  "tokenMint": "EPj...mint",
  "assetVaultPubkey": "GZx...vault",
  "feeStrategy": "platform-wallet-pays",
  "swapMode": "ExactIn"
}
```

### Error Response
```json
{
  "success": false,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "error": "Invalid SOL amount: -1. Must be a positive number.",
  "name": "Error",
  "stack": "Error stack trace..."
}
```

## Integration with Python

### Example Python Integration

```python
import subprocess
import json

def execute_asset_swap_js(fee_wallet_key, asset_vault_pubkey, token_mint, sol_amount, platform_wallet_key):
    """Execute asset swap using JavaScript script"""
    try:
        cmd = [
            "node",
            "/meteora-invent/scripts/fee-distribution/swap-fee-to-asset.js",
            fee_wallet_key,
            asset_vault_pubkey,
            token_mint,
            str(sol_amount),
            platform_wallet_key
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            cwd="/meteora-invent/scripts/fee-distribution"
        )

        if result.returncode != 0:
            raise Exception(f"Script failed: {result.stderr}")

        return json.loads(result.stdout)

    except Exception as e:
        return {"success": False, "error": str(e)}

def distribute_sol_js(fee_wallet_key, platform_pubkey, creator_pubkey, platform_amount, creator_amount, platform_wallet_key):
    """Execute SOL distribution using JavaScript script"""
    try:
        cmd = [
            "node",
            "/meteora-invent/scripts/fee-distribution/distribute-sol.js",
            fee_wallet_key,
            platform_pubkey,
            creator_pubkey,
            str(platform_amount),
            str(creator_amount),
            platform_wallet_key
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            cwd="/meteora-invent/scripts/fee-distribution"
        )

        if result.returncode != 0:
            raise Exception(f"Script failed: {result.stderr}")

        return json.loads(result.stdout)

    except Exception as e:
        return {"success": False, "error": str(e)}
```

## Error Handling

- Scripts exit with code 0 on success, 1 on failure
- All errors are captured and returned in JSON format
- Automatic retry with exponential backoff for network issues
- Comprehensive parameter validation
- Detailed error messages for debugging

## Environment Variables

- `SOLANA_RPC_URL`: Custom Solana RPC endpoint (defaults to mainnet)

## Security Considerations

- Private keys are passed as command line arguments (ensure secure execution environment)
- All transactions are signed locally
- No private keys are transmitted over network
- Platform wallet separation for fee payment security

## Monitoring

Scripts output detailed console logs for monitoring:
```
🚀 Starting Jupiter payments-as-swap...
  💰 Amount: 0.5 SOL
  🎯 Asset Vault: GZx7...vault
  🪙 Token: EPj...mint
  💳 Fee Payer: Platform Wallet
  📊 Mode: ExactIn
🔄 Starting Jupiter payments-as-swap...
  📊 Amount: 0.5 SOL
  🎯 Destination: GZx7...vault
  🔗 Token: EPj...mint
  📈 Quote: 500000000 lamports → 1000000 tokens
  ✅ Swap completed: 5KJv...signature
```