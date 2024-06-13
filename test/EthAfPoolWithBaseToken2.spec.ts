import { BigNumber, BigNumberish, Wallet, ContractTransaction } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { EthAfFactory } from '../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../typechain/EthAfPoolDeployerModule'
import { EthAfPoolActionsModule } from '../typechain/EthAfPoolActionsModule'
import { EthAfPoolCollectModule } from '../typechain/EthAfPoolCollectModule'
import { EthAfPoolProtocolFeeModule } from '../typechain/EthAfPoolProtocolFeeModule'
import { EthAfSwapFeeDistributor } from '../typechain/EthAfSwapFeeDistributor'
import { EthAfPool } from '../typechain/EthAfPool'
import { TestERC20 } from '../typechain/TestERC20'
import { TestEthAfCallee } from '../typechain/TestEthAfCallee'
import { MockBlast } from '../typechain/MockBlast'
import { MockBlastPoints } from '../typechain/MockBlastPoints'
import { expect } from './shared/expect'
import snapshotGasCost from './shared/snapshotGasCost'
const { formatUnits } = ethers.utils
const { WeiPerEther } = ethers.constants

import {
  FeeAmount,
  getCreate2Address,
  TICK_SPACINGS,
  encodePriceSqrt,
  expandTo18Decimals,
  getMaxTick,
  getMinTick,
  createPoolFunctions,
  getPositionKey,
  MaxUint128,
} from './shared/utilities'
import { toBytes32 } from './../scripts/utils/strings'
import { poolFixture, TEST_POOL_START_TIME } from './shared/fixtures'
import { FactoryTokenSettings, PoolTokenSettings } from './shared/tokenSettings'

const { constants } = ethers
const { AddressZero } = constants

const TEST_ADDRESSES: [string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
]

const createFixtureLoader = waffle.createFixtureLoader

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T
type PoolFunctions = ReturnType<typeof createPoolFunctions>

const sqrtPriceX96Initial = encodePriceSqrt(1, 1)

