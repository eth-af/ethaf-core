// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;
pragma abicoder v2;


/// @title The interface for the ETH AF Pool Collect Module
/// @notice The ETH AF pool collect module contains the logic for collect and collectBaseToken
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
interface IEthAfPoolCollectModule {

    struct CollectParams {
        address recipient;
        int24 tickLower;
        int24 tickUpper;
        uint128 amount0Requested;
        uint128 amount1Requested;
        address token0;
        address token1;
    }

    /// @notice Collects tokens owed to a position
    /// @param params Collect parameters
    function collect(
        CollectParams memory params
    ) external returns (uint128 amount0, uint128 amount1);

    /// @notice Collects the swap fees from base tokens in this pool
    /// @param recipient The address to receive the base tokens
    /// @param token0 The token0 contract address
    /// @param token1 The token1 contract address
    /// @param settings The token settings
    function collectBaseToken(
        address recipient,
        address token0,
        address token1,
        bytes32 settings
    ) external;

}
