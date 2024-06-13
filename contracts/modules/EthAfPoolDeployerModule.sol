// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;

import './../interfaces/IEthAfPoolDeployerModule.sol';

import './../EthAfPool.sol';

import './../interfaces/external/Blast/IBlast.sol';
import './../interfaces/external/Blast/IBlastPoints.sol';


/// @title The ETH AF Pool Deployer Module
/// @notice The ETH AF pool deployer module helps the factory deploy pools
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
contract EthAfPoolDeployerModule is IEthAfPoolDeployerModule {

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

    /// @inheritdoc IEthAfPoolDeployerModule
    function deploy(
        address token0,
        address token1,
        uint24 fee
    ) external override returns (address pool) {
        pool = address(new EthAfPool{salt: keccak256(abi.encode(token0, token1, fee))}());
    }

}
