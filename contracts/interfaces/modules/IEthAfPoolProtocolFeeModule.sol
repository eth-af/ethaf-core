// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;


/// @title The interface for the ETH AF Pool Protocol Fee Module
/// @notice The ETH AF pool protocol fee module contains the logic enabling and collecting protocol level fees
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
interface IEthAfPoolProtocolFeeModule {

    // /// @inheritdoc IEthAfPoolOwnerActions
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    // /// @inheritdoc IEthAfPoolOwnerActions
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested,
        address token0,
        address token1
    ) external returns (uint128 amount0, uint128 amount1);
}
