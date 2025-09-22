import { BN, Wallet } from '@coral-xyz/anchor';
import {
  BaseFee,
  BIN_STEP_BPS_DEFAULT,
  BIN_STEP_BPS_U128_DEFAULT,
  calculateTransferFeeIncludedAmount,
  CpAmm,
  getBaseFeeParams,
  getDynamicFeeParams,
  getLiquidityDeltaFromAmountA,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  getTokenProgram,
  getUnClaimReward,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  PoolFeesParams,
} from '@meteora-ag/cp-amm-sdk';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DammV2Config } from '../../utils/types';
import {
  getAmountInLamports,
  getDecimalizedAmount,
  getAmountInTokens,
  getQuoteDecimals,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
  getCurrentPoint,
} from '../../helpers';
import { promptForSelection } from '../../helpers/cli';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

/**
 * Create a one-sided DAMM V2 pool
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param baseTokenMint - The base token mint
 * @param quoteTokenMint - The quote token mint
 */
export async function createDammV2OneSidedPool(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  baseTokenMint: PublicKey,
  quoteTokenMint: PublicKey
) {
  if (!config.dammV2Config) {
    throw new Error('Missing DAMM V2 configuration');
  }
  console.log('\n> Initializing one-sided DAMM V2 pool...');

  if (!config.quoteMint) {
    throw new Error('Quote mint is required');
  }

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);

  let baseTokenInfo = null;
  let baseTokenProgram = TOKEN_PROGRAM_ID;

  const baseMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(baseTokenMint),
    connection.commitment
  );

  if (!baseMintAccountInfo) {
    throw new Error(`Base mint account not found: ${baseTokenMint}`);
  }

  const baseMint = unpackMint(baseTokenMint, baseMintAccountInfo, baseMintAccountInfo.owner);

  if (baseMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    baseTokenInfo = {
      mint: baseMint,
      currentEpoch: epochInfo.epoch,
    };
    baseTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  const baseDecimals = baseMint.decimals;

  const cpAmmInstance = new CpAmm(connection);

  const {
    initPrice,
    maxPrice,
    poolFees,
    baseAmount,
    quoteAmount,
    hasAlphaVault,
    activationPoint,
    activationType,
    collectFeeMode,
  } = config.dammV2Config;

  const {
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    totalDuration,
    numberOfPeriod,
    useDynamicFee,
  } = poolFees;

  let tokenAAmount = getAmountInLamports(baseAmount, baseDecimals);
  let tokenBAmount = new BN(0);

  // transfer fee if token2022
  if (baseTokenInfo) {
    tokenAAmount = tokenAAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenAAmount,
        baseTokenInfo.mint,
        baseTokenInfo.currentEpoch
      ).transferFee
    );
  }

  const maxSqrtPrice = maxPrice
    ? getSqrtPriceFromPrice(maxPrice.toString(), baseDecimals, quoteDecimals)
    : MAX_SQRT_PRICE;

  const initSqrtPrice = getSqrtPriceFromPrice(initPrice.toString(), baseDecimals, quoteDecimals);
  let minSqrtPrice = initSqrtPrice;

  const liquidityDelta = getLiquidityDeltaFromAmountA(tokenAAmount, initSqrtPrice, maxSqrtPrice);

  if (quoteAmount) {
    tokenBAmount = getAmountInLamports(quoteAmount, quoteDecimals);
    // L = Δb / (√P_upper - √P_lower)
    // √P_lower = √P_upper - Δb / L
    const numerator = tokenBAmount.shln(128).div(liquidityDelta);
    minSqrtPrice = initSqrtPrice.sub(numerator);
  }
  console.log(
    `- Using base token with amount = ${getDecimalizedAmount(tokenAAmount, baseDecimals)}`
  );

  console.log(`- Init price ${getPriceFromSqrtPrice(initSqrtPrice, baseDecimals, quoteDecimals)}`);

  console.log(
    `- Price range [${getPriceFromSqrtPrice(minSqrtPrice, baseDecimals, quoteDecimals)}, ${getPriceFromSqrtPrice(maxSqrtPrice, baseDecimals, quoteDecimals)}]`
  );

  let dynamicFee = null;
  if (useDynamicFee) {
    const dynamicFeeConfig = config.dammV2Config.poolFees.dynamicFeeConfig;
    if (dynamicFeeConfig) {
      dynamicFee = {
        binStep: BIN_STEP_BPS_DEFAULT,
        binStepU128: BIN_STEP_BPS_U128_DEFAULT,
        filterPeriod: dynamicFeeConfig.filterPeriod,
        decayPeriod: dynamicFeeConfig.decayPeriod,
        reductionFactor: dynamicFeeConfig.reductionFactor,
        variableFeeControl: dynamicFeeConfig.variableFeeControl,
        maxVolatilityAccumulator: dynamicFeeConfig.maxVolatilityAccumulator,
      };
    } else {
      dynamicFee = getDynamicFeeParams(config.dammV2Config.poolFees.minBaseFeeBps);
    }
  }

  const baseFee: BaseFee = getBaseFeeParams(
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    numberOfPeriod,
    totalDuration
  );

  const poolFeesParams: PoolFeesParams = {
    baseFee,
    padding: [],
    dynamicFee,
  };
  const positionNft = Keypair.generate();

  const {
    tx: initCustomizePoolTx,
    pool,
    position,
  } = await cpAmmInstance.createCustomPool({
    payer: wallet.publicKey,
    creator: new PublicKey(config.dammV2Config.creator),
    positionNft: positionNft.publicKey,
    tokenAMint: baseTokenMint,
    tokenBMint: quoteTokenMint,
    tokenAAmount: tokenAAmount,
    tokenBAmount: tokenBAmount,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    liquidityDelta: liquidityDelta,
    initSqrtPrice,
    poolFees: poolFeesParams,
    hasAlphaVault: hasAlphaVault,
    activationType,
    collectFeeMode: collectFeeMode,
    activationPoint: activationPoint ? new BN(activationPoint) : null,
    tokenAProgram: baseTokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });

  modifyComputeUnitPriceIx(initCustomizePoolTx, config.computeUnitPriceMicroLamports);

  console.log(`\n> Pool address: ${pool}`);
  console.log(`\n> Position address: ${position}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer, positionNft], wallet.publicKey, [
      initCustomizePoolTx,
    ]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initCustomizePoolTx,
      [wallet.payer, positionNft],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}

/**
 * Create a balanced DAMM V2 pool
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param baseTokenMint - The base token mint
 * @param quoteTokenMint - The quote token mint
 */
export async function createDammV2BalancedPool(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  baseTokenMint: PublicKey,
  quoteTokenMint: PublicKey
) {
  if (!config.dammV2Config) {
    throw new Error('Missing DAMM V2 configuration');
  }
  console.log('\n> Initializing balanced DAMM V2 pool...');

  if (!config.quoteMint) {
    throw new Error('Quote mint is required');
  }

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);

  let baseTokenInfo = null;
  let baseTokenProgram = TOKEN_PROGRAM_ID;

  const baseMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(baseTokenMint),
    connection.commitment
  );

  if (!baseMintAccountInfo) {
    throw new Error(`Base mint account not found: ${baseTokenMint}`);
  }

  const baseMint = unpackMint(baseTokenMint, baseMintAccountInfo, baseMintAccountInfo.owner);

  if (baseMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    baseTokenInfo = {
      mint: baseMint,
      currentEpoch: epochInfo.epoch,
    };
    baseTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  let quoteTokenInfo = null;
  let quoteTokenProgram = TOKEN_PROGRAM_ID;

  const quoteMintAccountInfo = await connection.getAccountInfo(
    new PublicKey(quoteTokenMint),
    connection.commitment
  );

  if (!quoteMintAccountInfo) {
    throw new Error(`Quote mint account not found: ${quoteTokenMint}`);
  }

  const quoteMint = unpackMint(quoteTokenMint, quoteMintAccountInfo, quoteMintAccountInfo.owner);

  if (quoteMintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const epochInfo = await connection.getEpochInfo();
    quoteTokenInfo = {
      mint: quoteMint,
      currentEpoch: epochInfo.epoch,
    };
    quoteTokenProgram = TOKEN_2022_PROGRAM_ID;
  }

  const baseDecimals = baseMint.decimals;

  // create cp amm instance
  const cpAmmInstance = new CpAmm(connection);
  const {
    baseAmount,
    quoteAmount,
    initPrice,
    poolFees,
    hasAlphaVault,
    activationPoint,
    activationType,
    collectFeeMode,
  } = config.dammV2Config;

  const {
    maxBaseFeeBps,
    minBaseFeeBps,
    numberOfPeriod,
    totalDuration,
    feeSchedulerMode,
    useDynamicFee,
  } = poolFees;

  if (!quoteAmount) {
    throw new Error('Quote amount is required for balanced pool');
  }

  let tokenAAmount = getAmountInLamports(baseAmount, baseDecimals);
  let tokenBAmount = getAmountInLamports(quoteAmount, quoteDecimals);

  if (baseTokenInfo) {
    tokenAAmount = tokenAAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenAAmount,
        baseTokenInfo.mint,
        baseTokenInfo.currentEpoch
      ).transferFee
    );
  }

  if (quoteTokenInfo) {
    tokenBAmount = tokenBAmount.sub(
      calculateTransferFeeIncludedAmount(
        tokenBAmount,
        quoteTokenInfo.mint,
        quoteTokenInfo.currentEpoch
      ).transferFee
    );
  }

  const initSqrtPrice = getSqrtPriceFromPrice(initPrice.toString(), baseDecimals, quoteDecimals);

  const minSqrtPrice = MIN_SQRT_PRICE;
  const maxSqrtPrice = MAX_SQRT_PRICE;

  const liquidityDelta = cpAmmInstance.getLiquidityDelta({
    maxAmountTokenA: tokenAAmount,
    maxAmountTokenB: tokenBAmount,
    sqrtPrice: initSqrtPrice,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    tokenAInfo: baseTokenInfo || undefined,
  });

  console.log(
    `- Using base token with amount = ${getDecimalizedAmount(tokenAAmount, baseDecimals)}`
  );
  console.log(
    `- Using quote token with amount = ${getDecimalizedAmount(tokenBAmount, quoteDecimals)}`
  );

  console.log(`- Init price ${getPriceFromSqrtPrice(initSqrtPrice, baseDecimals, quoteDecimals)}`);

  console.log(
    `- Price range [${getPriceFromSqrtPrice(minSqrtPrice, baseDecimals, quoteDecimals)}, ${getPriceFromSqrtPrice(maxSqrtPrice, baseDecimals, quoteDecimals)}]`
  );

  let dynamicFee = null;
  if (useDynamicFee) {
    const dynamicFeeConfig = config.dammV2Config.poolFees.dynamicFeeConfig;
    if (dynamicFeeConfig) {
      dynamicFee = {
        binStep: BIN_STEP_BPS_DEFAULT,
        binStepU128: BIN_STEP_BPS_U128_DEFAULT,
        filterPeriod: dynamicFeeConfig.filterPeriod,
        decayPeriod: dynamicFeeConfig.decayPeriod,
        reductionFactor: dynamicFeeConfig.reductionFactor,
        variableFeeControl: dynamicFeeConfig.variableFeeControl,
        maxVolatilityAccumulator: dynamicFeeConfig.maxVolatilityAccumulator,
      };
    } else {
      dynamicFee = getDynamicFeeParams(config.dammV2Config.poolFees.minBaseFeeBps);
    }
  }

  const baseFee: BaseFee = getBaseFeeParams(
    maxBaseFeeBps,
    minBaseFeeBps,
    feeSchedulerMode,
    numberOfPeriod,
    totalDuration
  );

  const poolFeesParams: PoolFeesParams = {
    baseFee,
    padding: [],
    dynamicFee,
  };

  const positionNft = Keypair.generate();

  const {
    tx: initCustomizePoolTx,
    pool,
    position,
  } = await cpAmmInstance.createCustomPool({
    payer: wallet.publicKey,
    creator: new PublicKey(config.dammV2Config.creator),
    positionNft: positionNft.publicKey,
    tokenAMint: baseTokenMint,
    tokenBMint: quoteTokenMint,
    tokenAAmount: tokenAAmount,
    tokenBAmount: tokenBAmount,
    sqrtMinPrice: minSqrtPrice,
    sqrtMaxPrice: maxSqrtPrice,
    liquidityDelta: liquidityDelta,
    initSqrtPrice,
    poolFees: poolFeesParams,
    hasAlphaVault: hasAlphaVault,
    activationType,
    collectFeeMode: collectFeeMode,
    activationPoint: activationPoint ? new BN(activationPoint) : null,
    tokenAProgram: baseTokenProgram,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });

  modifyComputeUnitPriceIx(initCustomizePoolTx, config.computeUnitPriceMicroLamports);

  console.log(`\n> Pool address: ${pool}`);
  console.log(`\n> Position address: ${position}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer, positionNft], wallet.publicKey, [
      initCustomizePoolTx,
    ]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initCustomizePoolTx,
      [wallet.payer, positionNft],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}

