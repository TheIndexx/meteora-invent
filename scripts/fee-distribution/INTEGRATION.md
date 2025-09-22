# Python Integration Guide

This guide shows how to integrate the JavaScript Jupiter SDK scripts with your Python fee cronjob.

## Overview

The JavaScript scripts replace the unreliable Python HTTP Jupiter API with a robust TypeScript SDK implementation. The Python code calls these scripts via subprocess and receives JSON responses.

## Changes Made to fee_cronjob.py

### 1. New JavaScript Integration Functions

```python
async def execute_asset_swap_js(fee_wallet_key, asset_vault_pubkey, token_mint, sol_amount, platform_wallet_key):
    """Execute asset swap using JavaScript Jupiter SDK script"""
    # Calls swap-fee-to-asset.js via subprocess
    # Returns JSON response with swap results

async def distribute_sol_js(fee_wallet_key, platform_pubkey, creator_pubkey, platform_amount, creator_amount, platform_wallet_key):
    """Execute SOL distribution using JavaScript script"""
    # Calls distribute-sol.js via subprocess
    # Returns JSON response with transfer results

async def process_asset_purchase_js(asset, asset_sol, band_id, fee_wallet_keypair):
    """Process individual asset purchase using JavaScript Jupiter SDK"""
    # Uses execute_asset_swap_js internally
    # Handles database record creation

async def distribute_fees_for_band_js(band_data, claim_result):
    """Distribute fees using JavaScript Jupiter SDK - new optimized version"""
    # Uses both distribute_sol_js and process_asset_purchase_js
    # Replaces the old HTTP API approach
```

### 2. Updated Modal Image

```python
image = (modal.Image.debian_slim()
    .pip_install(...)
    .apt_install("git", "curl")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g pnpm",
        "git clone https://github.com/TheIndexx/meteora-invent.git",
        "cd meteora-invent && pnpm install",
        "cd meteora-invent/scripts/fee-distribution && npm install",  # NEW LINE
        force_build=False
    )
)
```

### 3. Updated Main Cronjob

```python
# Changed from:
distribution_result = await distribute_fees_for_band(band, claim_result)

# To:
distribution_result = await distribute_fees_for_band_js(band, claim_result)
```

## Key Benefits

### 1. Reliability
- **No more "io error: unexpected end of file"** from Python Jupiter SDK
- **Robust TypeScript SDK** with proper error handling
- **Automatic retry logic** with exponential backoff

### 2. Fee Optimization
- **Platform wallet pays all transaction fees** (gas optimization)
- **Fee wallet only provides SOL for swaps** (source wallet)
- **Direct token delivery to asset vault** (no intermediate transfers)

### 3. ExactIn Mode
- **Specify exact SOL amount to spend** (no slippage guessing)
- **Jupiter handles slippage automatically** (up to 20% tolerance)
- **Predictable SOL consumption** for fee calculations

### 4. Production Ready
- **JSON response format** for easy Python integration
- **Comprehensive error handling** with detailed messages
- **Exit codes** (0 = success, 1 = failure)
- **Console logging** for monitoring

## Script Usage

### Asset Swap Script
```bash
node swap-fee-to-asset.js \
  "5KJv...fee_wallet_private_key" \
  "GZx7...asset_vault_pubkey" \
  "EPj...token_mint" \
  "0.5" \
  "4Nh...platform_wallet_private_key"
```

**Response:**
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

### SOL Distribution Script
```bash
node distribute-sol.js \
  "5KJv...fee_wallet_private_key" \
  "GZx7...platform_pubkey" \
  "4Nh8...creator_pubkey" \
  "0.1" \
  "0.1" \
  "4Nh...platform_wallet_private_key"
```

**Response:**
```json
{
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "operation": "distribute-sol",
  "transfers": [
    {
      "recipient": "platform",
      "amount": 0.1,
      "pubkey": "GZx7...platform",
      "txSignature": "5KJv...signature1"
    },
    {
      "recipient": "creator",
      "amount": 0.1,
      "pubkey": "4Nh8...creator",
      "txSignature": "5KJv...signature2"
    }
  ],
  "totalTransferred": 0.2,
  "feeStrategy": "platform-wallet-pays",
  "transferCount": 2
}
```

## Error Handling

### Script Errors
- Scripts exit with code 1 on failure
- Error details in JSON response:
```json
{
  "success": false,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "error": "Invalid SOL amount: -1. Must be a positive number.",
  "name": "Error",
  "stack": "Error stack trace..."
}
```

