// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;


/// @title The interface for the ETH AF Pool Actions Module
/// @notice The ETH AF pool actions module contains the logic for most actions in an ETH AF pool
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
interface IEthAfPoolActionsModule {

    function initialize(uint160 sqrtPriceX96, uint32 timestamp) external;

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

    function flash(
        FlashParams memory params
    ) external;
}