/**
 * Split position for DAMM V2
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param poolAddress - The pool address
 */
export async function splitPosition(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }

  if (!config.splitPosition) {
    throw new Error('Split position configuration is required');
  }

  console.log('\n> Splitting position...');

  const cpAmmInstance = new CpAmm(connection);

  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  if (userPositions.length === 0) {
    console.log('> No position found');
    return;
  }

  console.log(`\n> Pool address: ${poolAddress.toString()}`);
  console.log(`\n> Found ${userPositions.length} position(s) in this pool`);

  const positionDataArray = [];
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimReward = getUnClaimReward(poolState, positionState);
    positionDataArray.push({
      userPosition,
      positionState,
      unclaimReward,
      totalPositionFeeA: positionState.metrics.totalClaimedAFee.add(unclaimReward.feeTokenA),
      totalPositionFeeB: positionState.metrics.totalClaimedBFee.add(unclaimReward.feeTokenB),
    });
  }

  let selectedPositionData;

  if (userPositions.length === 1) {
    selectedPositionData = positionDataArray[0];
    console.log('> Only one position found, splitting that position...');
  } else {
    const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
    const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);

    if (!tokenAMintInfo || !tokenBMintInfo) {
      throw new Error('Failed to fetch token mint information');
    }
    const tokenAMint = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
    const tokenBMint = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

    const positionOptions = await Promise.all(
      positionDataArray.map(async (data, index) => {
        const { unclaimReward, totalPositionFeeA, totalPositionFeeB, positionState } = data;
        const positionAddress = data.userPosition.position.toString().slice(0, 8) + '...';

        // Calculate token amounts from liquidity using withdraw quote
        const withdrawQuote = await cpAmmInstance.getWithdrawQuote({
          liquidityDelta: positionState.unlockedLiquidity,
          sqrtPrice: poolState.sqrtPrice,
          minSqrtPrice: poolState.sqrtMinPrice,
          maxSqrtPrice: poolState.sqrtMaxPrice,
        });

        return [
          `Position ${index + 1} (${positionAddress})`,
          `  - Unlocked Liquidity: ${positionState.unlockedLiquidity.toString()}`,
          `  - Token A Amount: ${getAmountInTokens(withdrawQuote.outAmountA, tokenAMint.decimals)}`,
          `  - Token B Amount: ${getAmountInTokens(withdrawQuote.outAmountB, tokenBMint.decimals)}`,
          `  - Vested Liquidity: ${positionState.vestedLiquidity.toString()}`,
          `  - Permanent Locked Liquidity: ${positionState.permanentLockedLiquidity.toString()}`,
          `  - Unclaimed Fee A: ${getAmountInTokens(unclaimReward.feeTokenA, tokenAMint.decimals)}`,
          `  - Unclaimed Fee B: ${getAmountInTokens(unclaimReward.feeTokenB, tokenBMint.decimals)}`,
          `  - Total Position Fee A: ${getAmountInTokens(totalPositionFeeA, tokenAMint.decimals)}`,
          `  - Total Position Fee B: ${getAmountInTokens(totalPositionFeeB, tokenBMint.decimals)}`,
        ].join('\n');
      })
    );

    const selectedIndex = await promptForSelection(
      positionOptions,
      'Which position would you like to split from?'
    );

    selectedPositionData = positionDataArray[selectedIndex];
    console.log(`\n> Selected position ${selectedIndex + 1} for splitting...`);
  }

  if (!selectedPositionData) {
    throw new Error('No position selected');
  }

  const { userPosition, positionState, unclaimReward, totalPositionFeeA, totalPositionFeeB } =
    selectedPositionData;

  console.log('\n> Position Fee Information:');
  console.log(`- Position Address: ${userPosition.position.toString()}`);
  console.log(`- Total Claimed Fee A: ${positionState.metrics.totalClaimedAFee.toString()}`);
  console.log(`- Unclaimed Fee A: ${unclaimReward.feeTokenA.toString()}`);
  console.log(`- TOTAL POSITION FEE A: ${totalPositionFeeA.toString()}`);
  console.log(`- Total Claimed Fee B: ${positionState.metrics.totalClaimedBFee.toString()}`);
  console.log(`- Unclaimed Fee B: ${unclaimReward.feeTokenB.toString()}`);
  console.log(`- TOTAL POSITION FEE B: ${totalPositionFeeB.toString()}`);

  // CREATE THE SECOND POSITION FIRST
  const secondPositionKP = Keypair.generate();

  const createSecondPositionTx = await cpAmmInstance.createPosition({
    owner: new PublicKey(config.splitPosition.newPositionOwner),
    payer: wallet.publicKey,
    pool: poolAddress,
    positionNft: secondPositionKP.publicKey,
  });

  const createSignature = await sendAndConfirmTransaction(
    connection,
    createSecondPositionTx,
    [wallet.payer, secondPositionKP],
    {
      commitment: 'confirmed',
      skipPreflight: true,
    }
  );
  console.log('Second position created:', createSignature);

  // Now get the newly created second position
  const secondPositions = await cpAmmInstance.getUserPositionByPool(
    poolAddress,
    new PublicKey(config.splitPosition.newPositionOwner)
  );

  const secondPosition = secondPositions.find((pos) =>
    pos.positionState.nftMint.equals(secondPositionKP.publicKey)
  );

  if (!secondPosition) {
    throw new Error('Could not find the newly created second position');
  }

  const splitPositionTx = await cpAmmInstance.splitPosition({
    firstPositionOwner: wallet.publicKey,
    secondPositionOwner: new PublicKey(config.splitPosition.newPositionOwner),
    pool: poolAddress,
    firstPosition: userPosition.position,
    firstPositionNftAccount: userPosition.positionNftAccount,
    secondPosition: secondPosition.position,
    secondPositionNftAccount: secondPosition.positionNftAccount,
    unlockedLiquidityPercentage: config.splitPosition.unlockedLiquidityPercentage,
    permanentLockedLiquidityPercentage: config.splitPosition.permanentLockedLiquidityPercentage,
    feeAPercentage: config.splitPosition.feeAPercentage,
    feeBPercentage: config.splitPosition.feeBPercentage,
    reward0Percentage: config.splitPosition.reward0Percentage,
    reward1Percentage: config.splitPosition.reward1Percentage,
  });

  modifyComputeUnitPriceIx(splitPositionTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating split position transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [splitPositionTx]);
    console.log('> Split position simulation successful');
  } else {
    console.log(`\n>> Sending split position transaction...`);

    const claimFeeTxHash = await sendAndConfirmTransaction(
      connection,
      splitPositionTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to claim fee for position:`, err);
      throw err;
    });

    console.log(`>>> Position split successfully with tx hash: ${claimFeeTxHash}`);
  }
}

/**
 * Claim position fee for user positions (with interactive selection if multiple positions exist)
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param poolAddress - The pool address
 */
export async function claimPositionFee(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }

  console.log('\n> Claiming position fee...');

  const cpAmmInstance = new CpAmm(connection);

  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  if (userPositions.length === 0) {
    console.log('> No position found');
    return;
  }

  console.log(`\n> Pool address: ${poolAddress.toString()}`);
  console.log(`\n> Found ${userPositions.length} position(s) in this pool`);

  const positionDataArray = [];
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimReward = getUnClaimReward(poolState, positionState);
    positionDataArray.push({
      userPosition,
      positionState,
      unclaimReward,
      totalPositionFeeA: positionState.metrics.totalClaimedAFee.add(unclaimReward.feeTokenA),
      totalPositionFeeB: positionState.metrics.totalClaimedBFee.add(unclaimReward.feeTokenB),
    });
  }

  let selectedPositionData;

  if (userPositions.length === 1) {
    selectedPositionData = positionDataArray[0];
    console.log('> Only one position found, claiming fees from that position...');
  } else {
    const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
    const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);

    if (!tokenAMintInfo || !tokenBMintInfo) {
      throw new Error('Failed to fetch token mint information');
    }
    const tokenAMint = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
    const tokenBMint = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

    const positionOptions = positionDataArray.map((data, index) => {
      const { unclaimReward, totalPositionFeeA, totalPositionFeeB } = data;
      const positionAddress = data.userPosition.position.toString().slice(0, 8) + '...';

      return [
        `Position ${index + 1} (${positionAddress})`,
        `  - Unclaimed Fee A: ${getAmountInTokens(unclaimReward.feeTokenA, tokenAMint.decimals)}`,
        `  - Unclaimed Fee B: ${getAmountInTokens(unclaimReward.feeTokenB, tokenBMint.decimals)}`,
        `  - Total Position Fee A: ${getAmountInTokens(totalPositionFeeA, tokenAMint.decimals)}`,
        `  - Total Position Fee B: ${getAmountInTokens(totalPositionFeeB, tokenBMint.decimals)}`,
      ].join('\n');
    });

    const selectedIndex = await promptForSelection(
      positionOptions,
      'Which position would you like to claim fees from?'
    );

    selectedPositionData = positionDataArray[selectedIndex];
    console.log(`\n> Selected position ${selectedIndex + 1} for fee claiming...`);
  }

  if (!selectedPositionData) {
    throw new Error('No position selected');
  }
  const { userPosition, positionState, unclaimReward, totalPositionFeeA, totalPositionFeeB } =
    selectedPositionData;

  console.log('\n> Position Fee Information:');
  console.log(`- Position Address: ${userPosition.position.toString()}`);
  console.log(`- Total Claimed Fee A: ${positionState.metrics.totalClaimedAFee.toString()}`);
  console.log(`- Unclaimed Fee A: ${unclaimReward.feeTokenA.toString()}`);
  console.log(`- TOTAL POSITION FEE A: ${totalPositionFeeA.toString()}`);
  console.log(`- Total Claimed Fee B: ${positionState.metrics.totalClaimedBFee.toString()}`);
  console.log(`- Unclaimed Fee B: ${unclaimReward.feeTokenB.toString()}`);
  console.log(`- TOTAL POSITION FEE B: ${totalPositionFeeB.toString()}`);

  const claimPositionFeeTx = await cpAmmInstance.claimPositionFee({
    owner: wallet.publicKey,
    pool: poolAddress,
    position: userPosition.position,
    positionNftAccount: userPosition.positionNftAccount,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
  });

  modifyComputeUnitPriceIx(claimPositionFeeTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating claim position fee transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      claimPositionFeeTx,
    ]);
    console.log('> Claim position fee simulation successful');
  } else {
    console.log(`\n>> Sending claim position fee transaction...`);

    const claimFeeTxHash = await sendAndConfirmTransaction(
      connection,
      claimPositionFeeTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to claim fee for position:`, err);
      throw err;
    });

    console.log(`>>> Position fee claimed successfully with tx hash: ${claimFeeTxHash}`);
  }
}

