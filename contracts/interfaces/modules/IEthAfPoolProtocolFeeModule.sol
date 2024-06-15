// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;


/// @title The interface for the ETH AF Pool Protocol Fee Module
/// @notice The ETH AF pool protocol fee module contains the logic enabling and collecting protocol level fees
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
interface IEthAfPoolProtocolFeeModule {

    /// @notice Set the denominator of the protocol's % share of the fees
    /// @param feeProtocol0 new protocol fee for token0 of the pool
    /// @param feeProtocol1 new protocol fee for token1 of the pool
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    /// @notice Collect the protocol fee accrued to the pool
    /// @param recipient The address to which collected protocol fees should be sent
    /// @param amount0Requested The maximum amount of token0 to send, can be 0 to collect fees in only token1
    /// @param amount1Requested The maximum amount of token1 to send, can be 0 to collect fees in only token0
    /// @param token0 The token0 contract address
    /// @param token1 The token1 contract address
    /// @return amount0 The protocol fee collected in token0
    /// @return amount1 The protocol fee collected in token1
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        address token0,
        address token1
    ) external returns (uint128 amount0, uint128 amount1);
}
