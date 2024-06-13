// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import './interfaces/IEthAfPool.sol';

import './NoDelegateCall.sol';

import './libraries/LowGasSafeMath.sol';
import './libraries/SafeCast.sol';
import './libraries/Tick.sol';
import './libraries/TickBitmap.sol';
import './libraries/Position.sol';
import './libraries/Oracle.sol';

import './libraries/TickMath.sol';

import './interfaces/IEthAfFactory.sol';

import './libraries/PoolTokenSettings.sol';

import './interfaces/external/Blast/IBlast.sol';
import './interfaces/external/Blast/IBlastPoints.sol';
import './interfaces/external/Blast/IERC20Rebasing.sol';

import './interfaces/modules/IEthAfPoolCollectModule.sol';
import './interfaces/modules/IEthAfPoolActionsModule.sol';
import './interfaces/modules/IEthAfPoolProtocolFeeModule.sol';


/// @title The ETH AF Pool
/// @notice A ETH AF pool facilitates swapping and automated market making between any two assets that strictly conform
/// to the ERC20 or ERC20Rebasing specification
contract EthAfPool is IEthAfPool, NoDelegateCall {
    using LowGasSafeMath for uint256;
    using LowGasSafeMath for int256;
    using SafeCast for uint256;
    using SafeCast for int256;
    using Tick for mapping(int24 => Tick.Info);
    using TickBitmap for mapping(int16 => uint256);
    using Position for mapping(bytes32 => Position.Info);
    using Position for Position.Info;
    using Oracle for Oracle.Observation[65535];

    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override factory;
    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override token0;
    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override token1;
    /// @inheritdoc IEthAfPoolImmutables
    uint24 public immutable override fee;

    /// @inheritdoc IEthAfPoolImmutables
    int24 public immutable override tickSpacing;

    /// @inheritdoc IEthAfPoolImmutables
    uint128 public immutable override maxLiquidityPerTick;

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
    /// @inheritdoc IEthAfPoolState
    Slot0 public override slot0;

    /// @inheritdoc IEthAfPoolState
    uint256 public override feeGrowthGlobal0X128;
    /// @inheritdoc IEthAfPoolState
    uint256 public override feeGrowthGlobal1X128;

    // accumulated protocol fees in token0/token1 units
    struct ProtocolFees {
        uint128 token0;
        uint128 token1;
    }
    /// @inheritdoc IEthAfPoolState
    ProtocolFees public override protocolFees;

    /// @inheritdoc IEthAfPoolState
    uint128 public override liquidity;

    /// @inheritdoc IEthAfPoolState
    mapping(int24 => Tick.Info) public override ticks;
    /// @inheritdoc IEthAfPoolState
    mapping(int16 => uint256) public override tickBitmap;
    /// @inheritdoc IEthAfPoolState
    mapping(bytes32 => Position.Info) public override positions;
    /// @inheritdoc IEthAfPoolState
    Oracle.Observation[65535] public override observations;

    /// @inheritdoc IEthAfPoolImmutables
    bytes32 public immutable override poolTokenSettings;
    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override actionsModule;
    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override collectModule;
    /// @inheritdoc IEthAfPoolImmutables
    address public immutable override protocolModule;

    // accumalated base tokens in token0/token1 units
    struct BaseTokensAccumulated {
        uint256 amount0;
        uint256 amount1;
    }

    // storage slots
    bytes32 internal constant BASE_TOKENS_ACCUMULATED_SLOT = keccak256("ethaf.pool.storage.basetokenacc");

    /// @dev Mutually exclusive reentrancy protection into the pool to/from a method. This method also prevents entrance
    /// to a function before the pool is initialized. The reentrancy guard is required throughout the contract because
    /// we use balance checks to determine the payment status of interactions such as mint, swap and flash.
    modifier lock() {
        require(slot0.unlocked, 'LOK');
        slot0.unlocked = false;
        _;
        slot0.unlocked = true;
    }

    /// @dev Prevents calling a function from anyone except the address returned by IEthAfFactory#owner()
    modifier onlyFactoryOwner() {
        require(msg.sender == IEthAfFactory(factory).owner());
        _;
    }

    // constructor

    constructor() {
        int24 _tickSpacing;
        address tkn0;
        address tkn1;
        bytes32 _poolTokenSettings;

        (
            factory,
            tkn0,
            tkn1,
            fee,
            _tickSpacing,
            _poolTokenSettings
        ) = IEthAfFactory(msg.sender).parameters();
        token0 = tkn0;
        token1 = tkn1;
        tickSpacing = _tickSpacing;
        maxLiquidityPerTick = Tick.tickSpacingToMaxLiquidityPerTick(_tickSpacing);
        poolTokenSettings = _poolTokenSettings;

        bool isBaseToken0 = PoolTokenSettings.isBaseToken0(_poolTokenSettings);
        bool isBaseToken1 = PoolTokenSettings.isBaseToken1(_poolTokenSettings);
        require(!(isBaseToken0 && isBaseToken1)); // cannot both be base tokens

        if(PoolTokenSettings.token0SupportsNativeYield(_poolTokenSettings)) {
            IERC20Rebasing(tkn0).configure(IERC20Rebasing.YieldMode.CLAIMABLE);
        }
        if(PoolTokenSettings.token1SupportsNativeYield(_poolTokenSettings)) {
            IERC20Rebasing(tkn1).configure(IERC20Rebasing.YieldMode.CLAIMABLE);
        }

        {
        (actionsModule, collectModule, protocolModule) = IEthAfFactory(msg.sender).moduleParameters();
        }

        {
        (
            address blast,
            address blastPoints,
            address gasCollector,
            address pointsOperator
        ) = IEthAfFactory(msg.sender).blastParameters();
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
    }

    // view functions

    /// @inheritdoc IEthAfPoolDerivedState
    function snapshotCumulativesInside(int24 tickLower, int24 tickUpper)
        external
        view
        override
        noDelegateCall
        returns (
            int56 tickCumulativeInside,
            uint160 secondsPerLiquidityInsideX128,
            uint32 secondsInside
        )
    {
        checkTicks(tickLower, tickUpper);

        int56 tickCumulativeLower;
        int56 tickCumulativeUpper;
        uint160 secondsPerLiquidityOutsideLowerX128;
        uint160 secondsPerLiquidityOutsideUpperX128;
        uint32 secondsOutsideLower;
        uint32 secondsOutsideUpper;

        {
            Tick.Info storage lower = ticks[tickLower];
            Tick.Info storage upper = ticks[tickUpper];
            bool initializedLower;
            (tickCumulativeLower, secondsPerLiquidityOutsideLowerX128, secondsOutsideLower, initializedLower) = (
                lower.tickCumulativeOutside,
                lower.secondsPerLiquidityOutsideX128,
                lower.secondsOutside,
                lower.initialized
            );
            require(initializedLower);

            bool initializedUpper;
            (tickCumulativeUpper, secondsPerLiquidityOutsideUpperX128, secondsOutsideUpper, initializedUpper) = (
                upper.tickCumulativeOutside,
                upper.secondsPerLiquidityOutsideX128,
                upper.secondsOutside,
                upper.initialized
            );
            require(initializedUpper);
        }

        Slot0 memory _slot0 = slot0;

        if (_slot0.tick < tickLower) {
            return (
                tickCumulativeLower - tickCumulativeUpper,
                secondsPerLiquidityOutsideLowerX128 - secondsPerLiquidityOutsideUpperX128,
                secondsOutsideLower - secondsOutsideUpper
            );
        } else if (_slot0.tick < tickUpper) {
            uint32 time = _blockTimestamp();
            (int56 tickCumulative, uint160 secondsPerLiquidityCumulativeX128) =
                observations.observeSingle(
                    time,
                    0,
                    _slot0.tick,
                    _slot0.observationIndex,
                    liquidity,
                    _slot0.observationCardinality
                );
            return (
                tickCumulative - tickCumulativeLower - tickCumulativeUpper,
                secondsPerLiquidityCumulativeX128 -
                    secondsPerLiquidityOutsideLowerX128 -
                    secondsPerLiquidityOutsideUpperX128,
                time - secondsOutsideLower - secondsOutsideUpper
            );
        } else {
            return (
                tickCumulativeUpper - tickCumulativeLower,
                secondsPerLiquidityOutsideUpperX128 - secondsPerLiquidityOutsideLowerX128,
                secondsOutsideUpper - secondsOutsideLower
            );
        }
    }

    /// @inheritdoc IEthAfPoolDerivedState
    function observe(uint32[] calldata secondsAgos)
        external
        view
        override
        noDelegateCall
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        return
            observations.observe(
                _blockTimestamp(),
                secondsAgos,
                slot0.tick,
                slot0.observationIndex,
                liquidity,
                slot0.observationCardinality
            );
    }

    // action functions

    /// @inheritdoc IEthAfPoolActions
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext)
        external
        override
        lock
        noDelegateCall
    {
        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(IEthAfPoolActionsModule.increaseObservationCardinalityNext.selector, observationCardinalityNext);
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
    }

    /// @inheritdoc IEthAfPoolActions
    /// @dev not locked because it initializes unlocked
    function initialize(uint160 sqrtPriceX96) external override noDelegateCall  {
        // encode calldata
        uint32 timestamp = _blockTimestamp();
        bytes memory calldata_ = abi.encodeWithSelector(IEthAfPoolActionsModule.initialize.selector, sqrtPriceX96, timestamp);
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);

    }

    /// @inheritdoc IEthAfPoolActions
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external override lock noDelegateCall returns (uint256 amount0, uint256 amount1) {
        // encode calldata
        uint32 timestamp = _blockTimestamp();
        bytes memory calldata_ = abi.encodeWithSelector(
            IEthAfPoolActionsModule.mint.selector,
            IEthAfPoolActionsModule.MintParams({
                recipient: recipient,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount: amount,
                token0: token0,
                token1: token1,
                data: data,
                timestamp: timestamp,
                tickSpacing: tickSpacing,
                maxLiquidityPerTick: maxLiquidityPerTick
            })
        );
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
        // decode result
        (amount0, amount1) = abi.decode(returndata, (uint256, uint256));
    }

    /// @inheritdoc IEthAfPoolActions
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external override lock noDelegateCall returns (uint128 amount0, uint128 amount1) {
        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(
            IEthAfPoolCollectModule.collect.selector,
            IEthAfPoolCollectModule.CollectParams({
                recipient: recipient,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Requested: amount0Requested,
                amount1Requested: amount1Requested,
                token0: token0,
                token1: token1
            })
        );
        // delegatecall into the pool collect module
        (bool success, bytes memory returndata) = collectModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
        // decode result
        (amount0, amount1) = abi.decode(returndata, (uint128, uint128));
    }

    /// @inheritdoc IEthAfPoolActions
    /// @dev noDelegateCall is applied indirectly via _modifyPosition
    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external override lock noDelegateCall returns (uint256 amount0, uint256 amount1) {
        // encode calldata
        uint32 timestamp = _blockTimestamp();
        bytes memory calldata_ = abi.encodeWithSelector(
            IEthAfPoolActionsModule.burn.selector,
            IEthAfPoolActionsModule.BurnParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount: amount,
                timestamp: timestamp,
                tickSpacing: tickSpacing,
                maxLiquidityPerTick: maxLiquidityPerTick
            })
        );
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
        // decode result
        (amount0, amount1) = abi.decode(returndata, (uint256, uint256));
    }

    /// @inheritdoc IEthAfPoolActions
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external override noDelegateCall returns (int256 amount0, int256 amount1) {
        // encode calldata
        uint32 time = _blockTimestamp();
        bytes32 settings = poolTokenSettings;
        bool isBaseToken0 = PoolTokenSettings.isBaseToken0(settings);
        bool isBaseToken1 = PoolTokenSettings.isBaseToken1(settings);
        bytes memory calldata_ = abi.encodeWithSelector(
            IEthAfPoolActionsModule.swap.selector,
            IEthAfPoolActionsModule.SwapParams({
                recipient: recipient,
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: sqrtPriceLimitX96,
                fee: fee,
                token0: token0,
                token1: token1,
                timestamp: time,
                data: data,
                isBaseToken0: isBaseToken0,
                isBaseToken1: isBaseToken1,
                tickSpacing: tickSpacing
            })
        );
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
        // decode result
        (amount0, amount1) = abi.decode(returndata, (int256, int256));
    }

    /// @inheritdoc IEthAfPoolActions
    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override lock noDelegateCall {
        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(
            IEthAfPoolActionsModule.flash.selector,
            IEthAfPoolActionsModule.FlashParams({
                recipient: recipient,
                amount0: amount0,
                amount1: amount1,
                token0: token0,
                token1: token1,
                fee: fee,
                data: data,
                poolTokenSettings: poolTokenSettings
            })
        );
        // delegatecall into the pool actions module
        (bool success, bytes memory returndata) = actionsModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
    }

    /// @inheritdoc IEthAfPoolActions
    function collectBaseToken() external override lock returns (
        address token0_,
        address token1_,
        bool isBaseToken0,
        bool isBaseToken1
    ) {
        address distributor = IEthAfFactory(factory).swapFeeDistributor();
        require(msg.sender == distributor);

        token0_ = token0;
        token1_ = token1;

        bytes32 settings = poolTokenSettings;
        isBaseToken0 = PoolTokenSettings.isBaseToken0(settings);
        isBaseToken1 = PoolTokenSettings.isBaseToken1(settings);

        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(IEthAfPoolCollectModule.collectBaseToken.selector, distributor, token0_, token1_, settings);
        // delegatecall into the pool collect module
        (bool success, bytes memory returndata) = collectModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
    }

    // owner actions

    /// @inheritdoc IEthAfPoolOwnerActions
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external override lock onlyFactoryOwner {
        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(IEthAfPoolProtocolFeeModule.setFeeProtocol.selector, feeProtocol0, feeProtocol1);
        // delegatecall into the pool protocol module
        (bool success, bytes memory returndata) = protocolModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
    }

    /// @inheritdoc IEthAfPoolOwnerActions
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external override lock onlyFactoryOwner returns (uint128 amount0, uint128 amount1) {
        // encode calldata
        bytes memory calldata_ = abi.encodeWithSelector(IEthAfPoolProtocolFeeModule.collectProtocol.selector, recipient, amount0Requested, amount1Requested, token0, token1);
        // delegatecall into the pool protocol module
        (bool success, bytes memory returndata) = protocolModule.delegatecall(calldata_);
        // check success
        _requireSuccess(success, returndata);
        // decode result
        (amount0, amount1) = abi.decode(returndata, (uint128, uint128));
    }

    // added view functions

    function getPoolTokenSettings() external view override returns (
        bool isBaseToken0,
        bool isBaseToken1
    ) {
        bytes32 settings = poolTokenSettings;
        isBaseToken0 = PoolTokenSettings.isBaseToken0(settings);
        isBaseToken1 = PoolTokenSettings.isBaseToken1(settings);
    }

    function getPoolTokenSettingsFull() public view returns (
        bool isBaseToken0,
        bool isBaseToken1,
        bool token0SupportsNativeYield,
        bool token1SupportsNativeYield
    ) {
        bytes32 settings = poolTokenSettings;
        isBaseToken0 = PoolTokenSettings.isBaseToken0(settings);
        isBaseToken1 = PoolTokenSettings.isBaseToken1(settings);
        token0SupportsNativeYield = PoolTokenSettings.token0SupportsNativeYield(settings);
        token1SupportsNativeYield = PoolTokenSettings.token1SupportsNativeYield(settings);
    }

    function baseTokensAccumulated() external view returns (uint256 amount0, uint256 amount1) {
        BaseTokensAccumulated storage _baseTokensAcc = getBaseTokensAccumulated();
        amount0 = _baseTokensAcc.amount0;
        amount1 = _baseTokensAcc.amount1;
    }

    // helper functions

    /// @dev Common checks for valid tick inputs.
    function checkTicks(int24 tickLower, int24 tickUpper) private pure {
        require(tickLower < tickUpper, 'TLU');
        require(tickLower >= TickMath.MIN_TICK, 'TLM');
        require(tickUpper <= TickMath.MAX_TICK, 'TUM');
    }

    /// @dev Returns the block timestamp truncated to 32 bits, i.e. mod 2**32. This method is overridden in tests.
    function _blockTimestamp() internal view virtual returns (uint32) {
        return uint32(block.timestamp); // truncation is desired
    }

    /// @dev Requires a call to be successful, otherwise reverts
    function _requireSuccess(bool success, bytes memory data) internal pure {
        if(!success) {
            // look for revert reason and bubble it up if present
            if(data.length > 0) {
                // the easiest way to bubble the revert reason is using memory via assembly
                assembly {
                    let data_size := mload(data)
                    revert(add(32, data), data_size)
                }
            } else {
                revert();
            }
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
