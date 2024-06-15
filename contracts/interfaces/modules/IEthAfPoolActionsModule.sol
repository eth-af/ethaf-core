// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;


/// @title The interface for the ETH AF Pool Actions Module
/// @notice The ETH AF pool actions module contains the logic for most actions in an ETH AF pool
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
interface IEthAfPoolActionsModule {

    /// @notice Sets the initial price for the pool
    /// @dev Price is represented as a sqrt(amountToken1/amountToken0) Q64.96 value
    /// @param sqrtPriceX96 the initial sqrt price of the pool as a Q64.96
    function initialize(uint160 sqrtPriceX96, uint32 timestamp) external;

    /// @notice Increase the maximum number of price and liquidity observations that this pool will store
    /// @dev This method is no-op if the pool already has an observationCardinalityNext greater than or equal to
    /// the input observationCardinalityNext.
    /// @param observationCardinalityNext The desired minimum number of observations for the pool to store
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;

    struct MintParams {
        address recipient;
        int24 tickLower;
        int24 tickUpper;
        uint128 amount;
        address token0;
        address token1;
        bytes data;
        uint32 timestamp;
        int24 tickSpacing;
        uint128 maxLiquidityPerTick;
    }

    /// @notice Adds liquidity for the given recipient/tickLower/tickUpper position
    /// @param params Mint parameters
    /// @return amount0 The amount of token0 that was paid to mint the given amount of liquidity. Matches the value in the callback
    /// @return amount1 The amount of token1 that was paid to mint the given amount of liquidity. Matches the value in the callback
    function mint(
        MintParams memory params
    ) external returns (uint256 amount0, uint256 amount1);

    struct BurnParams {
        int24 tickLower;
        int24 tickUpper;
        uint128 amount;
        uint32 timestamp;
        int24 tickSpacing;
        uint128 maxLiquidityPerTick;
    }

    /// @notice Burn liquidity from the sender and account tokens owed for the liquidity to the position
    /// @param params Burn parameters
    /// @return amount0 The amount of token0 sent to the recipient
    /// @return amount1 The amount of token1 sent to the recipient
    function burn(
        BurnParams memory params
    ) external returns (uint256 amount0, uint256 amount1);

    struct SwapParams {
        address recipient;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        address token0;
        address token1;
        uint24 fee;
        uint32 timestamp;
        bytes data;
        bool isBaseToken0;
        bool isBaseToken1;
        int24 tickSpacing;
    }

    /// @notice Swap token0 for token1, or token1 for token0
    /// @param params Swap parameters
    /// @return amount0 The delta of the balance of token0 of the pool, exact when negative, minimum when positive
    /// @return amount1 The delta of the balance of token1 of the pool, exact when negative, minimum when positive
    function swap(
        SwapParams memory params
    ) external returns (int256 amount0, int256 amount1);

    struct FlashParams {
        address recipient;
        uint256 amount0;
        uint256 amount1;
        address token0;
        address token1;
        uint24 fee;
        bytes data;
        bytes32 poolTokenSettings;
    }

    /// @notice Receive token0 and/or token1 and pay it back, plus a fee, in the callback
    /// @param params Flash parameters
    function flash(
        FlashParams memory params
    ) external;
}
