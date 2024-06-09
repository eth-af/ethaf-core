// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.4.0;

/// @title PoolTokenSettings
/// @notice A library for storing constants for token settings
library PoolTokenSettings {

    // to be used in pool

    // the pool stores token settings that it uses to determine which token if any is the base token
    // if there is no base token, it behaves as a regular uniswap v3 pool
    // if there is a base token, the fees collected in that token are not rewarded to LPs
    // instead they are collected, swapped for more of the pump token, and rewarded to LPs
    // the token settings are calculated and stored on pool creation and cannot be changed

    bytes32 internal constant IS_TOKEN0_BASE_TOKEN_MASK = bytes32(uint256(1));
    bytes32 internal constant IS_TOKEN1_BASE_TOKEN_MASK = bytes32(uint256(2));

    function isBaseToken0(bytes32 poolTokenSettings) internal pure returns (bool isBaseToken0_) {
      isBaseToken0_ = (poolTokenSettings & IS_TOKEN0_BASE_TOKEN_MASK) != 0;
    }

    function isBaseToken1(bytes32 poolTokenSettings) internal pure returns (bool isBaseToken1_) {
      isBaseToken1_ = (poolTokenSettings & IS_TOKEN1_BASE_TOKEN_MASK) != 0;
    }

}