/**
 * Add liquidity to a position
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param poolAddress - The pool address
 */
export async function addLiquidity(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }

  if (!config.addLiquidity) {
    throw new Error('Add liquidity config is required');
  }

  console.log('\n> Adding liquidity...');

  const cpAmmInstance = new CpAmm(connection);

  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  if (userPositions.length === 0) {
    console.log('> No position found');
    return;
  }

  console.log(`\n> Pool address: ${poolAddress.toString()}`);
  console.log(`\n> Found ${userPositions.length} position(s) in this pool`);

  const positionDataArray = [];
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimReward = getUnClaimReward(poolState, positionState);
    positionDataArray.push({
      userPosition,
      positionState,
      unclaimReward,
    });
  }

  let selectedPositionData;

  if (userPositions.length === 1) {
    selectedPositionData = positionDataArray[0];
    console.log('> Only one position found, adding liquidity to that position...');
  } else {
    const positionOptions = positionDataArray.map((data, index) => {
      const { positionState } = data;
      const positionAddress = data.userPosition.position.toString().slice(0, 8) + '...';

      return [
        `Position ${index + 1} (${positionAddress})`,
        `  - Unlocked Liquidity: ${positionState.unlockedLiquidity.toString()}`,
        `  - Vested Liquidity: ${positionState.vestedLiquidity.toString()}`,
        `  - Permanent Locked Liquidity: ${positionState.permanentLockedLiquidity.toString()}`,
        `  - Unclaimed Fee A: ${data.unclaimReward.feeTokenA.toString()}`,
        `  - Unclaimed Fee B: ${data.unclaimReward.feeTokenB.toString()}`,
      ].join('\n');
    });

    const selectedIndex = await promptForSelection(
      positionOptions,
      'Which position would you like to add liquidity to?'
    );

    selectedPositionData = positionDataArray[selectedIndex];
    console.log(`\n> Selected position ${selectedIndex + 1} for adding liquidity...`);
  }

  if (!selectedPositionData) {
    throw new Error('No position selected');
  }
  const { userPosition } = selectedPositionData;

  const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
  const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);

  if (!tokenAMintInfo || !tokenBMintInfo) {
    throw new Error('Failed to fetch token mint information');
  }

  const tokenAMintData = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
  const tokenBMintData = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

  const amountIn = getAmountInLamports(
    config.addLiquidity.amountIn,
    config.addLiquidity.isTokenA ? tokenAMintData.decimals : tokenBMintData.decimals
  );

  console.log(`\n> Adding liquidity configuration:`);
  console.log(
    `- Amount In: ${config.addLiquidity.amountIn} ${config.addLiquidity.isTokenA ? 'Token A' : 'Token B'}`
  );
  console.log(`- Amount In (raw): ${amountIn.toString()}`);

  const depositQuote = await cpAmmInstance.getDepositQuote({
    inAmount: amountIn,
    isTokenA: config.addLiquidity.isTokenA,
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
    sqrtPrice: poolState.sqrtPrice,
  });

  console.log(`\n> Deposit quote:`);
  console.log(`- Liquidity Delta: ${depositQuote.liquidityDelta.toString()}`);
  console.log(
    `- Output Amount: ${getAmountInTokens(depositQuote.outputAmount, tokenBMintData.decimals)}`
  );

  const maxAmountTokenA = config.addLiquidity.isTokenA ? amountIn : depositQuote.outputAmount;
  const maxAmountTokenB = config.addLiquidity.isTokenA ? depositQuote.outputAmount : amountIn;

  const tokenAAmountThreshold = config.addLiquidity.isTokenA ? amountIn : depositQuote.outputAmount;
  const tokenBAmountThreshold = config.addLiquidity.isTokenA ? depositQuote.outputAmount : amountIn;

  console.log(`\n> Slippage protection:`);
  console.log(`- Max Token A: ${getAmountInTokens(maxAmountTokenA, tokenAMintData.decimals)}`);
  console.log(`- Max Token B: ${getAmountInTokens(maxAmountTokenB, tokenBMintData.decimals)}`);
  console.log(
    `- Min Token A: ${getAmountInTokens(tokenAAmountThreshold, tokenAMintData.decimals)}`
  );
  console.log(
    `- Min Token B: ${getAmountInTokens(tokenBAmountThreshold, tokenBMintData.decimals)}`
  );

  console.log(`\n> Adding ${depositQuote.liquidityDelta.toString()} liquidity units...`);

  const addLiquidityTx = await cpAmmInstance.addLiquidity({
    owner: wallet.publicKey,
    pool: poolAddress,
    position: userPosition.position,
    positionNftAccount: userPosition.positionNftAccount,
    liquidityDelta: depositQuote.liquidityDelta,
    maxAmountTokenA,
    maxAmountTokenB,
    tokenAAmountThreshold,
    tokenBAmountThreshold,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
  });

  modifyComputeUnitPriceIx(addLiquidityTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating add liquidity transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [addLiquidityTx]);
    console.log('> Add liquidity simulation successful');
  } else {
    console.log(`\n>> Sending add liquidity transaction...`);

    const addLiquidityTxHash = await sendAndConfirmTransaction(
      connection,
      addLiquidityTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to add liquidity:`, err);
      throw err;
    });

    console.log(`>>> Liquidity added successfully with tx hash: ${addLiquidityTxHash}`);

    await connection.confirmTransaction(addLiquidityTxHash, 'finalized');
  }

  // Show updated position state
  const updatedPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);
  console.log(`\n> Updated position state after adding liquidity:`);
  console.log(`- Unlocked liquidity: ${updatedPositionState.unlockedLiquidity.toString()}`);
  console.log(`- Vested liquidity: ${updatedPositionState.vestedLiquidity.toString()}`);
  console.log(
    `- Permanent locked liquidity: ${updatedPositionState.permanentLockedLiquidity.toString()}`
  );
}

/**
 * Remove liquidity from a position
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param poolAddress - The pool address
 */
export async function removeLiquidity(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!config.dammV2Config) {
    throw new Error('Missing DAMM V2 configuration');
  }
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }

  console.log('\n> Removing liquidity...');

  const cpAmmInstance = new CpAmm(connection);

  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  if (userPositions.length === 0) {
    console.log('> No position found');
    return;
  }

  console.log(`\n> Pool address: ${poolAddress.toString()}`);
  console.log(`\n> Found ${userPositions.length} position(s) in this pool`);

  const positionDataArray = [];
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimReward = getUnClaimReward(poolState, positionState);
    positionDataArray.push({
      userPosition,
      positionState,
      unclaimReward,
      totalPositionFeeA: positionState.metrics.totalClaimedAFee.add(unclaimReward.feeTokenA),
      totalPositionFeeB: positionState.metrics.totalClaimedBFee.add(unclaimReward.feeTokenB),
    });
  }

  let selectedPositionData;

  if (userPositions.length === 1) {
    selectedPositionData = positionDataArray[0];
    console.log('> Only one position found, removing liquidity from that position...');
  } else {
    const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
    const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);

    if (!tokenAMintInfo || !tokenBMintInfo) {
      throw new Error('Failed to fetch token mint information');
    }
    const tokenAMint = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
    const tokenBMint = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

    const positionOptions = await Promise.all(
      positionDataArray.map(async (data, index) => {
        const { positionState } = data;
        const positionAddress = data.userPosition.position.toString().slice(0, 8) + '...';

        const withdrawQuote = await cpAmmInstance.getWithdrawQuote({
          liquidityDelta: positionState.unlockedLiquidity,
          sqrtPrice: poolState.sqrtPrice,
          minSqrtPrice: poolState.sqrtMinPrice,
          maxSqrtPrice: poolState.sqrtMaxPrice,
        });

        return [
          `Position ${index + 1} (${positionAddress})`,
          `  - Unlocked Liquidity: ${positionState.unlockedLiquidity.toString()}`,
          `  - Token A Amount: ${getAmountInTokens(withdrawQuote.outAmountA, tokenAMint.decimals)}`,
          `  - Token B Amount: ${getAmountInTokens(withdrawQuote.outAmountB, tokenBMint.decimals)}`,
          `  - Vested Liquidity: ${positionState.vestedLiquidity.toString()}`,
          `  - Permanent Locked Liquidity: ${positionState.permanentLockedLiquidity.toString()}`,
        ].join('\n');
      })
    );

    const selectedIndex = await promptForSelection(
      positionOptions,
      'Which position would you like to remove liquidity from?'
    );

    selectedPositionData = positionDataArray[selectedIndex];
    console.log(`\n> Selected position ${selectedIndex + 1} for removing liquidity...`);
  }

  if (!selectedPositionData) {
    throw new Error('No position selected');
  }
  const { userPosition, positionState, unclaimReward, totalPositionFeeA, totalPositionFeeB } =
    selectedPositionData;

  console.log('\n> Position Fee Information:');
  console.log(`- Position Address: ${userPosition.position.toString()}`);
  console.log(`- Total Claimed Fee A: ${positionState.metrics.totalClaimedAFee.toString()}`);
  console.log(`- Unclaimed Fee A: ${unclaimReward.feeTokenA.toString()}`);
  console.log(`- TOTAL POSITION FEE A: ${totalPositionFeeA.toString()}`);
  console.log(`- Total Claimed Fee B: ${positionState.metrics.totalClaimedBFee.toString()}`);
  console.log(`- Unclaimed Fee B: ${unclaimReward.feeTokenB.toString()}`);
  console.log(`- TOTAL POSITION FEE B: ${totalPositionFeeB.toString()}`);

  const tokenAMintInfo = await connection.getAccountInfo(poolState.tokenAMint);
  const tokenBMintInfo = await connection.getAccountInfo(poolState.tokenBMint);

  if (!tokenAMintInfo || !tokenBMintInfo) {
    throw new Error('Failed to fetch token mint information');
  }

  const tokenAMintData = unpackMint(poolState.tokenAMint, tokenAMintInfo, tokenAMintInfo.owner);
  const tokenBMintData = unpackMint(poolState.tokenBMint, tokenBMintInfo, tokenBMintInfo.owner);

  const currentPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);

  console.log(`\n> Current position liquidity:`);
  console.log(`- Unlocked liquidity: ${currentPositionState.unlockedLiquidity.toString()}`);
  console.log(`- Vested liquidity: ${currentPositionState.vestedLiquidity.toString()}`);
  console.log(
    `- Permanent locked liquidity: ${currentPositionState.permanentLockedLiquidity.toString()}`
  );

  const vestings = await cpAmmInstance.getAllVestingsByPosition(userPosition.position);
  console.log(`\n> Found ${vestings.length} vesting account(s) for this position`);

  // total liquidity to remove (unlocked + vested)
  const finalPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);
  const totalRemovableLiquidity = finalPositionState.unlockedLiquidity.add(
    finalPositionState.vestedLiquidity
  );
  const liquidityToRemove = totalRemovableLiquidity;

  if (liquidityToRemove.isZero()) {
    console.log('> No removable liquidity to remove');
    return;
  }

  console.log(`\n> Total removable liquidity: ${liquidityToRemove.toString()}`);
  console.log(`  - Unlocked: ${finalPositionState.unlockedLiquidity.toString()}`);
  console.log(
    `  - Vested (will be unlocked by SDK): ${finalPositionState.vestedLiquidity.toString()}`
  );

  console.log(`\n> Removing ${liquidityToRemove.toString()} liquidity units...`);

  const withdrawQuote = await cpAmmInstance.getWithdrawQuote({
    liquidityDelta: liquidityToRemove,
    sqrtPrice: poolState.sqrtPrice,
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
  });

  console.log(`\n> Withdraw quote:`);
  console.log(
    `- Expected token A amount: ${getAmountInTokens(withdrawQuote.outAmountA, tokenAMintData.decimals)}`
  );
  console.log(
    `- Expected token B amount: ${getAmountInTokens(withdrawQuote.outAmountB, tokenBMintData.decimals)}`
  );

  const currentPoint = await getCurrentPoint(connection, config.dammV2Config.activationType);

  const removeLiquidityTx = await cpAmmInstance.removeLiquidity({
    owner: wallet.publicKey,
    position: userPosition.position,
    pool: poolAddress,
    positionNftAccount: userPosition.positionNftAccount,
    liquidityDelta: liquidityToRemove,
    tokenAAmountThreshold: withdrawQuote.outAmountA,
    tokenBAmountThreshold: withdrawQuote.outAmountB,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: getTokenProgram(poolState.tokenAFlag),
    tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    currentPoint,
    vestings: vestings.map((vesting) => ({
      account: vesting.publicKey,
      vestingState: vesting.account,
    })),
  });

  modifyComputeUnitPriceIx(removeLiquidityTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating remove liquidity transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [removeLiquidityTx]);
    console.log('> Remove liquidity simulation successful');
  } else {
    console.log(`\n>> Sending remove liquidity transaction...`);

    const removeLiquidityTxHash = await sendAndConfirmTransaction(
      connection,
      removeLiquidityTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to remove liquidity:`, err);
      throw err;
    });

    console.log(`>>> Liquidity removed successfully with tx hash: ${removeLiquidityTxHash}`);

    await connection.confirmTransaction(removeLiquidityTxHash, 'finalized');
  }

  // sanity check if position can be closed (all liquidity removed and fees claimed)
  const updatedPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);
  const updatedUnclaimReward = getUnClaimReward(poolState, updatedPositionState);

  console.log(`\n> Updated position state after liquidity removal:`);
  console.log(`- Unlocked liquidity: ${updatedPositionState.unlockedLiquidity.toString()}`);
  console.log(`- Vested liquidity: ${updatedPositionState.vestedLiquidity.toString()}`);
  console.log(
    `- Permanent locked liquidity: ${updatedPositionState.permanentLockedLiquidity.toString()}`
  );

  const hasRemainingLiquidity =
    !updatedPositionState.unlockedLiquidity.isZero() ||
    !updatedPositionState.vestedLiquidity.isZero() ||
    !updatedPositionState.permanentLockedLiquidity.isZero();

  const hasUnclaimedFees =
    !updatedUnclaimReward.feeTokenA.isZero() || !updatedUnclaimReward.feeTokenB.isZero();

  console.log(`\n> Position status check:`);
  console.log(`- Has remaining liquidity: ${hasRemainingLiquidity}`);
  console.log(`- Has unclaimed fees: ${hasUnclaimedFees}`);

  if (hasRemainingLiquidity) {
    console.log(`\n> Position still has liquidity remaining:`);
    console.log(`- Unlocked liquidity: ${updatedPositionState.unlockedLiquidity.toString()}`);
    console.log(`- Vested liquidity: ${updatedPositionState.vestedLiquidity.toString()}`);
    console.log(
      `- Permanent locked liquidity: ${updatedPositionState.permanentLockedLiquidity.toString()}`
    );
    console.log('> Position cannot be closed yet');
    return;
  }

  // claim any remaining fees before closing position
  if (hasUnclaimedFees) {
    console.log(`\n> Found unclaimed fees, claiming before closing position:`);
    console.log(`- Unclaimed Fee A: ${updatedUnclaimReward.feeTokenA.toString()}`);
    console.log(`- Unclaimed Fee B: ${updatedUnclaimReward.feeTokenB.toString()}`);

    const claimPositionFeeTx = await cpAmmInstance.claimPositionFee({
      owner: wallet.publicKey,
      position: userPosition.position,
      positionNftAccount: userPosition.positionNftAccount,
      pool: poolAddress,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAProgram: getTokenProgram(poolState.tokenAFlag),
      tokenBProgram: getTokenProgram(poolState.tokenBFlag),
    });

    modifyComputeUnitPriceIx(claimPositionFeeTx, config.computeUnitPriceMicroLamports);

    if (config.dryRun) {
      console.log(`\n> Simulating claim position fee transaction...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
        claimPositionFeeTx,
      ]);
      console.log('> Claim position fee simulation successful');
    } else {
      console.log(`\n>> Sending claim position fee transaction...`);

      const claimFeeTxHash = await sendAndConfirmTransaction(
        connection,
        claimPositionFeeTx,
        [wallet.payer],
        {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        }
      ).catch((err) => {
        console.error(`Failed to claim fee for position:`, err);
        throw err;
      });

      console.log(`>>> Position fee claimed successfully with tx hash: ${claimFeeTxHash}`);

      // wait for the fee claiming transaction to be finalized
      await connection.confirmTransaction(claimFeeTxHash, 'confirmed');
    }

    // verify final position state after fee claiming
    const finalPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const finalUnclaimReward = getUnClaimReward(poolState, finalPositionState);

    console.log(`\n> Final position state after fee claiming:`);
    console.log(`- Unlocked liquidity: ${finalPositionState.unlockedLiquidity.toString()}`);
    console.log(`- Vested liquidity: ${finalPositionState.vestedLiquidity.toString()}`);
    console.log(
      `- Permanent locked liquidity: ${finalPositionState.permanentLockedLiquidity.toString()}`
    );
    console.log(`- Unclaimed Fee A: ${finalUnclaimReward.feeTokenA.toString()}`);
    console.log(`- Unclaimed Fee B: ${finalUnclaimReward.feeTokenB.toString()}`);
  }

  console.log(`\n> All liquidity removed and fees claimed. Closing position...`);

  const closePositionTx = await cpAmmInstance.closePosition({
    owner: wallet.publicKey,
    pool: poolAddress,
    position: userPosition.position,
    positionNftMint: updatedPositionState.nftMint,
    positionNftAccount: userPosition.positionNftAccount,
  });

  modifyComputeUnitPriceIx(closePositionTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating close position transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [closePositionTx]);
    console.log('> Close position simulation successful');
  } else {
    console.log(`\n>> Sending close position transaction...`);

    const closePositionTxHash = await sendAndConfirmTransaction(
      connection,
      closePositionTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to close position:`, err);
      throw err;
    });

    console.log(`>>> Position closed successfully with tx hash: ${closePositionTxHash}`);
  }
}

