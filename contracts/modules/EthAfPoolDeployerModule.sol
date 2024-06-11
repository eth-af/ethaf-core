// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;

import './../interfaces/IEthAfPoolDeployerModule.sol';

import './../EthAfPool.sol';

contract EthAfPoolDeployerModule is IEthAfPoolDeployerModule {

    /// @inheritdoc IEthAfPoolDeployerModule
    function deploy(
        address token0,
        address token1,
        uint24 fee
    ) external override returns (address pool) {
        pool = address(new EthAfPool{salt: keccak256(abi.encode(token0, token1, fee))}());
    }

}
