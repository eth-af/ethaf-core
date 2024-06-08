// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;
pragma abicoder v2;

import './libraries/TransferHelper.sol';
import './libraries/TickMath.sol';
import './interfaces/IEthAfFactory.sol';
import './interfaces/IERC20Minimal.sol';
import './interfaces/IEthAfPool.sol';
import './interfaces/callback/IEthAfSwapCallback.sol';
import './interfaces/callback/IEthAfFlashCallback.sol';


/// @title Canonical ETH AF factory
/// @notice Deploys ETH AF pools and manages ownership and control over pool protocol fees
contract EthAfSwapFeeDistributor is IEthAfSwapCallback, IEthAfFlashCallback {
    // / @inheritdoc IEthAfFactory
    address public owner;
    // / @inheritdoc IEthAfFactory
    address public immutable factory;


    /// @notice Emitted when the owner of the factory is changed
    /// @param oldOwner The owner before the owner was changed
    /// @param newOwner The owner after the owner was changed
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    constructor(
        address _factory
    ) {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);

        factory = _factory;
    }

    function distributeFeesForPool(address pool) external {
        // collect the tokens from the pool
        (address token0, address token1, bool isBaseToken0, bool isBaseToken1) =
            IEthAfPool(pool).collectBaseToken();
        // check balances
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        if(balance0 == 0 && balance1 == 0) return; // early exit
        // swap 0 for 1
        if(isBaseToken0 && !isBaseToken1 && balance0 > 0) {
            IEthAfPool(pool).swap(
                address(this),
                true,
                int256(balance0),
                TickMath.MIN_SQRT_RATIO+1,
                ""
            );
        }
        // swap 1 for 0
        if(isBaseToken1 && !isBaseToken0 && balance1 > 0) {
            IEthAfPool(pool).swap(
                address(this),
                false,
                int256(balance1),
                TickMath.MAX_SQRT_RATIO-1,
                ""
            );
        }
        // check balances again
        balance0 = IERC20Minimal(token0).balanceOf(address(this));
        balance1 = IERC20Minimal(token1).balanceOf(address(this));
        // distribute fees via flash
        if(balance0 > 0 || balance1 > 0) {
            IEthAfPool(pool).flash(address(this), 0, 0, "");
        }
    }

    /// @notice Called by the pool during a swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    function ethafSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        // safe to assume msg.sender is a pool - this contract should not hold tokens between txs

        // if we owe token0
        if(amount0Delta > 0) {
            address token0 = IEthAfPool(msg.sender).token0();
            TransferHelper.safeTransfer(token0, msg.sender, uint256(amount0Delta));
        }
        // if we owe token1
        if(amount1Delta > 0) {
            address token1 = IEthAfPool(msg.sender).token1();
            TransferHelper.safeTransfer(token1, msg.sender, uint256(amount1Delta));
        }
    }

    /// @notice Called by the pool during a flash loan.
    function ethafFlashCallback(uint256, uint256, bytes calldata) external override {
        // safe to assume msg.sender is a pool - this contract should not hold tokens between txs

        // use this to distribute the rewards
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
