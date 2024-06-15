// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

/// @title Pool state that never changes
/// @notice These parameters are fixed for a pool forever, i.e., the methods will always return the same values
interface IEthAfPoolImmutables {
    /// @notice The contract that deployed the pool, which must adhere to the IEthAfFactory interface
    /// @return The contract address
    function factory() external view returns (address);

    /// @notice The first of the two tokens of the pool, sorted by address
    /// @return The token contract address
    function token0() external view returns (address);

    /// @notice The second of the two tokens of the pool, sorted by address
    /// @return The token contract address
    function token1() external view returns (address);

    /// @notice The pool's fee in hundredths of a bip, i.e. 1e-6
    /// @return The fee
    function fee() external view returns (uint24);

    /// @notice The pool tick spacing
    /// @dev Ticks can only be used at multiples of this value, minimum of 1 and always positive
    /// e.g.: a tickSpacing of 3 means ticks can be initialized every 3rd tick, i.e., ..., -6, -3, 0, 3, 6, ...
    /// This value is an int24 to avoid casting even though it is always positive.
    /// @return The tick spacing
    function tickSpacing() external view returns (int24);

    /// @notice The maximum amount of position liquidity that can use any tick in the range
    /// @dev This parameter is enforced per tick to prevent liquidity from overflowing a uint128 at any point, and
    /// also prevents out-of-range liquidity from being used to prevent adding in-range liquidity to a pool
    /// @return The max amount of liquidity per tick
    function maxLiquidityPerTick() external view returns (uint128);

    /// @notice The settings for the tokens in the pool
    /// @dev byte encoded flags for base token and native yield
    /// @return settings The settings
    function poolTokenSettings() external view returns (bytes32 settings);

    /// @notice The settings for the tokens in the pool
    /// @return isBaseToken0 True if token0 is the base token
    /// @return isBaseToken1 True if token1 is the base token
    /// @return token0SupportsNativeYield True if token0 supports ERC20Rebasing
    /// @return token1SupportsNativeYield True if token1 supports ERC20Rebasing
    function getPoolTokenSettings() external view returns (
        bool isBaseToken0,
        bool isBaseToken1,
        bool token0SupportsNativeYield,
        bool token1SupportsNativeYield
    );

    /// @notice The implementation address of the actions module
    /// @return actionsModule_ The module
    function actionsModule() external view returns (address actionsModule_);

    /// @notice The implementation address of the collect module
    /// @return collectModule_ The module
    function collectModule() external view returns (address collectModule_);

    /// @notice The implementation address of the protocol fees module
    /// @return protocolModule_ The module
    function protocolModule() external view returns (address protocolModule_);
}
