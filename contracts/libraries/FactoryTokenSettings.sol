// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.4.0;

/// @title FactoryTokenSettings
/// @notice A library for storing constants for token settings
library FactoryTokenSettings {

    // to be used in factory

    // the factory can store token settings that allow it to determine which token if any should be used
    // as the base token in a pool to be deployed. the factory checks the settings for the two tokens then:
    // if only one token is a USD token, that is the base token
    // else if only one token is a ETH token, that is the base token
    // else no base tokens
    // there can also be overrides set per pair

    bytes32 internal constant IS_BASE_TOKEN_USD_MASK = bytes32(uint256(1));
    bytes32 internal constant IS_BASE_TOKEN_ETH_MASK = bytes32(uint256(2));

    function isBaseTokenUSD(bytes32 factoryTokenSettings) internal pure returns (bool isBaseTokenUSD_) {
        isBaseTokenUSD_ = (factoryTokenSettings & IS_BASE_TOKEN_USD_MASK) != 0;
    }

    function isBaseTokenETH(bytes32 factoryTokenSettings) internal pure returns (bool isBaseTokenETH_) {
        isBaseTokenETH_ = (factoryTokenSettings & IS_BASE_TOKEN_ETH_MASK) != 0;
    }

}
