// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import './../interfaces/pool/IEthAfPoolEvents.sol';

import './../libraries/LowGasSafeMath.sol';
import './../libraries/SafeCast.sol';
import './../libraries/Tick.sol';
import './../libraries/TickBitmap.sol';
import './../libraries/Position.sol';
import './../libraries/Oracle.sol';

import './../libraries/FullMath.sol';
import './../libraries/FixedPoint128.sol';
import './../libraries/TransferHelper.sol';
import './../libraries/TickMath.sol';
import './../libraries/LiquidityMath.sol';
import './../libraries/SqrtPriceMath.sol';
import './../libraries/SwapMath.sol';

import './../interfaces/IERC20Minimal.sol';
import './../interfaces/callback/IEthAfMintCallback.sol';
import './../interfaces/callback/IEthAfSwapCallback.sol';
import './../interfaces/callback/IEthAfFlashCallback.sol';

import './../libraries/PoolTokenSettings.sol';

import './../interfaces/external/Blast/IBlast.sol';
import './../interfaces/external/Blast/IBlastPoints.sol';
import './../interfaces/external/Blast/IERC20Rebasing.sol';
import './../interfaces/modules/IEthAfPoolActionsModule.sol';


/// @title The ETH AF Pool Actions Module
/// @notice The ETH AF pool actions module contains the logic for most actions in an ETH AF pool
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
contract EthAfPoolActionsModule is IEthAfPoolActionsModule, IEthAfPoolEvents {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    // accumalated base tokens in token0/token1 units
    struct BaseTokensAccumulated {
        uint256 amount0;
        uint256 amount1;
    }

    // storage slots
    bytes32 internal constant SLOT_0_SLOT                  = bytes32(uint256(0));
    bytes32 internal constant FEE_GROWTH_GLOBAL_0_SLOT     = bytes32(uint256(1));
    bytes32 internal constant FEE_GROWTH_GLOBAL_1_SLOT     = bytes32(uint256(2));
    bytes32 internal constant PROTOCOL_FEES_SLOT           = bytes32(uint256(3));
    bytes32 internal constant LIQUIDITY_SLOT               = bytes32(uint256(4));
    bytes32 internal constant TICKS_SLOT                   = bytes32(uint256(5));
    bytes32 internal constant TICK_BITMAP_SLOT             = bytes32(uint256(6));
    bytes32 internal constant POSITIONS_SLOT               = bytes32(uint256(7));
    bytes32 internal constant OBSERVATIONS_SLOT            = bytes32(uint256(8));
    bytes32 internal constant BASE_TOKENS_ACCUMULATED_SLOT = keccak256("ethaf.pool.storage.basetokenacc");

    // bytes packed flags to save stack space
    bytes32 internal constant FLIPPED_FLAGS_NONE       = bytes32(uint256(0));
    bytes32 internal constant FLIPPED_FLAGS_TICK_LOWER = bytes32(uint256(1));
    bytes32 internal constant FLIPPED_FLAGS_TICK_UPPER = bytes32(uint256(2));

    // constructor

    constructor(
        address blast,
        address blastPoints,
        address gasCollector,
        address pointsOperator
    ) {
        // calls to setup blast
        if(blast != address(0)) {
            IBlast(blast).configureClaimableGas();
            if(gasCollector != address(0)) {
                IBlast(blast).configureGovernor(gasCollector);
            }

        }
        if(blastPoints != address(0) && pointsOperator != address(0)) {
            IBlastPoints(blastPoints).configurePointsOperator(pointsOperator);
        }
    }

    // mutator functions
    // these may or may not have the same signature as the related function on the pool

    /// @inheritdoc IEthAfPoolActionsModule
    function initialize(uint160 sqrtPriceX96, uint32 timestamp) external override {
        Slot0 storage _slot0 = getSlot0();
        require(_slot0.sqrtPriceX96 == 0, 'AI');

        int24 tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);

        (uint16 cardinality, uint16 cardinalityNext) = getObservations().initialize(timestamp);

        /*
        _slot0 = Slot0({
            sqrtPriceX96: sqrtPriceX96,
            tick: tick,
            observationIndex: 0,
            observationCardinality: cardinality,
            observationCardinalityNext: cardinalityNext,
            feeProtocol: 0,
            unlocked: true
        });
        */

        _slot0.sqrtPriceX96 = sqrtPriceX96;
        _slot0.tick = tick;
        _slot0.observationIndex = 0;
        _slot0.observationCardinality = cardinality;
        _slot0.observationCardinalityNext = cardinalityNext;
        _slot0.feeProtocol = 0;
        _slot0.unlocked = true;


        emit Initialize(sqrtPriceX96, tick);
    }

    /// @inheritdoc IEthAfPoolActionsModule
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external override {
        Slot0 storage _slot0 = getSlot0();
        uint16 observationCardinalityNextOld = _slot0.observationCardinalityNext; // for the event
        uint16 observationCardinalityNextNew =
            getObservations().grow(observationCardinalityNextOld, observationCardinalityNext);
        _slot0.observationCardinalityNext = observationCardinalityNextNew;
        if (observationCardinalityNextOld != observationCardinalityNextNew)
            emit IncreaseObservationCardinalityNext(observationCardinalityNextOld, observationCardinalityNextNew);
    }

    struct ModifyPositionParams {
        // the address that owns the position
        address owner;
        // the lower and upper tick of the position
        int24 tickLower;
        int24 tickUpper;
        // any change in liquidity
        int128 liquidityDelta;
        // timestamp
        uint32 timestamp;
        int24 tickSpacing;
        uint128 maxLiquidityPerTick;
    }

    /// @dev Modifies a position
    function _modifyPosition(ModifyPositionParams memory params)
        private
        returns (
            Position.Info storage position,
            int256 amount0,
            int256 amount1
        )
    {
        checkTicks(params.tickLower, params.tickUpper);

        Slot0 memory _slot0 = getSlot0(); // SLOAD for gas optimization

        position = _updatePosition(
            UpdatePositionParams({
                owner: params.owner,
                tickLower: params.tickLower,
                tickUpper: params.tickUpper,
                liquidityDelta: params.liquidityDelta,
                tick: _slot0.tick,
                timestamp: params.timestamp,
                tickSpacing: params.tickSpacing,
                maxLiquidityPerTick: params.maxLiquidityPerTick
            })
        );

        if (params.liquidityDelta != 0) {
            if (_slot0.tick < params.tickLower) {
                // current tick is below the passed range; liquidity can only become in range by crossing from left to
                // right, when we'll need _more_ token0 (it's becoming more valuable) so user must provide it
                amount0 = SqrtPriceMath.getAmount0Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            } else if (_slot0.tick < params.tickUpper) {
                // current tick is inside the passed range
                uint128 liquidityBefore = getLiquidity(); // SLOAD for gas optimization

                // write an oracle entry
                (_slot0.observationIndex, _slot0.observationCardinality) = getObservations().write(
                    _slot0.observationIndex,
                    params.timestamp,
                    _slot0.tick,
                    liquidityBefore,
                    _slot0.observationCardinality,
                    _slot0.observationCardinalityNext
                );

                amount0 = SqrtPriceMath.getAmount0Delta(
                    _slot0.sqrtPriceX96,
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    _slot0.sqrtPriceX96,
                    params.liquidityDelta
                );

                uint128 newLiquidity = LiquidityMath.addDelta(liquidityBefore, params.liquidityDelta);
                setLiquidity(newLiquidity);
            } else {
                // current tick is above the passed range; liquidity can only become in range by crossing from right to
                // left, when we'll need _more_ token1 (it's becoming more valuable) so user must provide it
                amount1 = SqrtPriceMath.getAmount1Delta(
                    TickMath.getSqrtRatioAtTick(params.tickLower),
                    TickMath.getSqrtRatioAtTick(params.tickUpper),
                    params.liquidityDelta
                );
            }
        }
    }

    struct UpdatePositionParams {
        address owner;
        int24 tickLower;
        int24 tickUpper;
        int128 liquidityDelta;
        int24 tick;
        uint32 timestamp;
        int24 tickSpacing;
        uint128 maxLiquidityPerTick;
    }

    /// @dev Updates a position
    function _updatePosition(
        UpdatePositionParams memory params
    ) private returns (Position.Info storage position) {
        position = getPositions().get(params.owner, params.tickLower, params.tickUpper);

        uint256 _feeGrowthGlobal0X128 = getFeeGrowthGlobal0X128(); // SLOAD for gas optimization
        uint256 _feeGrowthGlobal1X128 = getFeeGrowthGlobal1X128(); // SLOAD for gas optimization

        // if we need to update the ticks, do it
        bytes32 flippedFlags = FLIPPED_FLAGS_NONE;
        if (params.liquidityDelta != 0) {
            flippedFlags = _updatePositionHelper(params);
        }

        {
        (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) =
            getTicks().getFeeGrowthInside(params.tickLower, params.tickUpper, params.tick, _feeGrowthGlobal0X128, _feeGrowthGlobal1X128);

        position.update(params.liquidityDelta, feeGrowthInside0X128, feeGrowthInside1X128);
        }

        // clear any tick data that is no longer needed
        if (params.liquidityDelta < 0) {
            if ((flippedFlags & FLIPPED_FLAGS_TICK_LOWER) != 0) {
                getTicks().clear(params.tickLower);
            }
            if ((flippedFlags & FLIPPED_FLAGS_TICK_UPPER) != 0) {
                getTicks().clear(params.tickUpper);
            }
        }

    }

    /// @dev Helps to update a position
    function _updatePositionHelper(
        UpdatePositionParams memory params
    ) private returns (bytes32 flippedFlags) {
        uint256 _feeGrowthGlobal0X128 = getFeeGrowthGlobal0X128(); // SLOAD for gas optimization
        uint256 _feeGrowthGlobal1X128 = getFeeGrowthGlobal1X128(); // SLOAD for gas optimization

        // if we need to update the ticks, do it
        (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) =
            getObservations().observeSingle(
                params.timestamp,
                0,
                getSlot0().tick,
                getSlot0().observationIndex,
                getLiquidity(),
                getSlot0().observationCardinality
            );
        flippedFlags = FLIPPED_FLAGS_NONE;
        if(getTicks().update(
            params.tickLower,
            params.tick,
            params.liquidityDelta,
            _feeGrowthGlobal0X128,
            _feeGrowthGlobal1X128,
            secondsPerLiquidityCumulativeX128,
            tickCumulative,
            params.timestamp,
            false,
            params.maxLiquidityPerTick
        )) {
            flippedFlags |= FLIPPED_FLAGS_TICK_LOWER;
        }
        if(getTicks().update(
            params.tickUpper,
            params.tick,
            params.liquidityDelta,
            _feeGrowthGlobal0X128,
            _feeGrowthGlobal1X128,
            secondsPerLiquidityCumulativeX128,
            tickCumulative,
            params.timestamp,
            true,
            params.maxLiquidityPerTick
        )) {
            flippedFlags |= FLIPPED_FLAGS_TICK_UPPER;
        }

        if ((flippedFlags & FLIPPED_FLAGS_TICK_LOWER) != 0) {
            getTickBitmap().flipTick(params.tickLower, params.tickSpacing);
        }
        if ((flippedFlags & FLIPPED_FLAGS_TICK_UPPER) != 0) {
            getTickBitmap().flipTick(params.tickUpper, params.tickSpacing);
        }
    }

    /// @inheritdoc IEthAfPoolActionsModule
    function mint(
        MintParams memory params
    ) external override returns (uint256 amount0, uint256 amount1) {
        require(params.amount > 0);
        (, int256 amount0Int, int256 amount1Int) =
            _modifyPosition(
                ModifyPositionParams({
                    owner: params.recipient,
                    tickLower: params.tickLower,
                    tickUpper: params.tickUpper,
                    liquidityDelta: int256(params.amount).toInt128(),
                    timestamp: params.timestamp,
                    tickSpacing: params.tickSpacing,
                    maxLiquidityPerTick: params.maxLiquidityPerTick
                })
            );

        amount0 = uint256(amount0Int);
        amount1 = uint256(amount1Int);

        uint256 balance0Before;
        uint256 balance1Before;
        if (amount0 > 0) balance0Before = getTokenBalance(params.token0);
        if (amount1 > 0) balance1Before = getTokenBalance(params.token1);
        IEthAfMintCallback(msg.sender).ethafMintCallback(amount0, amount1, params.data);
        if (amount0 > 0) require(balance0Before.add(amount0) <= getTokenBalance(params.token0), 'M0');
        if (amount1 > 0) require(balance1Before.add(amount1) <= getTokenBalance(params.token1), 'M1');

        emit Mint(msg.sender, params.recipient, params.tickLower, params.tickUpper, params.amount, amount0, amount1);
    }

    /// @inheritdoc IEthAfPoolActionsModule
    function burn(
        BurnParams memory params
    ) external override returns (uint256 amount0, uint256 amount1) {
        // modify position
        (Position.Info storage position, int256 amount0Int, int256 amount1Int) =
            _modifyPosition(
                ModifyPositionParams({
                    owner: msg.sender,
                    tickLower: params.tickLower,
                    tickUpper: params.tickUpper,
                    liquidityDelta: -int256(params.amount).toInt128(),
                    timestamp: params.timestamp,
                    tickSpacing: params.tickSpacing,
                    maxLiquidityPerTick: params.maxLiquidityPerTick
                })
            );

        amount0 = uint256(-amount0Int);
        amount1 = uint256(-amount1Int);

        // accumulate rewards
        if (amount0 > 0 || amount1 > 0) {
            (position.tokensOwed0, position.tokensOwed1) = (
                position.tokensOwed0 + uint128(amount0),
                position.tokensOwed1 + uint128(amount1)
            );
        }

        emit Burn(msg.sender, params.tickLower, params.tickUpper, params.amount, amount0, amount1);
    }

    struct SwapCache {
        // the protocol fee for the input token
        uint8 feeProtocol;
        // liquidity at the beginning of the swap
        uint128 liquidityStart;
        // the timestamp of the current block
        uint32 blockTimestamp;
        // the current value of the tick accumulator, computed only if we cross an initialized tick
        int56 tickCumulative;
        // the current value of seconds per liquidity accumulator, computed only if we cross an initialized tick
        uint160 secondsPerLiquidityCumulativeX128;
        // whether we've computed and cached the above two accumulators
        bool computedLatestObservation;
    }

    // the top level state of the swap, the results of which are recorded in storage at the end
    struct SwapState {
        // the amount remaining to be swapped in/out of the input/output asset
        int256 amountSpecifiedRemaining;
        // the amount already swapped out/in of the output/input asset
        int256 amountCalculated;
        // current sqrt(price)
        uint160 sqrtPriceX96;
        // the tick associated with the current price
        int24 tick;
        // the global fee growth of the input token
        uint256 feeGrowthGlobalX128;
        // amount of input token paid as protocol fee
        uint128 protocolFee;
        // the current liquidity in range
        uint128 liquidity;
    }

    struct StepComputations {
        // the price at the beginning of the step
        uint160 sqrtPriceStartX96;
        // the next tick to swap to from the current tick in the swap direction
        int24 tickNext;
        // whether tickNext is initialized or not
        bool initialized;
        // sqrt(price) for the next tick (1/0)
        uint160 sqrtPriceNextX96;
        // how much is being swapped in in this step
        uint256 amountIn;
        // how much is being swapped out
        uint256 amountOut;
        // how much fee is being paid in
        uint256 feeAmount;
    }

    /// @inheritdoc IEthAfPoolActionsModule
    function swap(
        SwapParams memory params
    ) external override returns (int256 amount0, int256 amount1) {
        require(params.amountSpecified != 0, 'AS');

        Slot0 memory slot0Start = getSlot0();

        require(slot0Start.unlocked, 'LOK');
        require(
            params.zeroForOne
                ? params.sqrtPriceLimitX96 < slot0Start.sqrtPriceX96 && params.sqrtPriceLimitX96 > TickMath.MIN_SQRT_RATIO
                : params.sqrtPriceLimitX96 > slot0Start.sqrtPriceX96 && params.sqrtPriceLimitX96 < TickMath.MAX_SQRT_RATIO,
            'SPL'
        );

        getSlot0().unlocked = false;

        SwapCache memory cache =
            SwapCache({
                liquidityStart: getLiquidity(),
                blockTimestamp: params.timestamp,
                feeProtocol: params.zeroForOne ? (slot0Start.feeProtocol % 16) : (slot0Start.feeProtocol >> 4),
                secondsPerLiquidityCumulativeX128: 0,
                tickCumulative: 0,
                computedLatestObservation: false
            });

        bool exactInput = params.amountSpecified > 0;

        SwapState memory state =
            SwapState({
                amountSpecifiedRemaining: params.amountSpecified,
                amountCalculated: 0,
                sqrtPriceX96: slot0Start.sqrtPriceX96,
                tick: slot0Start.tick,
                feeGrowthGlobalX128: params.zeroForOne ? getFeeGrowthGlobal0X128() : getFeeGrowthGlobal1X128(),
                protocolFee: 0,
                liquidity: cache.liquidityStart
            });

        // continue swapping as long as we haven't used the entire input/output and haven't reached the price limit
        while (state.amountSpecifiedRemaining != 0 && state.sqrtPriceX96 != params.sqrtPriceLimitX96) {
            StepComputations memory step;

            step.sqrtPriceStartX96 = state.sqrtPriceX96;

            (step.tickNext, step.initialized) = getTickBitmap().nextInitializedTickWithinOneWord(
                state.tick,
                params.tickSpacing,
                params.zeroForOne
            );

            // ensure that we do not overshoot the min/max tick, as the tick bitmap is not aware of these bounds
            if (step.tickNext < TickMath.MIN_TICK) {
                step.tickNext = TickMath.MIN_TICK;
            } else if (step.tickNext > TickMath.MAX_TICK) {
                step.tickNext = TickMath.MAX_TICK;
            }

            // get the price for the next tick
            step.sqrtPriceNextX96 = TickMath.getSqrtRatioAtTick(step.tickNext);

            // compute values to swap to the target tick, price limit, or point where input/output amount is exhausted
            (state.sqrtPriceX96, step.amountIn, step.amountOut, step.feeAmount) = SwapMath.computeSwapStep(
                state.sqrtPriceX96,
                (params.zeroForOne ? step.sqrtPriceNextX96 < params.sqrtPriceLimitX96 : step.sqrtPriceNextX96 > params.sqrtPriceLimitX96)
                    ? params.sqrtPriceLimitX96
                    : step.sqrtPriceNextX96,
                state.liquidity,
                state.amountSpecifiedRemaining,
                params.fee
            );

            if (exactInput) {
                state.amountSpecifiedRemaining -= (step.amountIn + step.feeAmount).toInt256();
                state.amountCalculated = state.amountCalculated.sub(step.amountOut.toInt256());
            } else {
                state.amountSpecifiedRemaining += step.amountOut.toInt256();
                state.amountCalculated = state.amountCalculated.add((step.amountIn + step.feeAmount).toInt256());
            }

            // if the protocol fee is on, calculate how much is owed, decrement feeAmount, and increment protocolFee
            if (cache.feeProtocol > 0) {
                uint256 delta = step.feeAmount / cache.feeProtocol;
                step.feeAmount -= delta;
                state.protocolFee += uint128(delta);
            }

            // update global fee tracker
            {
            if( (params.zeroForOne && params.isBaseToken0) || (!params.zeroForOne && params.isBaseToken1)) {
                state.feeGrowthGlobalX128 += step.feeAmount;
            } else {
                if (state.liquidity > 0) {
                    state.feeGrowthGlobalX128 += FullMath.mulDiv(step.feeAmount, FixedPoint128.Q128, state.liquidity);
                }
            }
            }

            // shift tick if we reached the next price
            if (state.sqrtPriceX96 == step.sqrtPriceNextX96) {
                // if the tick is initialized, run the tick transition
                if (step.initialized) {
                    // check for the placeholder value, which we replace with the actual value the first time the swap
                    // crosses an initialized tick
                    if (!cache.computedLatestObservation) {
                        (cache.tickCumulative, cache.secondsPerLiquidityCumulativeX128) = getObservations().observeSingle(
                            cache.blockTimestamp,
                            0,
                            slot0Start.tick,
                            slot0Start.observationIndex,
                            cache.liquidityStart,
                            slot0Start.observationCardinality
                        );
                        cache.computedLatestObservation = true;
                    }
                    // do not reward fees for base token
                    uint256 feeGrowth0;
                    uint256 feeGrowth1;
                    {
                    feeGrowth0 = (params.isBaseToken0
                        ? 0
                        : (params.zeroForOne ? state.feeGrowthGlobalX128 : getFeeGrowthGlobal0X128())
                    );
                    feeGrowth1 = (params.isBaseToken1
                        ? 0
                        : (params.zeroForOne ? getFeeGrowthGlobal1X128() : state.feeGrowthGlobalX128)
                    );
                    }
                    int128 liquidityNet =
                        getTicks().cross(
                            step.tickNext,
                            feeGrowth0,
                            feeGrowth1,
                            cache.secondsPerLiquidityCumulativeX128,
                            cache.tickCumulative,
                            cache.blockTimestamp
                        );
                    // if we're moving leftward, we interpret liquidityNet as the opposite sign
                    // safe because liquidityNet cannot be type(int128).min
                    if (params.zeroForOne) liquidityNet = -liquidityNet;

                    state.liquidity = LiquidityMath.addDelta(state.liquidity, liquidityNet);
                }

                state.tick = params.zeroForOne ? step.tickNext - 1 : step.tickNext;
            } else if (state.sqrtPriceX96 != step.sqrtPriceStartX96) {
                // recompute unless we're on a lower tick boundary (i.e. already transitioned ticks), and haven't moved
                state.tick = TickMath.getTickAtSqrtRatio(state.sqrtPriceX96);
            }
        }

        // update tick and write an oracle entry if the tick change
        if (state.tick != slot0Start.tick) {
            (uint16 observationIndex, uint16 observationCardinality) =
                getObservations().write(
                    slot0Start.observationIndex,
                    cache.blockTimestamp,
                    slot0Start.tick,
                    cache.liquidityStart,
                    slot0Start.observationCardinality,
                    slot0Start.observationCardinalityNext
                );
            Slot0 storage _slot0 = getSlot0();
            (_slot0.sqrtPriceX96, _slot0.tick, _slot0.observationIndex, _slot0.observationCardinality) = (
                state.sqrtPriceX96,
                state.tick,
                observationIndex,
                observationCardinality
            );
        } else {
            // otherwise just update the price
            getSlot0().sqrtPriceX96 = state.sqrtPriceX96;
        }

        // update liquidity if it changed
        if (cache.liquidityStart != state.liquidity) {
            setLiquidity(state.liquidity);
        }

        // calculate final amounts
        (amount0, amount1) = params.zeroForOne == exactInput
            ? (params.amountSpecified - state.amountSpecifiedRemaining, state.amountCalculated)
            : (state.amountCalculated, params.amountSpecified - state.amountSpecifiedRemaining);

        // update fee growth global and, if necessary, protocol fees
        // overflow is acceptable, protocol has to withdraw before it hits type(uint128).max fees
        {
        // do not reward fees for base token
        if (params.zeroForOne) {
            if(params.isBaseToken0) {
                uint256 feeAmount = uint256(amount0) - uint256(state.protocolFee);
                getBaseTokensAccumulated().amount0 += feeAmount * uint256(params.fee) / 1e6;
            } else {
                setFeeGrowthGlobal0X128(state.feeGrowthGlobalX128);
            }
            if (state.protocolFee > 0) {
                getProtocolFees().token0 += state.protocolFee;
            }
        } else {
            if(params.isBaseToken1) {
                uint256 feeAmount = uint256(amount1) - uint256(state.protocolFee);
                getBaseTokensAccumulated().amount1 += feeAmount * uint256(params.fee) / 1e6;
            } else {
                setFeeGrowthGlobal1X128(state.feeGrowthGlobalX128);
            }
            if (state.protocolFee > 0) {
                getProtocolFees().token1 += state.protocolFee;
            }
        }
        }

        // do the transfers and collect payment
        if (params.zeroForOne) {
            if (amount1 < 0) TransferHelper.safeTransfer(params.token1, params.recipient, uint256(-amount1));

            uint256 balance0Before = getTokenBalance(params.token0);
            IEthAfSwapCallback(msg.sender).ethafSwapCallback(amount0, amount1, params.data);
            require(balance0Before.add(uint256(amount0)) <= getTokenBalance(params.token0), 'IIA');
        } else {
            if (amount0 < 0) TransferHelper.safeTransfer(params.token0, params.recipient, uint256(-amount0));

            uint256 balance1Before = getTokenBalance(params.token1);
            IEthAfSwapCallback(msg.sender).ethafSwapCallback(amount0, amount1, params.data);
            require(balance1Before.add(uint256(amount1)) <= getTokenBalance(params.token1), 'IIA');
        }

        emit Swap(msg.sender, params.recipient, amount0, amount1, state.sqrtPriceX96, state.liquidity, state.tick);
        getSlot0().unlocked = true;
    }

    /// @inheritdoc IEthAfPoolActionsModule
    function flash(
        FlashParams memory params
    ) external override {
        // math
        uint256 paid0;
        uint256 paid1;
        uint128 _liquidity = getLiquidity();
        require(_liquidity > 0, 'L');
        { // scope
        uint256 fee0 = FullMath.mulDivRoundingUp(params.amount0, params.fee, 1e6);
        uint256 fee1 = FullMath.mulDivRoundingUp(params.amount1, params.fee, 1e6);
        uint256 balance0Before = getTokenBalance(params.token0);
        uint256 balance1Before = getTokenBalance(params.token1);

        // optimistic transfer out
        if (params.amount0 > 0) TransferHelper.safeTransfer(params.token0, params.recipient, params.amount0);
        if (params.amount1 > 0) TransferHelper.safeTransfer(params.token1, params.recipient, params.amount1);

        // flash callback
        IEthAfFlashCallback(msg.sender).ethafFlashCallback(fee0, fee1, params.data);

        // math
        uint256 balance0After = getTokenBalance(params.token0);
        uint256 balance1After = getTokenBalance(params.token1);

        require(balance0Before.add(fee0) <= balance0After, 'F0');
        require(balance1Before.add(fee1) <= balance1After, 'F1');

        // sub is safe because we know balanceAfter is gt balanceBefore by at least fee
        paid0 = balance0After - balance0Before;
        paid1 = balance1After - balance1Before;
        }

        {
        // distribute rewards
        bytes32 settings = params.poolTokenSettings;
        Slot0 storage _slot0 = getSlot0();
        ProtocolFees storage _protocolFees = getProtocolFees();
        if (paid0 > 0) {
            uint8 feeProtocol0 = _slot0.feeProtocol % 16;
            uint256 fees0 = feeProtocol0 == 0 ? 0 : paid0 / feeProtocol0;
            if (uint128(fees0) > 0) _protocolFees.token0 += uint128(fees0);
            bool isBaseToken0 = PoolTokenSettings.isBaseToken0(settings);
            if(isBaseToken0) {
                getBaseTokensAccumulated().amount0 += (paid0 - fees0);
            } else {
                uint256 fees0X128 = FullMath.mulDiv(paid0 - fees0, FixedPoint128.Q128, _liquidity);
                increaseFeeGrowthGlobal0X128(fees0X128);
            }
        }
        if (paid1 > 0) {
            uint8 feeProtocol1 = _slot0.feeProtocol >> 4;
            uint256 fees1 = feeProtocol1 == 0 ? 0 : paid1 / feeProtocol1;
            if (uint128(fees1) > 0) _protocolFees.token1 += uint128(fees1);
            bool isBaseToken1 = PoolTokenSettings.isBaseToken1(settings);
            if(isBaseToken1) {
                getBaseTokensAccumulated().amount1 += (paid1 - fees1);
            } else {
                uint256 fees1X128 = FullMath.mulDiv(paid1 - fees1, FixedPoint128.Q128, _liquidity);
                increaseFeeGrowthGlobal1X128(fees1X128);
            }
        }
        }

        emit Flash(msg.sender, params.recipient, params.amount0, params.amount1, paid0, paid1);
    }

    // helper functions

    /// @dev Common checks for valid tick inputs.
    function checkTicks(int24 tickLower, int24 tickUpper) private pure {
        require(tickLower < tickUpper, 'TLU');
        require(tickLower >= TickMath.MIN_TICK, 'TLM');
        require(tickUpper <= TickMath.MAX_TICK, 'TUM');
    }

    /// @dev Gets the erc20 balance of token held by the pool
    function getTokenBalance(address token) private view returns (uint256) {
        (bool success, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        require(success && data.length >= 32);
        return abi.decode(data, (uint256));
    }

    // dev: these are required because the module cannot access the global storage variables by name

    // getter functions
    // some return the value, some return the storage pointer

    /// @dev Gets the storage pointer for slot0
    function getSlot0() internal pure returns (Slot0 storage _slot0) {
        bytes32 position = SLOT_0_SLOT;
        assembly {
            _slot0.slot := position
        }
    }

    /// @dev Gets feeGrowthGlobal0X128
    function getFeeGrowthGlobal0X128() internal view returns (uint256 feeGrowth) {
        bytes32 position = FEE_GROWTH_GLOBAL_0_SLOT;
        assembly {
            feeGrowth := sload(position)
        }
    }

    /// @dev Gets feeGrowthGlobal1X128
    function getFeeGrowthGlobal1X128() internal view returns (uint256 feeGrowth) {
        bytes32 position = FEE_GROWTH_GLOBAL_1_SLOT;
        assembly {
            feeGrowth := sload(position)
        }
    }

    /// @dev Gets the storage pointer for protocolFees
    function getProtocolFees() internal pure returns (ProtocolFees storage _fees) {
        bytes32 position = PROTOCOL_FEES_SLOT;
        assembly {
            _fees.slot := position
        }
    }

    /// @dev Gets liquidity
    function getLiquidity() internal view returns (uint128 _liquidity) {
        bytes32 position = LIQUIDITY_SLOT;
        assembly {
            _liquidity := sload(position)
        }
    }

    /// @dev Gets the storage pointer for ticks
    function getTicks() internal pure returns (mapping(int24 => Tick.Info) storage _ticks) {
        bytes32 position = TICKS_SLOT;
        assembly {
            _ticks.slot := position
        }
    }

    /// @dev Gets the storage pointer for tickBitmap
    function getTickBitmap() internal pure returns (mapping(int16 => uint256) storage _tickBitmap) {
        bytes32 position = TICK_BITMAP_SLOT;
        assembly {
            _tickBitmap.slot := position
        }
    }

    /// @dev Gets the storage pointer for positions
    function getPositions() internal pure returns (mapping(bytes32 => Position.Info) storage _positions) {
        bytes32 position = POSITIONS_SLOT;
        assembly {
            _positions.slot := position
        }
    }

    /// @dev Gets the storage pointer for observations
    function getObservations() internal pure returns (Oracle.Observation[65535] storage _observations) {
        bytes32 position = OBSERVATIONS_SLOT;
        assembly {
            _observations.slot := position
        }
    }

    /// @dev Gets the storage pointer for baseTokensAccumulated
    function getBaseTokensAccumulated() internal pure returns (BaseTokensAccumulated storage _baseTokensAcc) {
        bytes32 position = BASE_TOKENS_ACCUMULATED_SLOT;
        assembly {
            _baseTokensAcc.slot := position
        }
    }

    // setter functions

    /// @dev Increases feeGrowthGlobal0X128
    function increaseFeeGrowthGlobal0X128(uint256 feeGrowth) internal {
        bytes32 position = FEE_GROWTH_GLOBAL_0_SLOT;
        uint256 feeGrowthStored;
        assembly {
            feeGrowthStored := sload(position)
        }
        feeGrowthStored += feeGrowth;
        assembly {
            sstore(position, feeGrowthStored)
        }
    }

    /// @dev Increases feeGrowthGlobal1X128
    function increaseFeeGrowthGlobal1X128(uint256 feeGrowth) internal {
        bytes32 position = FEE_GROWTH_GLOBAL_1_SLOT;
        uint256 feeGrowthStored;
        assembly {
            feeGrowthStored := sload(position)
        }
        feeGrowthStored += feeGrowth;
        assembly {
            sstore(position, feeGrowthStored)
        }
    }

    /// @dev Sets feeGrowthGlobal1X128
    function setFeeGrowthGlobal0X128(uint256 feeGrowth) internal {
        bytes32 position = FEE_GROWTH_GLOBAL_0_SLOT;
        assembly {
            sstore(position, feeGrowth)
        }
    }

    /// @dev Sets feeGrowthGlobal1X128
    function setFeeGrowthGlobal1X128(uint256 feeGrowth) internal {
        bytes32 position = FEE_GROWTH_GLOBAL_1_SLOT;
        assembly {
            sstore(position, feeGrowth)
        }
    }

    /// @dev Sets liquidity
    function setLiquidity(uint128 _liquidity) internal {
        bytes32 position = LIQUIDITY_SLOT;
        assembly {
            sstore(position, _liquidity)
        }
    }

}
