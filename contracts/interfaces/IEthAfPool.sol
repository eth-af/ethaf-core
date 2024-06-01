// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0;

import './pool/IEthAfPoolImmutables.sol';
import './pool/IEthAfPoolState.sol';
import './pool/IEthAfPoolDerivedState.sol';
import './pool/IEthAfPoolActions.sol';
import './pool/IEthAfPoolOwnerActions.sol';
import './pool/IEthAfPoolEvents.sol';

/// @title The interface for a ETH AF Pool
/// @notice A ETH AF pool facilitates swapping and automated market making between any two assets that strictly conform
/// to the ERC20 specification
/// @dev The pool interface is broken up into many smaller pieces
interface IEthAfPool is
    IEthAfPoolImmutables,
    IEthAfPoolState,
    IEthAfPoolDerivedState,
    IEthAfPoolActions,
    IEthAfPoolOwnerActions,
    IEthAfPoolEvents
{

}
