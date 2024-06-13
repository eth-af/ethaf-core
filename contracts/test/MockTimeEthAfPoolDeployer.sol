// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import './MockTimeEthAfPool.sol';

contract MockTimeEthAfPoolDeployer {
    struct Parameters {
        address factory;
        address token0;
        address token1;
        uint24 fee;
        int24 tickSpacing;
        bytes32 poolTokenSettings;
    }

    Parameters public parameters;

    struct ModuleParameters {
        address actionsModule;
        address collectModule;
        address protocolModule;
    }

    ModuleParameters public moduleParameters;

    struct BlastParameters {
        address blast;
        address blastPoints;
        address gasCollector;
        address pointsOperator;
    }

    BlastParameters public blastParameters;

    event PoolDeployed(address pool);

    function deploy(
        address factory,
        address token0,
        address token1,
        uint24 fee,
        int24 tickSpacing
    ) external returns (address pool) {
        parameters = Parameters({factory: factory, token0: token0, token1: token1, fee: fee, tickSpacing: tickSpacing, poolTokenSettings: poolTokenSettings});
        pool = address(
            new MockTimeEthAfPool{salt: keccak256(abi.encodePacked(token0, token1, fee, tickSpacing))}()
        );
        emit PoolDeployed(pool);
        delete parameters;
    }

    bytes32 public poolTokenSettings;

    function setPoolTokenSettings(bytes32 settings) external {
        poolTokenSettings = settings;
    }

    function setModuleParameters(address actionsModule, address collectModule, address protocolModule) external {
        moduleParameters.actionsModule = actionsModule;
        moduleParameters.collectModule = collectModule;
        moduleParameters.protocolModule = protocolModule;
    }
}
