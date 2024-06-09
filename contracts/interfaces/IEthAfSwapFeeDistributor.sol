// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;


/// @title IEthAfSwapFeeDistributor
/// @notice Distributes the swap fees of EthAfPools
interface IEthAfSwapFeeDistributor {

    /// @notice Emitted when the owner of the factory is changed
    /// @param oldOwner The owner before the owner was changed
    /// @param newOwner The owner after the owner was changed
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    event SetSafeGasPerLoop(uint256 safeGas);

    event SwapFeesDistributed(address indexed pool);

    // view functions

    function owner() external view returns (address owner_);

    function factory() external view returns (address factory_);

    function nextPoolIndex() external view returns (uint256 nextPoolIndex_);

    function safeGasPerLoop() external view returns (uint256 safeGasPerLoop_);

    // distribute functions

    function distributeFeesForPool(address pool) external;

    function distributeFeesForPools(address[] calldata pools) external;

    function tryDistributeFeesForPool(address pool) external returns (bool success);

    function tryDistributeFeesForPools(address[] calldata pools) external returns (bool[] memory success);

    function tryDistributeFactoryLoop() external;

    // owner functions

    function setSafeGasPerLoop(uint256 loopGas) external;
}