describe('EthAfPoolWithBaseToken2', () => {
  let wallet: Wallet, other: Wallet

  let factory: EthAfFactory
  let poolDeployerModule: EthAfPoolDeployerModule
  let swapFeeDistributor: EthAfSwapFeeDistributor
  let poolBytecode: string

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let swapTargetCallee: TestEthAfCallee

  let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  const fixture = async () => {
    const mockBlastFactory = await ethers.getContractFactory('MockBlast')
    const mockBlast = (await mockBlastFactory.deploy()) as MockBlast
    const mockBlastPointsFactory = await ethers.getContractFactory('MockBlastPoints')
    const mockBlastPoints = (await mockBlastPointsFactory.deploy()) as MockBlastPoints

    const poolDeployerModuleFactory = await ethers.getContractFactory('EthAfPoolDeployerModule')
    const poolDeployerModule = (await poolDeployerModuleFactory.deploy(mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfPoolDeployerModule
    const poolActionsModuleFactory = await ethers.getContractFactory('EthAfPoolActionsModule')
    const poolActionsModule = (await poolActionsModuleFactory.deploy(mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfPoolActionsModule
    const poolCollectModuleFactory = await ethers.getContractFactory('EthAfPoolCollectModule')
    const poolCollectModule = (await poolCollectModuleFactory.deploy(mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfPoolCollectModule
    const poolProtocolModuleFactory = await ethers.getContractFactory('EthAfPoolProtocolFeeModule')
    const poolProtocolModule = (await poolProtocolModuleFactory.deploy(mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfPoolProtocolFeeModule
    const factoryFactory = await ethers.getContractFactory('EthAfFactory')
    const factory = (await factoryFactory.deploy(poolDeployerModule.address, poolActionsModule.address, poolCollectModule.address, poolProtocolModule.address, mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfFactory
    const swapFeeDistributorFactory = await ethers.getContractFactory('EthAfSwapFeeDistributor')
    const swapFeeDistributor = (await swapFeeDistributorFactory.deploy(factory.address)) as EthAfSwapFeeDistributor
    await factory.setSwapFeeDistributor(swapFeeDistributor.address)
    return { factory, poolDeployerModule, swapFeeDistributor }
  }

  let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet, other])
  })

  before('load pool bytecode', async () => {
    poolBytecode = (await ethers.getContractFactory('EthAfPool')).bytecode
  })

  beforeEach('deploy factory', async () => {
    let fixtureResponse = await loadFixture(poolFixture)
    factory = fixtureResponse.factory
    poolDeployerModule = fixtureResponse.poolDeployerModule
    swapFeeDistributor = fixtureResponse.swapFeeDistributor
    token0 = fixtureResponse.token0
    token1 = fixtureResponse.token1
    token2 = fixtureResponse.token2
    createPool = fixtureResponse.createPool
    swapTargetCallee = fixtureResponse.swapTargetCallee
    //({ token0, token1, token2, factory, createPool, swapTargetCallee: swapTarget } = await loadFixture(poolFixture))
  })

  it('swap fee distributor is set correctly', async () => {
    const addr = await factory.swapFeeDistributor()
    expect(swapFeeDistributor.address).to.eq(addr)
  })

  async function createAndCheckPool(
    tokens: [string, string],
    feeAmount: FeeAmount,
    tickSpacing: number = TICK_SPACINGS[feeAmount],
    expectedPoolTokenSettings:any = undefined
  ) {
    const create2Address = getCreate2Address(factory.address, tokens, feeAmount, poolBytecode)
    const create = factory.createPool(tokens[0], tokens[1], feeAmount)

    await expect(create)
      .to.emit(factory, 'PoolCreated')
      .withArgs(tokens[0], tokens[1], feeAmount, tickSpacing, create2Address)

    await expect(factory.createPool(tokens[0], tokens[1], feeAmount)).to.be.reverted
    await expect(factory.createPool(tokens[1], tokens[0], feeAmount)).to.be.reverted
    expect(await factory.getPool(tokens[0], tokens[1], feeAmount), 'getPool in order').to.eq(create2Address)
    expect(await factory.getPool(tokens[1], tokens[0], feeAmount), 'getPool in reverse').to.eq(create2Address)

    expect(await factory.allPoolsLength()).to.eq(1)
    expect(await factory.allPools(0)).to.eq(create2Address)
    await expect(factory.allPools(1)).to.be.reverted

    const poolContractFactory = await ethers.getContractFactory('EthAfPool')
    const pool = poolContractFactory.attach(create2Address) as any
    expect(await pool.factory(), 'pool factory address').to.eq(factory.address)
    expect(await pool.token0(), 'pool token0').to.eq(tokens[0])
    expect(await pool.token1(), 'pool token1').to.eq(tokens[1])
    expect(await pool.fee(), 'pool fee').to.eq(feeAmount)
    expect(await pool.tickSpacing(), 'pool tick spacing').to.eq(tickSpacing)

    if(!!expectedPoolTokenSettings) {
      expect(await pool.poolTokenSettings(), 'pool token settings').to.eq(expectedPoolTokenSettings)
    }
    return { pool }
  }

  describe("multiple swaps", function() {
    it("multiple swaps test 1", async function () {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: FactoryTokenSettings.IS_BASE_TOKEN_USD_MASK,
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.HIGH)
      expect(await pool.poolTokenSettings()).to.eq(PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(true)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      expect(tokenSettings.token0SupportsNativeYield).to.eq(false)
      expect(tokenSettings.token1SupportsNativeYield).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)
      const poolFunctions = createPoolFunctions({ swapTarget: swapTargetCallee, token0, token1, pool })
      const slot0_A = await pool.slot0()
      const balUA = await getBalances(wallet.address)
      const balPA = await getBalances(pool.address)

      // mint positions
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.HIGH]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.HIGH]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const slot0_B = await pool.slot0()
      const position1A = await pool.positions(getPositionKey(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position1A

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(feeGrowthGlobal0X128) // eq 0
      expect(feeGrowthInside1LastX128).eq(feeGrowthGlobal1X128)

      const balUB = await getBalances(wallet.address)
      let diffUAB = checkBalanceDiff(balUA, balUB, false, "wallet")
      const balPB = await getBalances(pool.address)
      let diffPAB = checkBalanceDiff(balPA, balPB, false, "pool")

      const mintPosition2 = {
        tickLower: -TICK_SPACINGS[FeeAmount.HIGH], // tighter range
        tickUpper: TICK_SPACINGS[FeeAmount.HIGH],
        liquidity: expandTo18Decimals(100), // not a lot of liquidity
      }
      await poolFunctions.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)
      const slot0_C = await pool.slot0()
      const position2A = await pool.positions(getPositionKey(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position2A

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(feeGrowthGlobal0X128) // eq 0
      expect(feeGrowthInside1LastX128).eq(feeGrowthGlobal1X128)

      const balUC = await getBalances(wallet.address)
      let diffUBC = checkBalanceDiff(balUB, balUC, false, "wallet")
      const balPC = await getBalances(pool.address)
      let diffPBC = checkBalanceDiff(balPB, balPC, false, "pool")

      const feeGrowthGlobal0X128_0 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_0 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_0).eq(0)
      expect(feeGrowthGlobal1X128_0).eq(0)
      const baseTokensAccumulated_0 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_0.amount0).eq(0)
      expect(baseTokensAccumulated_0.amount1).eq(0)

      const balU0 = await getBalances(wallet.address)
      const balP0 = await getBalances(pool.address)

      const tick1_0 = await pool.ticks(mintPosition1.tickLower)
      const tick2_0 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_0 = await pool.ticks(mintPosition2.tickLower)
      const tick4_0 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_0.feeGrowthOutside0X128).eq(0)
      expect(tick2_0.feeGrowthOutside0X128).eq(0)
      expect(tick3_0.feeGrowthOutside0X128).eq(0)
      expect(tick4_0.feeGrowthOutside0X128).eq(0)
      expect(tick1_0.feeGrowthOutside1X128).eq(0)
      expect(tick2_0.feeGrowthOutside1X128).eq(0)
      expect(tick3_0.feeGrowthOutside1X128).eq(0)
      expect(tick4_0.feeGrowthOutside1X128).eq(0)

      const swapTestCase1 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(1_000), // 1% fee => 10 token0 generated as fees
      }
      const expectedSwapFees1 = swapTestCase1.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase1, poolFunctions, wallet.address)
      const balU1 = await getBalances(wallet.address)
      let diffU01 = checkBalanceDiff(balU0, balU1, false, "wallet")
      const balP1 = await getBalances(pool.address)
      let diffP01 = checkBalanceDiff(balP0, balP1, false, "pool")
      const slot0_1 = await pool.slot0()

      const tick1_1 = await pool.ticks(mintPosition1.tickLower)
      const tick2_1 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_1 = await pool.ticks(mintPosition2.tickLower)
      const tick4_1 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_1.feeGrowthOutside0X128).eq(0)
      expect(tick2_1.feeGrowthOutside0X128).eq(0)
      expect(tick3_1.feeGrowthOutside0X128).eq(0)
      expect(tick4_1.feeGrowthOutside0X128).eq(0)
      expect(tick1_1.feeGrowthOutside1X128).eq(0)
      expect(tick2_1.feeGrowthOutside1X128).eq(0)
      expect(tick3_1.feeGrowthOutside1X128).eq(0)
      expect(tick4_1.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_1 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_1 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_1).eq(0)
      expect(feeGrowthGlobal1X128_1).eq(0)
      const baseTokensAccumulated_1 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_1.amount0).eq(expectedSwapFees1)
      expect(baseTokensAccumulated_1.amount1).eq(0)

      const swapTestCase2 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(4_000), // 1% fee => 40 token0 generated as fees
      }
      const expectedSwapFees2 = swapTestCase2.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase2, poolFunctions, wallet.address)
      const balU2 = await getBalances(wallet.address)
      let diffU12 = checkBalanceDiff(balU1, balU2, false, "wallet")
      const balP2 = await getBalances(pool.address)
      let diffP12 = checkBalanceDiff(balP1, balP2, false, "pool")
      const slot0_2 = await pool.slot0()

      const tick1_2 = await pool.ticks(mintPosition1.tickLower)
      const tick2_2 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_2 = await pool.ticks(mintPosition2.tickLower)
      const tick4_2 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_2.feeGrowthOutside0X128).eq(0)
      expect(tick2_2.feeGrowthOutside0X128).eq(0)
      expect(tick3_2.feeGrowthOutside0X128).eq(0)
      expect(tick4_2.feeGrowthOutside0X128).eq(0)
      expect(tick1_2.feeGrowthOutside1X128).eq(0)
      expect(tick2_2.feeGrowthOutside1X128).eq(0)
      expect(tick3_2.feeGrowthOutside1X128).eq(0)
      expect(tick4_2.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_2 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_2 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_2).eq(0)
      expect(feeGrowthGlobal1X128_2).eq(0)
      const baseTokensAccumulated_2 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_2.amount0).eq(expectedSwapFees1.add(expectedSwapFees2))
      expect(baseTokensAccumulated_2.amount1).eq(0)

      const swapTestCase3 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(5_000),
      }
      const expectedSwapFees3 = swapTestCase3.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase3, poolFunctions, wallet.address)
      const balU3 = await getBalances(wallet.address)
      let diffU23 = checkBalanceDiff(balU2, balU3, false, "wallet")
      const balP3 = await getBalances(pool.address)
      let diffP23 = checkBalanceDiff(balP2, balP3, false, "pool")
      const slot0_3 = await pool.slot0()

      const tick1_3 = await pool.ticks(mintPosition1.tickLower)
      const tick2_3 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_3 = await pool.ticks(mintPosition2.tickLower)
      const tick4_3 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_3.feeGrowthOutside0X128).eq(0)
      expect(tick2_3.feeGrowthOutside0X128).eq(0)
      expect(tick3_3.feeGrowthOutside0X128).eq(0)
      expect(tick4_3.feeGrowthOutside0X128).eq(0)
      expect(tick1_3.feeGrowthOutside1X128).eq(0)
      expect(tick2_3.feeGrowthOutside1X128).eq(0)
      expect(tick3_3.feeGrowthOutside1X128).gt(0) // crossed these ticks. only accumulated fees in token1
      expect(tick4_3.feeGrowthOutside1X128).gt(0)

      const feeGrowthGlobal0X128_3 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_3 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_3).eq(0)
      expect(feeGrowthGlobal1X128_3).gt(0) // earned fees as pump token
      const baseTokensAccumulated_3 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_3.amount0).eq(expectedSwapFees1.add(expectedSwapFees2))
      expect(baseTokensAccumulated_3.amount1).eq(0)

      const swapTestCase4 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(300), // 1% fee => 40 token0 generated as fees
      }
      const expectedSwapFees4 = swapTestCase4.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase4, poolFunctions, wallet.address)
      const balU4 = await getBalances(wallet.address)
      let diffU34 = checkBalanceDiff(balU3, balU4, false, "wallet")
      const balP4 = await getBalances(pool.address)
      let diffP34 = checkBalanceDiff(balP3, balP4, false, "pool")
      const slot0_4 = await pool.slot0()

      const tick1_4 = await pool.ticks(mintPosition1.tickLower)
      const tick2_4 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_4 = await pool.ticks(mintPosition2.tickLower)
      const tick4_4 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_4.feeGrowthOutside0X128).eq(0)
      expect(tick2_4.feeGrowthOutside0X128).eq(0)
      expect(tick3_4.feeGrowthOutside0X128).eq(0)
      expect(tick4_4.feeGrowthOutside0X128).eq(0)
      expect(tick1_4.feeGrowthOutside1X128).eq(0)
      expect(tick2_4.feeGrowthOutside1X128).eq(0)
      expect(tick3_4.feeGrowthOutside1X128).eq(tick3_3.feeGrowthOutside1X128) // not crossed, no change
      expect(tick4_4.feeGrowthOutside1X128).eq(tick4_3.feeGrowthOutside1X128)

      const feeGrowthGlobal0X128_4 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_4 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_4).eq(0)
      expect(feeGrowthGlobal1X128_4).eq(feeGrowthGlobal1X128_3) // no diff
      const baseTokensAccumulated_4 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_4.amount0).eq(expectedSwapFees1.add(expectedSwapFees2).add(expectedSwapFees4)) // more fees
      expect(baseTokensAccumulated_4.amount1).eq(0)

      await swapFeeDistributor.distributeFeesForPool(pool.address)
      const balU5 = await getBalances(wallet.address)
      let diffU45 = checkBalanceDiff(balU4, balU5, false, "wallet")
      const balP5 = await getBalances(pool.address)
      let diffP45 = checkBalanceDiff(balP4, balP5, false, "pool")
      expect(diffU45.token0).eq(0) // rebalance does not change the balances
      expect(diffU45.token1).eq(0)
      expect(diffP45.token0).eq(0)
      expect(diffP45.token1).eq(0)
      const slot0_5 = await pool.slot0()

      const tick1_5 = await pool.ticks(mintPosition1.tickLower)
      const tick2_5 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_5 = await pool.ticks(mintPosition2.tickLower)
      const tick4_5 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_5.feeGrowthOutside0X128).eq(0)
      expect(tick2_5.feeGrowthOutside0X128).eq(0)
      expect(tick3_5.feeGrowthOutside0X128).eq(0)
      expect(tick4_5.feeGrowthOutside0X128).eq(0)
      expect(tick1_5.feeGrowthOutside1X128).eq(0)
      expect(tick2_5.feeGrowthOutside1X128).eq(0)
      expect(tick3_5.feeGrowthOutside1X128).eq(tick3_4.feeGrowthOutside1X128) // ticks were not crossed during distribution
      expect(tick4_5.feeGrowthOutside1X128).eq(tick4_4.feeGrowthOutside1X128)

      const feeGrowthGlobal0X128_5 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_5 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_5).eq(0)
      expect(feeGrowthGlobal1X128_5).gt(feeGrowthGlobal1X128_4) // fees from redistribution
      let expectedSwapFees5 = expectedSwapFees1.add(expectedSwapFees2).add(expectedSwapFees4).mul(100).div(10_000) // leftover from distribute
      const baseTokensAccumulated_5 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_5.amount0).eq(expectedSwapFees5) // more fees
      expect(baseTokensAccumulated_5.amount1).eq(0)
      expect(slot0_5.sqrtPriceX96).lt(slot0_4.sqrtPriceX96) // price change from distribution
      expect(slot0_5.tick).lt(slot0_4.tick) // price change from distribution

      const swapTestCase6 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(1_000),
      }
      const expectedSwapFees6 = swapTestCase6.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase6, poolFunctions, wallet.address)
      const balU6 = await getBalances(wallet.address)
      let diffU56 = checkBalanceDiff(balU5, balU6, false, "wallet")
      const balP6 = await getBalances(pool.address)
      let diffP56 = checkBalanceDiff(balP5, balP6, false, "pool")
      const slot0_6 = await pool.slot0()

      const tick1_6 = await pool.ticks(mintPosition1.tickLower)
      const tick2_6 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_6 = await pool.ticks(mintPosition2.tickLower)
      const tick4_6 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_6.feeGrowthOutside0X128).eq(0)
      expect(tick2_6.feeGrowthOutside0X128).eq(0)
      expect(tick3_6.feeGrowthOutside0X128).eq(0)
      expect(tick4_6.feeGrowthOutside0X128).eq(0)
      expect(tick1_6.feeGrowthOutside1X128).eq(0)
      expect(tick2_6.feeGrowthOutside1X128).eq(0)
      expect(tick3_6.feeGrowthOutside1X128).eq(tick3_5.feeGrowthOutside1X128) // not crossed, no change
      expect(tick4_6.feeGrowthOutside1X128).gt(tick4_5.feeGrowthOutside1X128) // was crossed

      const feeGrowthGlobal0X128_6 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_6 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_6).eq(0)
      expect(feeGrowthGlobal1X128_6).eq(feeGrowthGlobal1X128_5) // no diff
      const baseTokensAccumulated_6 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_6.amount0).eq(expectedSwapFees5.add(expectedSwapFees6)) // more fees
      expect(baseTokensAccumulated_6.amount1).eq(0)

      const swapTestCase7 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(1_000),
      }
      const expectedSwapFees7 = swapTestCase7.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase7, poolFunctions, wallet.address)
      const balU7 = await getBalances(wallet.address)
      let diffU67 = checkBalanceDiff(balU6, balU7, false, "wallet")
      const balP7 = await getBalances(pool.address)
      let diffP67 = checkBalanceDiff(balP6, balP7, false, "pool")
      const slot0_7 = await pool.slot0()

      const tick1_7 = await pool.ticks(mintPosition1.tickLower)
      const tick2_7 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_7 = await pool.ticks(mintPosition2.tickLower)
      const tick4_7 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_7.feeGrowthOutside0X128).eq(0)
      expect(tick2_7.feeGrowthOutside0X128).eq(0)
      expect(tick3_7.feeGrowthOutside0X128).eq(0)
      expect(tick4_7.feeGrowthOutside0X128).eq(0)
      expect(tick1_7.feeGrowthOutside1X128).eq(0)
      expect(tick2_7.feeGrowthOutside1X128).eq(0)
      expect(tick3_7.feeGrowthOutside1X128).eq(tick3_6.feeGrowthOutside1X128) // not crossed
      expect(tick4_7.feeGrowthOutside1X128).lt(tick4_6.feeGrowthOutside1X128) // crossed. but fee growth outside decreased

      const feeGrowthGlobal0X128_7 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_7 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_7).eq(0)
      expect(feeGrowthGlobal1X128_7).gt(feeGrowthGlobal1X128_6) // more fees
      const baseTokensAccumulated_7 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_7.amount0).eq(baseTokensAccumulated_6.amount0) // no diff
      expect(baseTokensAccumulated_7.amount1).eq(0)

      await swapFeeDistributor.distributeFeesForPool(pool.address)
      const balU8 = await getBalances(wallet.address)
      let diffU78 = checkBalanceDiff(balU7, balU8, false, "wallet")
      const balP8 = await getBalances(pool.address)
      let diffP78 = checkBalanceDiff(balP7, balP8, false, "pool")
      expect(diffU78.token0).eq(0) // rebalance does not change the balances
      expect(diffU78.token1).eq(0)
      expect(diffP78.token0).eq(0)
      expect(diffP78.token1).eq(0)
      const slot0_8 = await pool.slot0()

      const tick1_8 = await pool.ticks(mintPosition1.tickLower)
      const tick2_8 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_8 = await pool.ticks(mintPosition2.tickLower)
      const tick4_8 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_8.feeGrowthOutside0X128).eq(0)
      expect(tick2_8.feeGrowthOutside0X128).eq(0)
      expect(tick3_8.feeGrowthOutside0X128).eq(0)
      expect(tick4_8.feeGrowthOutside0X128).eq(0)
      expect(tick1_8.feeGrowthOutside1X128).eq(0)
      expect(tick2_8.feeGrowthOutside1X128).eq(0)
      expect(tick3_8.feeGrowthOutside1X128).eq(tick3_7.feeGrowthOutside1X128) // ticks were not crossed during distribution
      expect(tick4_8.feeGrowthOutside1X128).eq(tick4_7.feeGrowthOutside1X128)

      const feeGrowthGlobal0X128_8 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_8 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_8).eq(0)
      expect(feeGrowthGlobal1X128_8).gt(feeGrowthGlobal1X128_7) // fees from redistribution
      let expectedSwapFees8 = baseTokensAccumulated_7.amount0.mul(100).div(10_000) // leftover from distribute
      const baseTokensAccumulated_8 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_8.amount0).eq(expectedSwapFees8) // more fees
      expect(baseTokensAccumulated_8.amount1).eq(0)
      expect(slot0_8.sqrtPriceX96).lt(slot0_7.sqrtPriceX96) // price change from distribution
      expect(slot0_8.tick).lt(slot0_7.tick) // price change from distribution
    })

    it("multiple swaps test 2", async function () {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: FactoryTokenSettings.IS_BASE_TOKEN_USD_MASK,
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.HIGH)
      expect(await pool.poolTokenSettings()).to.eq(PoolTokenSettings.IS_TOKEN1_BASE_TOKEN_MASK)
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(true)
      expect(tokenSettings.token0SupportsNativeYield).to.eq(false)
      expect(tokenSettings.token1SupportsNativeYield).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)
      const poolFunctions = createPoolFunctions({ swapTarget: swapTargetCallee, token0, token1, pool })
      const slot0_A = await pool.slot0()
      const balUA = await getBalances(wallet.address)
      const balPA = await getBalances(pool.address)

      // mint positions
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.HIGH]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.HIGH]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const slot0_B = await pool.slot0()
      const position1A = await pool.positions(getPositionKey(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position1A

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(feeGrowthGlobal0X128) // eq 0
      expect(feeGrowthInside1LastX128).eq(feeGrowthGlobal1X128)

      const balUB = await getBalances(wallet.address)
      let diffUAB = checkBalanceDiff(balUA, balUB, false, "wallet")
      const balPB = await getBalances(pool.address)
      let diffPAB = checkBalanceDiff(balPA, balPB, false, "pool")

      const mintPosition2 = {
        tickLower: -TICK_SPACINGS[FeeAmount.HIGH], // tighter range
        tickUpper: TICK_SPACINGS[FeeAmount.HIGH],
        liquidity: expandTo18Decimals(100), // not a lot of liquidity
      }
      await poolFunctions.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)
      const slot0_C = await pool.slot0()
      const position2A = await pool.positions(getPositionKey(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position2A

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(feeGrowthGlobal0X128) // eq 0
      expect(feeGrowthInside1LastX128).eq(feeGrowthGlobal1X128)

      const balUC = await getBalances(wallet.address)
      let diffUBC = checkBalanceDiff(balUB, balUC, false, "wallet")
      const balPC = await getBalances(pool.address)
      let diffPBC = checkBalanceDiff(balPB, balPC, false, "pool")

      const feeGrowthGlobal0X128_0 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_0 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_0).eq(0)
      expect(feeGrowthGlobal1X128_0).eq(0)
      const baseTokensAccumulated_0 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_0.amount0).eq(0)
      expect(baseTokensAccumulated_0.amount1).eq(0)

      const balU0 = await getBalances(wallet.address)
      const balP0 = await getBalances(pool.address)

      const tick1_0 = await pool.ticks(mintPosition1.tickLower)
      const tick2_0 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_0 = await pool.ticks(mintPosition2.tickLower)
      const tick4_0 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_0.feeGrowthOutside0X128).eq(0)
      expect(tick2_0.feeGrowthOutside0X128).eq(0)
      expect(tick3_0.feeGrowthOutside0X128).eq(0)
      expect(tick4_0.feeGrowthOutside0X128).eq(0)
      expect(tick1_0.feeGrowthOutside1X128).eq(0)
      expect(tick2_0.feeGrowthOutside1X128).eq(0)
      expect(tick3_0.feeGrowthOutside1X128).eq(0)
      expect(tick4_0.feeGrowthOutside1X128).eq(0)

      const swapTestCase1 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(1_000), // 1% fee => 10 token0 generated as fees
      }
      const expectedSwapFees1 = swapTestCase1.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase1, poolFunctions, wallet.address)
      const balU1 = await getBalances(wallet.address)
      let diffU01 = checkBalanceDiff(balU0, balU1, false, "wallet")
      const balP1 = await getBalances(pool.address)
      let diffP01 = checkBalanceDiff(balP0, balP1, false, "pool")
      const slot0_1 = await pool.slot0()

      const tick1_1 = await pool.ticks(mintPosition1.tickLower)
      const tick2_1 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_1 = await pool.ticks(mintPosition2.tickLower)
      const tick4_1 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_1.feeGrowthOutside0X128).eq(0) // no ticks crossed
      expect(tick2_1.feeGrowthOutside0X128).eq(0)
      expect(tick3_1.feeGrowthOutside0X128).eq(0)
      expect(tick4_1.feeGrowthOutside0X128).eq(0)
      expect(tick1_1.feeGrowthOutside1X128).eq(0)
      expect(tick2_1.feeGrowthOutside1X128).eq(0)
      expect(tick3_1.feeGrowthOutside1X128).eq(0)
      expect(tick4_1.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_1 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_1 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_1).eq(0)
      expect(feeGrowthGlobal1X128_1).eq(0)
      const baseTokensAccumulated_1 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_1.amount0).eq(0)
      expect(baseTokensAccumulated_1.amount1).eq(expectedSwapFees1)

      const swapTestCase2 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(4_000), // 1% fee => 40 token0 generated as fees
      }
      const expectedSwapFees2 = swapTestCase2.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase2, poolFunctions, wallet.address)
      const balU2 = await getBalances(wallet.address)
      let diffU12 = checkBalanceDiff(balU1, balU2, false, "wallet")
      const balP2 = await getBalances(pool.address)
      let diffP12 = checkBalanceDiff(balP1, balP2, false, "pool")
      const slot0_2 = await pool.slot0()

      const tick1_2 = await pool.ticks(mintPosition1.tickLower)
      const tick2_2 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_2 = await pool.ticks(mintPosition2.tickLower)
      const tick4_2 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_2.feeGrowthOutside0X128).eq(0)
      expect(tick2_2.feeGrowthOutside0X128).eq(0)
      expect(tick3_2.feeGrowthOutside0X128).eq(0)
      expect(tick4_2.feeGrowthOutside0X128).eq(0)
      expect(tick1_2.feeGrowthOutside1X128).eq(0)
      expect(tick2_2.feeGrowthOutside1X128).eq(0)
      expect(tick3_2.feeGrowthOutside1X128).eq(0)
      expect(tick4_2.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_2 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_2 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_2).eq(0)
      expect(feeGrowthGlobal1X128_2).eq(0)
      const baseTokensAccumulated_2 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_2.amount0).eq(0)
      expect(baseTokensAccumulated_2.amount1).eq(expectedSwapFees1.add(expectedSwapFees2))

      const swapTestCase3 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(5_000),
      }
      const expectedSwapFees3 = swapTestCase3.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase3, poolFunctions, wallet.address)
      const balU3 = await getBalances(wallet.address)
      let diffU23 = checkBalanceDiff(balU2, balU3, false, "wallet")
      const balP3 = await getBalances(pool.address)
      let diffP23 = checkBalanceDiff(balP2, balP3, false, "pool")
      const slot0_3 = await pool.slot0()

      const tick1_3 = await pool.ticks(mintPosition1.tickLower)
      const tick2_3 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_3 = await pool.ticks(mintPosition2.tickLower)
      const tick4_3 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_3.feeGrowthOutside0X128).eq(0)
      expect(tick2_3.feeGrowthOutside0X128).eq(0)
      expect(tick3_3.feeGrowthOutside0X128).gt(0) // crossed these ticks. only accumulated fees in token1
      expect(tick4_3.feeGrowthOutside0X128).gt(0)
      expect(tick1_3.feeGrowthOutside1X128).eq(0)
      expect(tick2_3.feeGrowthOutside1X128).eq(0)
      expect(tick3_3.feeGrowthOutside1X128).eq(0)
      expect(tick4_3.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_3 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_3 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_3).gt(0) // earned fees as pump token
      expect(feeGrowthGlobal1X128_3).eq(0)
      const baseTokensAccumulated_3 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_3.amount0).eq(0)
      expect(baseTokensAccumulated_3.amount1).eq(expectedSwapFees1.add(expectedSwapFees2))

      const swapTestCase4 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(300), // 1% fee => 40 token0 generated as fees
      }
      const expectedSwapFees4 = swapTestCase4.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase4, poolFunctions, wallet.address)
      const balU4 = await getBalances(wallet.address)
      let diffU34 = checkBalanceDiff(balU3, balU4, false, "wallet")
      const balP4 = await getBalances(pool.address)
      let diffP34 = checkBalanceDiff(balP3, balP4, false, "pool")
      const slot0_4 = await pool.slot0()

      const tick1_4 = await pool.ticks(mintPosition1.tickLower)
      const tick2_4 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_4 = await pool.ticks(mintPosition2.tickLower)
      const tick4_4 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_4.feeGrowthOutside0X128).eq(0)
      expect(tick2_4.feeGrowthOutside0X128).eq(0)
      expect(tick3_4.feeGrowthOutside0X128).eq(tick3_3.feeGrowthOutside0X128) // not crossed, no change
      expect(tick4_4.feeGrowthOutside0X128).eq(tick4_3.feeGrowthOutside0X128)
      expect(tick1_4.feeGrowthOutside1X128).eq(0)
      expect(tick2_4.feeGrowthOutside1X128).eq(0)
      expect(tick3_4.feeGrowthOutside1X128).eq(0)
      expect(tick4_4.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_4 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_4 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_4).eq(feeGrowthGlobal0X128_3) // no diff
      expect(feeGrowthGlobal1X128_4).eq(0)
      const baseTokensAccumulated_4 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_4.amount0).eq(0)
      expect(baseTokensAccumulated_4.amount1).eq(expectedSwapFees1.add(expectedSwapFees2).add(expectedSwapFees4)) // more fees

      await swapFeeDistributor.distributeFeesForPool(pool.address)
      const balU5 = await getBalances(wallet.address)
      let diffU45 = checkBalanceDiff(balU4, balU5, false, "wallet")
      const balP5 = await getBalances(pool.address)
      let diffP45 = checkBalanceDiff(balP4, balP5, false, "pool")
      expect(diffU45.token0).eq(0) // rebalance does not change the balances
      expect(diffU45.token1).eq(0)
      expect(diffP45.token0).eq(0)
      expect(diffP45.token1).eq(0)
      const slot0_5 = await pool.slot0()

      const tick1_5 = await pool.ticks(mintPosition1.tickLower)
      const tick2_5 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_5 = await pool.ticks(mintPosition2.tickLower)
      const tick4_5 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_5.feeGrowthOutside0X128).eq(0)
      expect(tick2_5.feeGrowthOutside0X128).eq(0)
      expect(tick3_5.feeGrowthOutside0X128).eq(tick3_4.feeGrowthOutside0X128) // ticks were not crossed during distribution
      expect(tick4_5.feeGrowthOutside0X128).eq(tick4_4.feeGrowthOutside0X128)
      expect(tick1_5.feeGrowthOutside1X128).eq(0)
      expect(tick2_5.feeGrowthOutside1X128).eq(0)
      expect(tick3_5.feeGrowthOutside1X128).eq(0)
      expect(tick4_5.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_5 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_5 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_5).gt(feeGrowthGlobal1X128_4) // fees from redistribution
      expect(feeGrowthGlobal1X128_5).eq(0)
      let expectedSwapFees5 = expectedSwapFees1.add(expectedSwapFees2).add(expectedSwapFees4).mul(100).div(10_000) // leftover from distribute
      const baseTokensAccumulated_5 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_5.amount0).eq(0)
      expect(baseTokensAccumulated_5.amount1).eq(expectedSwapFees5) // more fees
      expect(slot0_5.sqrtPriceX96).gt(slot0_4.sqrtPriceX96) // price change from distribution
      expect(slot0_5.tick).gt(slot0_4.tick) // price change from distribution

      const swapTestCase6 = {
        zeroForOne: false,
        exactOut: false,
        amount1: expandTo18Decimals(1_000),
      }
      const expectedSwapFees6 = swapTestCase6.amount1.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase6, poolFunctions, wallet.address)
      const balU6 = await getBalances(wallet.address)
      let diffU56 = checkBalanceDiff(balU5, balU6, false, "wallet")
      const balP6 = await getBalances(pool.address)
      let diffP56 = checkBalanceDiff(balP5, balP6, false, "pool")
      const slot0_6 = await pool.slot0()

      const tick1_6 = await pool.ticks(mintPosition1.tickLower)
      const tick2_6 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_6 = await pool.ticks(mintPosition2.tickLower)
      const tick4_6 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_6.feeGrowthOutside0X128).eq(0)
      expect(tick2_6.feeGrowthOutside0X128).eq(0)
      expect(tick3_6.feeGrowthOutside0X128).gt(tick3_5.feeGrowthOutside0X128) // was crossed
      expect(tick4_6.feeGrowthOutside0X128).eq(tick4_5.feeGrowthOutside0X128) // not crossed, no change
      expect(tick1_6.feeGrowthOutside1X128).eq(0)
      expect(tick2_6.feeGrowthOutside1X128).eq(0)
      expect(tick3_6.feeGrowthOutside1X128).eq(0)
      expect(tick4_6.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_6 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_6 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_6).eq(feeGrowthGlobal0X128_5) // no diff
      expect(feeGrowthGlobal1X128_6).eq(0)
      const baseTokensAccumulated_6 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_6.amount0).eq(0)
      expect(baseTokensAccumulated_6.amount1).eq(expectedSwapFees5.add(expectedSwapFees6)) // more fees

      const swapTestCase7 = {
        zeroForOne: true,
        exactOut: false,
        amount0: expandTo18Decimals(1_000),
      }
      const expectedSwapFees7 = swapTestCase7.amount0.mul(100).div(10_000) // 1% fee tier => 100 bps
      await executeSwap(pool, swapTestCase7, poolFunctions, wallet.address)
      const balU7 = await getBalances(wallet.address)
      let diffU67 = checkBalanceDiff(balU6, balU7, false, "wallet")
      const balP7 = await getBalances(pool.address)
      let diffP67 = checkBalanceDiff(balP6, balP7, false, "pool")
      const slot0_7 = await pool.slot0()

      const tick1_7 = await pool.ticks(mintPosition1.tickLower)
      const tick2_7 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_7 = await pool.ticks(mintPosition2.tickLower)
      const tick4_7 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_7.feeGrowthOutside0X128).eq(0)
      expect(tick2_7.feeGrowthOutside0X128).eq(0)
      expect(tick3_7.feeGrowthOutside0X128).lt(tick3_6.feeGrowthOutside0X128) // crossed. but fee growth outside decreased
      expect(tick4_7.feeGrowthOutside0X128).eq(tick4_6.feeGrowthOutside0X128) // not crossed
      expect(tick1_7.feeGrowthOutside1X128).eq(0)
      expect(tick2_7.feeGrowthOutside1X128).eq(0)
      expect(tick3_7.feeGrowthOutside1X128).eq(0)
      expect(tick4_7.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_7 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_7 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_7).gt(feeGrowthGlobal0X128_6) // more fees
      expect(feeGrowthGlobal1X128_7).eq(0)
      const baseTokensAccumulated_7 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_7.amount0).eq(0)
      expect(baseTokensAccumulated_7.amount1).eq(baseTokensAccumulated_6.amount1) // no diff

      await swapFeeDistributor.distributeFeesForPool(pool.address)
      const balU8 = await getBalances(wallet.address)
      let diffU78 = checkBalanceDiff(balU7, balU8, false, "wallet")
      const balP8 = await getBalances(pool.address)
      let diffP78 = checkBalanceDiff(balP7, balP8, false, "pool")
      expect(diffU78.token0).eq(0) // rebalance does not change the balances
      expect(diffU78.token1).eq(0)
      expect(diffP78.token0).eq(0)
      expect(diffP78.token1).eq(0)
      const slot0_8 = await pool.slot0()

      const tick1_8 = await pool.ticks(mintPosition1.tickLower)
      const tick2_8 = await pool.ticks(mintPosition1.tickUpper)
      const tick3_8 = await pool.ticks(mintPosition2.tickLower)
      const tick4_8 = await pool.ticks(mintPosition2.tickUpper)
      expect(tick1_8.feeGrowthOutside0X128).eq(0)
      expect(tick2_8.feeGrowthOutside0X128).eq(0)
      expect(tick3_8.feeGrowthOutside0X128).eq(tick3_7.feeGrowthOutside0X128) // ticks were not crossed during distribution
      expect(tick4_8.feeGrowthOutside0X128).eq(tick4_7.feeGrowthOutside0X128)
      expect(tick1_8.feeGrowthOutside1X128).eq(0)
      expect(tick2_8.feeGrowthOutside1X128).eq(0)
      expect(tick3_8.feeGrowthOutside1X128).eq(0)
      expect(tick4_8.feeGrowthOutside1X128).eq(0)

      const feeGrowthGlobal0X128_8 = await pool.feeGrowthGlobal0X128()
      const feeGrowthGlobal1X128_8 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthGlobal0X128_8).gt(feeGrowthGlobal1X128_7) // fees from redistribution
      expect(feeGrowthGlobal1X128_8).eq(0)
      let expectedSwapFees8 = baseTokensAccumulated_6.amount1.mul(100).div(10_000) // leftover from distribute
      const baseTokensAccumulated_8 = await pool.baseTokensAccumulated()
      expect(baseTokensAccumulated_8.amount0).eq(0)
      expect(baseTokensAccumulated_8.amount1).eq(expectedSwapFees8) // more fees
      expect(slot0_8.sqrtPriceX96).gt(slot0_7.sqrtPriceX96) // price change from distribution
      expect(slot0_8.tick).gt(slot0_7.tick) // price change from distribution
    })

  })



  async function getBalances(address:string) {
    return {
      token0: await token0.balanceOf(address),
      token1: await token1.balanceOf(address),
    }
  }

  function checkBalanceDiff(b0:any, b1:any, log=false, name="") {
    let diff0 = b1.token0.sub(b0.token0)
    let diff1 = b1.token1.sub(b0.token1)

    if(log) {
      if(diff0.gt(0)) console.log(`${name} token0 balance increased by ${formatUnits(diff0)}`)
      else if(diff0.lt(0)) console.log(`${name} token0 balance decreased by ${formatUnits(diff0.mul(-1))}`)
      else console.log(`${name} token0 balance did not change`)

      if(diff1.gt(0)) console.log(`${name} token1 balance increased by ${formatUnits(diff1)}`)
      else if(diff1.lt(0)) console.log(`${name} token1 balance decreased by ${formatUnits(diff1.mul(-1))}`)
      else console.log(`${name} token1 balance did not change`)
    }

    return { token0: diff0, token1: diff1 }
  }

  // can't use address zero because the ERC20 token does not allow it
  const SWAP_RECIPIENT_ADDRESS = constants.AddressZero.slice(0, -1) + '1'
  const POSITION_PROCEEDS_OUTPUT_ADDRESS = constants.AddressZero.slice(0, -1) + '2'

  async function executeSwap(
    pool: EthAfPool,
    testCase: any,//SwapTestCase,
    poolFunctions: PoolFunctions,
    receiver=SWAP_RECIPIENT_ADDRESS
  ): Promise<ContractTransaction> {
    let swap: ContractTransaction
    if ('exactOut' in testCase) {
      if (testCase.exactOut) {
        if (testCase.zeroForOne) {
          swap = await poolFunctions.swap0ForExact1(testCase.amount1, receiver, testCase.sqrtPriceLimit)
        } else {
          swap = await poolFunctions.swap1ForExact0(testCase.amount0, receiver, testCase.sqrtPriceLimit)
        }
      } else {
        if (testCase.zeroForOne) {
          swap = await poolFunctions.swapExact0For1(testCase.amount0, receiver, testCase.sqrtPriceLimit)
        } else {
          swap = await poolFunctions.swapExact1For0(testCase.amount1, receiver, testCase.sqrtPriceLimit)
        }
      }
    } else {
      if (testCase.zeroForOne) {
        swap = await poolFunctions.swapToLowerPrice(testCase.sqrtPriceLimit, receiver)
      } else {
        swap = await poolFunctions.swapToHigherPrice(testCase.sqrtPriceLimit, receiver)
      }
    }
    return swap
  }

  interface BaseSwapTestCase {
    zeroForOne: boolean
    sqrtPriceLimit?: BigNumber
  }
  interface SwapExact0For1TestCase extends BaseSwapTestCase {
    zeroForOne: true
    exactOut: false
    amount0: BigNumberish
    sqrtPriceLimit?: BigNumber
  }
  interface SwapExact1For0TestCase extends BaseSwapTestCase {
    zeroForOne: false
    exactOut: false
    amount1: BigNumberish
    sqrtPriceLimit?: BigNumber
  }
  interface Swap0ForExact1TestCase extends BaseSwapTestCase {
    zeroForOne: true
    exactOut: true
    amount1: BigNumberish
    sqrtPriceLimit?: BigNumber
  }
  interface Swap1ForExact0TestCase extends BaseSwapTestCase {
    zeroForOne: false
    exactOut: true
    amount0: BigNumberish
    sqrtPriceLimit?: BigNumber
  }
  interface SwapToHigherPrice extends BaseSwapTestCase {
    zeroForOne: false
    sqrtPriceLimit: BigNumber
  }
  interface SwapToLowerPrice extends BaseSwapTestCase {
    zeroForOne: true
    sqrtPriceLimit: BigNumber
  }
  type SwapTestCase =
    | SwapExact0For1TestCase
    | Swap0ForExact1TestCase
    | SwapExact1For0TestCase
    | Swap1ForExact0TestCase
    | SwapToHigherPrice
    | SwapToLowerPrice

  function expectInRange(lower: BigNumber, center: BigNumber, upper: BigNumber) {
    expect(lower.lte(center) && center.lte(upper)).to.eq(true)
  }

  // Ether.js returns some funky stuff for structs (merges an object and array). Convert to an object
  function convertToStruct(res: any) {
    return Object.keys(res)
      .filter((x) => Number.isNaN(parseInt(x)))
      .reduce(
        (acc, k) => {
          acc[k] = res[k];
          return acc;
        },
        {} as Record<string, any>
      );
  }
})
