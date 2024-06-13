// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.7.6;
pragma abicoder v2;

import './../interfaces/pool/IEthAfPoolEvents.sol';

import './../libraries/LowGasSafeMath.sol';
import './../libraries/SafeCast.sol';
import './../libraries/Tick.sol';
import './../libraries/TickBitmap.sol';
import './../libraries/Position.sol';
import './../libraries/Oracle.sol';

import './../libraries/TransferHelper.sol';

import './../interfaces/IERC20Minimal.sol';

import './../libraries/PoolTokenSettings.sol';

import './../interfaces/external/Blast/IBlast.sol';
import './../interfaces/external/Blast/IBlastPoints.sol';
import './../interfaces/external/Blast/IERC20Rebasing.sol';
import './../interfaces/modules/IEthAfPoolCollectModule.sol';


/// @title The ETH AF Pool Collect Module
/// @notice The ETH AF pool collect module contains the logic for collect and collectBaseToken
/// @dev Do NOT call this contract directly. The EthAfPools delegate call into this module
contract EthAfPoolCollectModule is IEthAfPoolCollectModule, IEthAfPoolEvents {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    struct Slot0 {
        // the current price
        uint160 sqrtPriceX96;
        // the current tick
        int24 tick;
        // the most-recently updated index of the observations array
        uint16 observationIndex;
        // the current maximum number of observations that are being stored
        uint16 observationCardinality;
        // the next maximum number of observations to store, triggered in observations.write
        uint16 observationCardinalityNext;
        // the current protocol fee as a percentage of the swap fee taken on withdrawal
        // represented as an integer denominator (1/x)%
        uint8 feeProtocol;
        // whether the pool is locked
        bool unlocked;
    }

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }

    // accumalated base tokens in token0/token1 units
    struct BaseTokensAccumulated {
        uint256 amount0;
        uint256 amount1;
    }

    // storage slots
    bytes32 internal constant SLOT_0_SLOT                  = bytes32(uint256(0));
    bytes32 internal constant FEE_GROWTH_GLOBAL_0_SLOT     = bytes32(uint256(1));
    bytes32 internal constant FEE_GROWTH_GLOBAL_1_SLOT     = bytes32(uint256(2));
    bytes32 internal constant PROTOCOL_FEES_SLOT           = bytes32(uint256(3));
    bytes32 internal constant LIQUIDITY_SLOT               = bytes32(uint256(4));
    bytes32 internal constant TICKS_SLOT                   = bytes32(uint256(5));
    bytes32 internal constant TICK_BITMAP_SLOT             = bytes32(uint256(6));
    bytes32 internal constant POSITIONS_SLOT               = bytes32(uint256(7));
    bytes32 internal constant OBSERVATIONS_SLOT            = bytes32(uint256(8));
    bytes32 internal constant BASE_TOKENS_ACCUMULATED_SLOT = keccak256("ethaf.pool.storage.basetokenacc");

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
    // these may or may not have the same signature as the related function on the pool

    function collect(
        CollectParams memory params
    ) external override returns (uint128 amount0, uint128 amount1) {
        // we don't need to checkTicks here, because invalid positions will never have non-zero tokensOwed{0,1}
        Position.Info storage position = getPositions().get(msg.sender, params.tickLower, params.tickUpper);

        amount0 = params.amount0Requested > position.tokensOwed0 ? position.tokensOwed0 : params.amount0Requested;
        amount1 = params.amount1Requested > position.tokensOwed1 ? position.tokensOwed1 : params.amount1Requested;

        if (amount0 > 0) {
            position.tokensOwed0 -= amount0;
            TransferHelper.safeTransfer(params.token0, params.recipient, amount0);
        }
        if (amount1 > 0) {
            position.tokensOwed1 -= amount1;
            TransferHelper.safeTransfer(params.token1, params.recipient, amount1);
        }

        emit Collect(msg.sender, params.recipient, params.tickLower, params.tickUpper, amount0, amount1);
    }


    function collectBaseToken(
        address recipient,
        address token0,
        address token1,
        bytes32 settings
    ) external override {
        BaseTokensAccumulated storage _baseTokensAcc = getBaseTokensAccumulated();
        uint256 amount0 = _baseTokensAcc.amount0;
        uint256 amount1 = _baseTokensAcc.amount1;

        bool token0SupportsNativeYield = PoolTokenSettings.token0SupportsNativeYield(settings);
        if(token0SupportsNativeYield) {
            uint256 claimableAmount = IERC20Rebasing(token0).getClaimableAmount(address(this));
            if(claimableAmount > 0) {
                uint256 bal1 = getTokenBalance(token0);
                IERC20Rebasing(token0).claim(address(this), claimableAmount);
                uint256 diff = getTokenBalance(token0) - bal1;
                if(diff > 0) amount0 += diff;
            }
        }
        if(amount0 > 0) {
            TransferHelper.safeTransfer(token0, recipient, amount0);
            _baseTokensAcc.amount0 = 0;
        }

        bool token1SupportsNativeYield = PoolTokenSettings.token1SupportsNativeYield(settings);
        if(token1SupportsNativeYield) {
            uint256 claimableAmount = IERC20Rebasing(token1).getClaimableAmount(address(this));
            if(claimableAmount > 0) {
                uint256 bal1 = getTokenBalance(token1);
                IERC20Rebasing(token1).claim(address(this), claimableAmount);
                uint256 diff = getTokenBalance(token1) - bal1;
                if(diff > 0) amount1 += diff;
            }
        }
        if(amount1 > 0) {
            TransferHelper.safeTransfer(token1, recipient, amount1);
            _baseTokensAcc.amount1 = 0;
        }
    }

    // helper functions

    /// @dev Gets the erc20 balance of token held by the pool
    function getTokenBalance(address token) private view returns (uint256) {
        (bool success, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        require(success && data.length >= 32);
        return abi.decode(data, (uint256));
    }

    // dev: these are required because the module cannot access the global storage variables by name

    /// @dev Gets the storage pointer for positions
    function getPositions() internal pure returns (mapping(bytes32 => Position.Info) storage _positions) {
        bytes32 position = POSITIONS_SLOT;
        assembly {
            _positions.slot := position
        }
    }

    /// @dev Gets the storage pointer for baseTokensAccumulated
    function getBaseTokensAccumulated() internal pure returns (BaseTokensAccumulated storage _baseTokensAcc) {
        bytes32 position = BASE_TOKENS_ACCUMULATED_SLOT;
        assembly {
            _baseTokensAcc.slot := position
        }
    }
}
