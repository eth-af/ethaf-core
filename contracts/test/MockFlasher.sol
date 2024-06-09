// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../interfaces/IEthAfPool.sol';
import '../interfaces/callback/IEthAfFlashCallback.sol';
import '../interfaces/IERC20Minimal.sol';
import '../libraries/TransferHelper.sol';

// used for testing flash with base tokens
contract MockFlasher is IEthAfFlashCallback {

    function flash(
        address pool,
        uint256 amount0,
        uint256 amount1
    ) external {
        IEthAfPool(pool).flash(address(this), amount0, amount1, "");
    }

    /// @notice Called to `msg.sender` after transferring to the recipient from IEthAfPool#flash.
    /// @dev In the implementation you must repay the pool the tokens sent by flash plus the computed fee amounts.
    /// The caller of this method must be checked to be a EthAfPool deployed by the canonical EthAfFactory.
    function ethafFlashCallback(
        uint256,
        uint256,
        bytes calldata
    ) external override {
        // transfer in entire token0 balance
        address token = IEthAfPool(msg.sender).token0();
        uint256 balance = IERC20Minimal(token).balanceOf(address(this));
        if(balance > 0) {
            TransferHelper.safeTransfer(token, msg.sender, balance);
        }
        // transfer in entire token1 balance
        token = IEthAfPool(msg.sender).token1();
        balance = IERC20Minimal(token).balanceOf(address(this));
        if(balance > 0) {
            TransferHelper.safeTransfer(token, msg.sender, balance);
        }
    }
}
