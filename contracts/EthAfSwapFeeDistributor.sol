// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import './libraries/TransferHelper.sol';
import './libraries/TickMath.sol';
import './interfaces/IEthAfFactory.sol';
import './interfaces/IERC20Minimal.sol';
import './interfaces/IEthAfPool.sol';
import './interfaces/IEthAfSwapFeeDistributor.sol';
import './interfaces/callback/IEthAfSwapCallback.sol';
import './interfaces/callback/IEthAfFlashCallback.sol';

import './interfaces/external/Blast/IBlast.sol';
import './interfaces/external/Blast/IBlastPoints.sol';


/// @title EthAfSwapFeeDistributor
/// @notice Distributes the swap fees of EthAfPools
contract EthAfSwapFeeDistributor is IEthAfSwapFeeDistributor, IEthAfSwapCallback, IEthAfFlashCallback {
    // / @inheritdoc IEthAfFactory
    address public override owner;
    // / @inheritdoc IEthAfFactory
    address public immutable override factory;

    // used for looping
    uint256 public override nextPoolIndex;
    uint256 public override safeGasStartLoop;
    uint256 public override safeGasForDistribute;

    constructor(
        address _factory,
        address blast,
        address blastPoints,
        address gasCollector,
        address pointsOperator
    ) {
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);

        factory = _factory;

        safeGasStartLoop = 330_000; // safe limits found from tests
        safeGasForDistribute = 300_000;

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

    // distribute functions

    function distributeFeesForPool(address pool) external override {
        _distributeFeesForPool(pool);
    }

    function distributeFeesForPools(address[] calldata pools) external override {
        for(uint256 i = 0; i < pools.length; i++) {
            _distributeFeesForPool(pools[i]);
        }
    }

    function tryDistributeFeesForPool(address pool) external override returns (bool success) {
        success = _tryDistributeFeesForPool(pool);
    }

    function tryDistributeFeesForPools(address[] calldata pools) external override returns (bool[] memory success) {
        success = new bool[](pools.length);
        for(uint256 i = 0; i < pools.length; i++) {
            success[i] = _tryDistributeFeesForPool(pools[i]);
        }
    }

    function tryDistributeFactoryLoop() external override {
        uint256 next = nextPoolIndex;
        uint256 gasLimitStart = safeGasStartLoop;
        uint256 gasLimitDistribute = safeGasForDistribute;
        uint256 len = IEthAfFactory(factory).allPoolsLength();
        // loop while there is gas left
        while(gasleft() > gasLimitStart) {
            // end and reset if out of bounds
            if(next >= len) {
                nextPoolIndex = 0;
                return;
            }
            _tryDistributeFeesForPool(IEthAfFactory(factory).allPools(next), gasLimitDistribute);
            ++next;
        }
        nextPoolIndex = next;
    }

    // executes collect -> swap -> flash to distribute rewards
    function _distributeFeesForPool(address pool) internal {
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
        emit SwapFeesDistributed(pool);
    }

    // helper functions

    function _tryDistributeFeesForPool(address pool) internal returns (bool success) {
        // self call, allow to fail

        // encode calldata
        bytes memory data = abi.encodeWithSelector(EthAfSwapFeeDistributor.distributeFeesForPool.selector, pool);
        // call self
        (success, ) = address(this).call(data);
    }

    function _tryDistributeFeesForPool(address pool, uint256 gaslimit) internal returns (bool success) {
        // self call, allow to fail

        // encode calldata
        bytes memory data = abi.encodeWithSelector(EthAfSwapFeeDistributor.distributeFeesForPool.selector, pool);
        // call self
        (success, ) = address(this).call{gas: gaslimit}(data);
    }

    // callbacks

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

    // owner functions

    function setSafeGasPerLoop(uint256 gasLimitStart, uint256 gasLimitDistribute) external override {
        require(msg.sender == owner);
        safeGasStartLoop = gasLimitStart;
        safeGasForDistribute = gasLimitDistribute;
        emit SetSafeGasPerLoop(gasLimitStart, gasLimitDistribute);
    }
}