/**
 *
 * @param config - The DAMM V2 config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param poolAddress - The pool address
 */
export async function closePosition(
  config: DammV2Config,
  connection: Connection,
  wallet: Wallet,
  poolAddress: PublicKey
) {
  if (!poolAddress) {
    throw new Error('Pool address is required');
  }

  console.log('\n> Closing position...');

  const cpAmmInstance = new CpAmm(connection);

  const poolState = await cpAmmInstance.fetchPoolState(poolAddress);

  const userPositions = await cpAmmInstance.getUserPositionByPool(poolAddress, wallet.publicKey);

  if (userPositions.length === 0) {
    console.log('> No position found');
    return;
  }

  console.log(`\n> Pool address: ${poolAddress.toString()}`);
  console.log(`\n> Found ${userPositions.length} position(s) in this pool`);

  const positionDataArray = [];
  for (const userPosition of userPositions) {
    const positionState = await cpAmmInstance.fetchPositionState(userPosition.position);
    const unclaimReward = getUnClaimReward(poolState, positionState);
    positionDataArray.push({
      userPosition,
      positionState,
      unclaimReward,
      totalPositionFeeA: positionState.metrics.totalClaimedAFee.add(unclaimReward.feeTokenA),
      totalPositionFeeB: positionState.metrics.totalClaimedBFee.add(unclaimReward.feeTokenB),
    });
  }

  let selectedPositionData;

  if (userPositions.length === 1) {
    selectedPositionData = positionDataArray[0];
    console.log('> Only one position found, closing that position...');
  } else {
    const positionOptions = positionDataArray.map((data, index) => {
      const { positionState } = data;
      const positionAddress = data.userPosition.position.toString().slice(0, 8) + '...';

      return [
        `Position ${index + 1} (${positionAddress})`,
        `  - Unlocked Liquidity: ${positionState.unlockedLiquidity.toString()}`,
        `  - Vested Liquidity: ${positionState.vestedLiquidity.toString()}`,
        `  - Permanent Locked Liquidity: ${positionState.permanentLockedLiquidity.toString()}`,
        `  - Unclaimed Fee A: ${data.unclaimReward.feeTokenA.toString()}`,
        `  - Unclaimed Fee B: ${data.unclaimReward.feeTokenB.toString()}`,
      ].join('\n');
    });

    const selectedIndex = await promptForSelection(
      positionOptions,
      'Which position would you like to close?'
    );

    selectedPositionData = positionDataArray[selectedIndex];
    console.log(`\n> Selected position ${selectedIndex + 1} for closing...`);
  }

  if (!selectedPositionData) {
    throw new Error('No position selected');
  }
  const { userPosition } = selectedPositionData;

  const currentPositionState = await cpAmmInstance.fetchPositionState(userPosition.position);
  const currentUnclaimReward = getUnClaimReward(poolState, currentPositionState);

  console.log(`\n> Current position state:`);
  console.log(`- Unlocked liquidity: ${currentPositionState.unlockedLiquidity.toString()}`);
  console.log(`- Vested liquidity: ${currentPositionState.vestedLiquidity.toString()}`);
  console.log(
    `- Permanent locked liquidity: ${currentPositionState.permanentLockedLiquidity.toString()}`
  );
  console.log(`- Unclaimed Fee A: ${currentUnclaimReward.feeTokenA.toString()}`);
  console.log(`- Unclaimed Fee B: ${currentUnclaimReward.feeTokenB.toString()}`);

  const hasRemainingLiquidity =
    !currentPositionState.unlockedLiquidity.isZero() ||
    !currentPositionState.vestedLiquidity.isZero() ||
    !currentPositionState.permanentLockedLiquidity.isZero();

  const hasUnclaimedFees =
    !currentUnclaimReward.feeTokenA.isZero() || !currentUnclaimReward.feeTokenB.isZero();

  if (hasRemainingLiquidity) {
    console.log(`\n> Position still has liquidity remaining. Please remove liquidity first.`);
    return;
  }

  if (hasUnclaimedFees) {
    console.log(`\n> Position still has unclaimed fees. Please claim fees first.`);
    return;
  }

  console.log(`\n> Position is ready to be closed. Proceeding...`);

  const closePositionTx = await cpAmmInstance.closePosition({
    owner: wallet.publicKey,
    pool: poolAddress,
    position: userPosition.position,
    positionNftMint: currentPositionState.nftMint,
    positionNftAccount: userPosition.positionNftAccount,
  });

  modifyComputeUnitPriceIx(closePositionTx, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`\n> Simulating close position transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [closePositionTx]);
    console.log('> Close position simulation successful');
  } else {
    console.log(`\n>> Sending close position transaction...`);

    const closePositionTxHash = await sendAndConfirmTransaction(
      connection,
      closePositionTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(`Failed to close position:`, err);
      throw err;
    });

    console.log(`>>> Position closed successfully with tx hash: ${closePositionTxHash}`);
  }
}