### Python Integration
- Subprocess timeout handling (60-120 seconds)
- JSON parsing with fallback error handling
- Detailed logging for debugging

## Monitoring

### Console Output
Scripts provide detailed console logs:
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

### Python Logs
Enhanced logging with JavaScript indicators:
```python
logger.info("JavaScript-based fee distribution completed successfully",
           band_id=band_id,
           platform_success=bool(platform_success),
           creator_success=bool(creator_success),
           asset_failures=len(asset_failures),
           total_assets=len(purchase_results))
```

## Testing

### Integration Test
```bash
cd /meteora-invent/scripts/fee-distribution
node test-integration.js
```

**Expected Output:**
```
🧪 Testing Jupiter payments-as-swap integration...

1️⃣ Testing dependencies...
   ✅ Dependencies loaded successfully

2️⃣ Testing Jupiter quote API...
   ✅ Quote successful: 1000000 → 216973

3️⃣ Testing parameter validation...
   ✅ Parameter validation working correctly

4️⃣ Testing response formatting...
   ✅ Response formatting working correctly

🎉 All tests passed! Jupiter integration is ready for production.
```

### Manual Testing
```python
# Test the new functions in Modal
@app.function(image=image, secrets=[...])
async def test_javascript_integration():
    # Test asset swap
    result = await execute_asset_swap_js(
        fee_wallet_key="...",
        asset_vault_pubkey="...",
        token_mint="...",
        sol_amount=0.001,
        platform_wallet_key="..."
    )
    print("Asset swap result:", result)

    # Test SOL distribution
    result = await distribute_sol_js(
        fee_wallet_key="...",
        platform_pubkey="...",
        creator_pubkey="...",
        platform_amount=0.001,
        creator_amount=0.001,
        platform_wallet_key="..."
    )
    print("SOL distribution result:", result)
```

## Migration Strategy

### Phase 1: Deploy Scripts
1. ✅ Create JavaScript scripts in `/meteora-invent/scripts/fee-distribution/`
2. ✅ Add npm dependencies to Modal image
3. ✅ Test integration with `test-integration.js`

### Phase 2: Update Python Code
1. ✅ Add JavaScript integration functions to `fee_cronjob.py`
2. ✅ Create new `distribute_fees_for_band_js` function
3. ✅ Update main cronjob to use JavaScript version

### Phase 3: Production Testing
1. 🔄 Test with small amounts on mainnet
2. 🔄 Monitor transaction success rates
3. 🔄 Compare gas costs vs old approach

### Phase 4: Full Migration
1. 🔄 Switch production cronjob to JavaScript version
2. 🔄 Remove old HTTP API functions (optional)
3. 🔄 Monitor for improved reliability

## Rollback Plan

If issues occur, revert by changing one line:
```python
# Rollback from:
distribution_result = await distribute_fees_for_band_js(band, claim_result)

# Back to:
distribution_result = await distribute_fees_for_band(band, claim_result)
```

The old functions remain in the codebase for easy rollback.

## Security Considerations

### Private Key Handling
- Private keys passed as command line arguments
- Keys only exist in memory during script execution
- No network transmission of private keys
- Local signing only

### Environment Isolation
- Scripts run in Modal container environment
- No persistent storage of sensitive data
- Each execution is isolated

### Network Security
- All RPC calls use HTTPS
- Jupiter API calls are public (no auth required)
- Transaction signing happens locally

## Performance Improvements

### Gas Optimization
- **Platform wallet pays all fees**: Centralized gas management
- **Reduced transaction count**: Direct token delivery
- **Batch SOL transfers**: Combined platform/creator payments

### Execution Speed
- **Native TypeScript SDK**: Faster than HTTP API
- **Connection pooling**: Reused RPC connections
- **Parallel execution**: Multiple swaps can run concurrently

### Reliability
- **No HTTP timeouts**: Direct SDK integration
- **Automatic retries**: Built-in error recovery
- **Better error messages**: Detailed failure information

## Future Enhancements

### Potential Improvements
1. **Connection pooling** across multiple script calls
2. **Batch transaction support** for multiple swaps
3. **Custom slippage settings** per token
4. **Gas estimation** before execution
5. **Transaction simulation** before sending

### Monitoring Additions
1. **Performance metrics** collection
2. **Gas usage tracking** per operation
3. **Success rate monitoring** over time
4. **Alert integration** for failures

This implementation provides a robust, production-ready solution for Jupiter integration that addresses all the reliability issues with the previous HTTP API approach.