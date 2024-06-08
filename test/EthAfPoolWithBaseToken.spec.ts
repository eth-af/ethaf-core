import { BigNumber, BigNumberish, Wallet, ContractTransaction } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { EthAfFactory } from '../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../typechain/EthAfPoolDeployerModule'
import { EthAfSwapFeeDistributor } from '../typechain/EthAfSwapFeeDistributor'
import { EthAfPool } from '../typechain/EthAfPool'
import { TestERC20 } from '../typechain/TestERC20'
import { TestEthAfCallee } from '../typechain/TestEthAfCallee'
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

const { constants } = ethers

const TEST_ADDRESSES: [string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
]

const createFixtureLoader = waffle.createFixtureLoader

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T
type PoolFunctions = ReturnType<typeof createPoolFunctions>

const sqrtPriceX96Initial = encodePriceSqrt(1, 1)

describe('EthAfPoolWithBaseToken', () => {
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
    const poolDeployerModuleFactory = await ethers.getContractFactory('EthAfPoolDeployerModule')
    const poolDeployerModule = (await poolDeployerModuleFactory.deploy()) as EthAfPoolDeployerModule
    const factoryFactory = await ethers.getContractFactory('EthAfFactory')
    const factory = (await factoryFactory.deploy(poolDeployerModule.address)) as EthAfFactory
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

  describe('mint then burn', () => {

    async function checkMintThenBurn(pool:any) {
      // mint
      const position = {
        tickLower: -TICK_SPACINGS[FeeAmount.LOW],
        tickUpper: TICK_SPACINGS[FeeAmount.LOW],
        liquidity: expandTo18Decimals(1_000_000_000),
      }
      const poolFunctions = createPoolFunctions({ swapTarget: swapTargetCallee, token0, token1, pool })
      const balU0 = await getBalances(wallet.address)
      await poolFunctions.mint(wallet.address, position.tickLower, position.tickUpper, position.liquidity)
      const balU1 = await getBalances(wallet.address)
      // token balances should have decreased from mint
      expect(balU1.token0.lt(balU0.token0.sub(100)))
      expect(balU1.token1.lt(balU0.token1.sub(100)))
      let diffU01 = checkBalanceDiff(balU0, balU1, true, "wallet")

      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = await pool.positions(getPositionKey(wallet.address, position.tickLower, position.tickUpper))
      // burn
      await pool.burn(position.tickLower, position.tickUpper, liquidity)
      // collect
      await pool.collect(wallet.address, position.tickLower, position.tickUpper, MaxUint128, MaxUint128)
      // user should have received everything they deposited, minus rounding errors
      const balU4 = await getBalances(wallet.address)
      expectInRange(balU0.token0.sub(10), balU4.token0, balU0.token0)
      expectInRange(balU0.token1.sub(10), balU4.token1, balU0.token1)
      let diffU14 = checkBalanceDiff(balU1, balU4, true, "wallet")

      return {
        balU0, balU1, balU4, diffU01, diffU14
      }
    }

    let results1: any
    let results2: any
    let results3: any

    // all these should have the same results since no fees were generated
    it("mint then burn liquidity pt 1", async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      results1 = await checkMintThenBurn(pool)
    })
    it("mint then burn liquidity pt 2", async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      results2 = await checkMintThenBurn(pool)
    })
    it("mint then burn liquidity pt 3", async () => {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      results3 = await checkMintThenBurn(pool)
    })
  })

  describe('fee distribution', () => {
    it('reverts if pool not initialized', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await expect(swapFeeDistributor.distributeFeesForPool(pool.address)).to.be.reverted
    })
    it('reverts if invalid tokens', async () => {
      const { pool } = await createAndCheckPool(TEST_ADDRESSES, FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      await expect(swapFeeDistributor.distributeFeesForPool(pool.address)).to.be.reverted
    })
    it('reverts if pool function not called by distributor', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await expect(pool.collectBaseToken()).to.be.reverted
    })
    it('can collect zero fees from a new pool', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      await swapFeeDistributor.distributeFeesForPool(pool.address)
    })
    it('can collect zero fees from a new pool with a base token', async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      expect(await factory.tokenSettings(token0.address)).to.eq(toBytes32(1))
      expect(await factory.tokenSettings(token1.address)).to.eq(toBytes32(0))
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      await pool.initialize(sqrtPriceX96Initial)
      await swapFeeDistributor.distributeFeesForPool(pool.address)
    })

    async function feesAfterSwapTest(pool:any, distribute=false, zeroForOne=true) {
      // mint position
      const position = {
        tickLower: -TICK_SPACINGS[FeeAmount.LOW],
        tickUpper: TICK_SPACINGS[FeeAmount.LOW],
        liquidity: expandTo18Decimals(1_000_000_000),
      }
      const poolFunctions = createPoolFunctions({ swapTarget: swapTargetCallee, token0, token1, pool })
      const balU0 = await getBalances(wallet.address)
      const balP0 = await getBalances(pool.address)
      await poolFunctions.mint(wallet.address, position.tickLower, position.tickUpper, position.liquidity)
      const position0 = await pool.positions(getPositionKey(wallet.address, position.tickLower, position.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position0

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(feeGrowthGlobal0X128)
      expect(feeGrowthInside1LastX128).eq(feeGrowthGlobal1X128)

      const balU1 = await getBalances(wallet.address)
      let diffU01 = checkBalanceDiff(balU0, balU1, true, "wallet")
      const balP1 = await getBalances(pool.address)
      let diffP01 = checkBalanceDiff(balP0, balP1, true, "pool")

      // swap to generate fees
      const swapTestCase = (zeroForOne
        ? {
          zeroForOne: true,
          exactOut: false,
          amount0: expandTo18Decimals(1), // 0.05% fee => 0.0005 token1 paid in fees
        }
        : {
          zeroForOne: false,
          exactOut: false,
          amount1: expandTo18Decimals(1), // 0.05% fee => 0.0005 token1 paid in fees
        }
      )
      await executeSwap(pool, swapTestCase, poolFunctions, wallet.address)
      const balU2 = await getBalances(wallet.address)
      let diffU12 = checkBalanceDiff(balU1, balU2, true, "wallet")
      const balP2 = await getBalances(pool.address)
      let diffP12 = checkBalanceDiff(balP1, balP2, true, "pool")
      const position1 = await pool.positions(getPositionKey(wallet.address, position.tickLower, position.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position1

      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()
      expect(feeGrowthInside0LastX128).eq(0) // not collected yet
      expect(feeGrowthInside1LastX128).eq(0) // not collected yet

      // distribute
      let slot0_1 = await pool.slot0()
      if(distribute) {
        await swapFeeDistributor.distributeFeesForPool(pool.address)
      }
      let slot0_2 = await pool.slot0()
      const balU3 = await getBalances(wallet.address)
      let diffU23 = checkBalanceDiff(balU2, balU3, true, "wallet")
      const balP3 = await getBalances(pool.address)
      let diffP23 = checkBalanceDiff(balP2, balP3, true, "pool")

      // burn 0 to recalculate fees earned
      await pool.burn(position.tickLower, position.tickUpper, 0)
      const position2 = await pool.positions(getPositionKey(wallet.address, position.tickLower, position.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position2

      // simulate burn 100%
      const { amount0: amount0Burn, amount1: amount1Burn } = await pool.callStatic.burn(
        position.tickLower,
        position.tickUpper,
        liquidity
      )
      // burn 100%
      await pool.burn(position.tickLower, position.tickUpper, liquidity)
      const position3 = await pool.positions(getPositionKey(wallet.address, position.tickLower, position.tickUpper))
      var {
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
      } = position3

      const balU4 = await getBalances(wallet.address)
      let diffU34 = checkBalanceDiff(balU3, balU4, true, "wallet")
      const balP4 = await getBalances(pool.address)
      let diffP34 = checkBalanceDiff(balP3, balP4, true, "pool")

      // simulate collect
      const {
        amount0: amount0CollectAndBurn,
        amount1: amount1CollectAndBurn,
      } = await pool.callStatic.collect(wallet.address, position.tickLower, position.tickUpper, MaxUint128, MaxUint128)
      // collect
      await pool.collect(wallet.address, position.tickLower, position.tickUpper, MaxUint128, MaxUint128)

      const balU5 = await getBalances(wallet.address)
      let diffU45 = checkBalanceDiff(balU4, balU5, true, "wallet")
      const balP5 = await getBalances(pool.address)
      let diffP45 = checkBalanceDiff(balP4, balP5, true, "pool")

      let slot0 = await pool.slot0()
      // may have changed after distributeFees
      var feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
      var feeGrowthGlobal1X128 = await pool.feeGrowthGlobal1X128()

      // base token swap fees
      const swapFeesAccumulated0 = await pool.swapFeesAccumulated0()
      const swapFeesAccumulated1 = await pool.swapFeesAccumulated1()

      return {
        balU0, balU1, balU2, balU3, balU4, balU5,
        balP0, balP1, balP2, balP3, balP4, balP5,
        diffU01, diffU12, diffU23, diffU34, diffU45,
        diffP01, diffP12, diffP23, diffP34, diffP45,
        feeGrowthGlobal0X128, feeGrowthGlobal1X128,
        position0, position1, position2, position3,
        slot0, slot0_1, slot0_2, //tick0, tick1, tick2, tick3,
        swapFeesAccumulated0, swapFeesAccumulated1,
      }
    }

    let results1: any
    let results2: any
    let results3: any
    let results4: any
    let results5: any
    let results6: any
    let results7: any
    let results8: any
    let results9: any
    let results10: any
    let results11: any
    let results12: any

    // default test - no base tokens, no distribute
    it('can collect fees from a pool after swap pt 1', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(0))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results1 = await feesAfterSwapTest(pool, false, true)

      expect(results1.feeGrowthGlobal0X128).gt(0) // earned fees. not withheld
      expect(results1.feeGrowthGlobal1X128).eq(0) // no fees in this direction
      expect(results1.position2.tokensOwed0).gt(0)
      expect(results1.position2.tokensOwed1).eq(0)
      expect(results1.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results1.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results1.slot0_2.sqrtPriceX96).eq(results1.slot0_1.sqrtPriceX96) // no price change
    })
    // token1 is base token, fees earned in token0, expect no diff
    it('can collect fees from a pool after swap pt 2', async () => {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(2))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(true)
      await pool.initialize(sqrtPriceX96Initial)

      results2 = await feesAfterSwapTest(pool, false, true)

      expect(results2.feeGrowthGlobal0X128).gt(0) // earned fees. not withheld
      expect(results2.feeGrowthGlobal1X128).eq(0) // no fees in this direction
      expect(results2.position2.tokensOwed0).gt(0)
      expect(results2.position2.tokensOwed1).eq(0)
      expect(results2.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results2.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results2.slot0_2.sqrtPriceX96).eq(results2.slot0_1.sqrtPriceX96) // no price change
    })
    // token0 is base token, fees earned in token0, expect fees to not be earned by LPs
    // no distribution
    it('can collect fees from a pool after swap pt 3', async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(1))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(true)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results3 = await feesAfterSwapTest(pool, false, true)

      expect(results3.feeGrowthGlobal0X128).eq(0) // earned fees but withheld
      expect(results3.feeGrowthGlobal1X128).eq(0) // no fees in this direction
      expect(results3.position2.tokensOwed0).eq(0)
      expect(results3.position2.tokensOwed1).eq(0)
      let swapAmountIn = WeiPerEther // swapped in 1 eth
      let expectedFees = swapAmountIn.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      expect(results3.swapFeesAccumulated0).eq(expectedFees) // some withheld fees
      expect(results3.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results3.slot0_2.sqrtPriceX96).eq(results3.slot0_1.sqrtPriceX96) // no price change
    })
    // default test but with distribution
    // no base tokens - no effect
    it('can collect fees from a pool after swap pt 4', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(0))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results4 = await feesAfterSwapTest(pool, true, true)

      expect(results4.feeGrowthGlobal0X128).gt(0) // earned fees. not withheld
      expect(results4.feeGrowthGlobal1X128).eq(0) // no fees in this direction
      expect(results4.position2.tokensOwed0).gt(0)
      expect(results4.position2.tokensOwed1).eq(0)
      expect(results4.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results4.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results4.slot0_2.sqrtPriceX96).eq(results4.slot0_1.sqrtPriceX96) // no price change
    })
    // same as test 2 but with distribution
    // token1 is base token, fees earned in token0, expect no diff
    it('can collect fees from a pool after swap pt 5', async () => {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(2))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(true)
      await pool.initialize(sqrtPriceX96Initial)

      results5 = await feesAfterSwapTest(pool, true, true)

      expect(results5.feeGrowthGlobal0X128).gt(0) // earned fees. not withheld
      expect(results5.feeGrowthGlobal1X128).eq(0) // no fees in this direction
      //expect(results5.position2.tokensOwed0).eq(results5.feeGrowthGlobal0X128) // need to convert X128 to tokens
      //expect(results5.position2.tokensOwed1).eq(results5.feeGrowthGlobal1X128)
      expect(results5.position2.tokensOwed0).gt(0)
      expect(results5.position2.tokensOwed1).eq(0)
      expect(results5.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results5.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results5.slot0_2.sqrtPriceX96).eq(results5.slot0_1.sqrtPriceX96) // no price change
    })
    // same as test 3 but with distribution
    // token0 is base token, fees earned in token0, fees are swapped for more token1
    it('can collect fees from a pool after swap pt 6', async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(1))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(true)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results6 = await feesAfterSwapTest(pool, true, true)

      expect(results6.feeGrowthGlobal0X128).eq(0) // earned fees but withheld
      expect(results6.feeGrowthGlobal1X128).gt(0) // earned fees after redistribution
      expect(results6.position2.tokensOwed0).eq(0)
      expect(results6.position2.tokensOwed1).gt(0) // getting swap fees
      let swapAmountIn = WeiPerEther // swapped in 1 eth
      let expectedFees = swapAmountIn.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      let expectedFees2 = expectedFees.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      expect(results6.swapFeesAccumulated0).eq(expectedFees2) // fees have been distributed, but distributing creates more fees
      expect(results6.swapFeesAccumulated1).eq(0) // no withheld fees on this side
      expect(results6.slot0_2.sqrtPriceX96).lt(results6.slot0_1.sqrtPriceX96) // price increased from distribution. lesser than because 0/1
    })

    // default test - no base tokens, no distribute
    it('can collect fees from a pool after swap pt 7', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(0))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results7 = await feesAfterSwapTest(pool, false, false)

      expect(results7.feeGrowthGlobal0X128).eq(0) // no fees in this direction
      expect(results7.feeGrowthGlobal1X128).gt(0) // earned fees. not withheld
      expect(results7.position2.tokensOwed0).eq(0)
      expect(results7.position2.tokensOwed1).gt(0)
      expect(results7.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results7.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results7.slot0_2.sqrtPriceX96).eq(results7.slot0_1.sqrtPriceX96) // no price change
    })
    // same as test 2 expect swap direction is reversed
    // token1 is base token, fees earned in token0, expect fees to not be earned by LPs
    it('can collect fees from a pool after swap pt 8', async () => {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(2))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(true)
      await pool.initialize(sqrtPriceX96Initial)

      results8 = await feesAfterSwapTest(pool, false, false)

      expect(results8.feeGrowthGlobal0X128).eq(0) // no fees in this direction
      expect(results8.feeGrowthGlobal1X128).eq(0) // earned fees but withheld
      expect(results8.position2.tokensOwed0).eq(0)
      expect(results8.position2.tokensOwed1).eq(0)
      let swapAmountIn = WeiPerEther // swapped in 1 eth
      let expectedFees = swapAmountIn.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      expect(results8.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results8.swapFeesAccumulated1).eq(expectedFees) // some withheld fees
      expect(results8.slot0_2.sqrtPriceX96).eq(results8.slot0_1.sqrtPriceX96) // no price change
    })
    // same as test 3 but with swap direction reversed
    // token0 is base token, fees earned in token0, expect fees to not be earned by LPs
    it('can collect fees from a pool after swap pt 9', async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(1))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(true)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results9 = await feesAfterSwapTest(pool, false, false)

      expect(results9.feeGrowthGlobal0X128).eq(0) // no fees in this direction
      expect(results9.feeGrowthGlobal1X128).gt(0) // earned fees. not withheld
      expect(results9.position2.tokensOwed0).eq(0)
      expect(results9.position2.tokensOwed1).gt(0)
      expect(results9.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results9.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results9.slot0_2.sqrtPriceX96).eq(results9.slot0_1.sqrtPriceX96) // no price change
    })
    // default test but with distribution
    // no base tokens - no effect
    it('can collect fees from a pool after swap pt 10', async () => {
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(0))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results10 = await feesAfterSwapTest(pool, true, false)

      expect(results10.feeGrowthGlobal0X128).eq(0) // no fees in this direction
      expect(results10.feeGrowthGlobal1X128).gt(0) // earned fees. not withheld
      expect(results10.position2.tokensOwed0).eq(0)
      expect(results10.position2.tokensOwed1).gt(0)
      expect(results10.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results10.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results10.slot0_2.sqrtPriceX96).eq(results10.slot0_1.sqrtPriceX96) // no price change
    })
    // same as test 2 but with distribution and different swap direction
    // token1 is base token, fees earned in token1, distributes
    it('can collect fees from a pool after swap pt 11', async () => {
      await factory.setTokenSettings([
        {
          token: token1.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(2))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(false)
      expect(tokenSettings.isBaseToken1).to.eq(true)
      await pool.initialize(sqrtPriceX96Initial)

      results11 = await feesAfterSwapTest(pool, true, false)

      expect(results11.feeGrowthGlobal0X128).gt(0) // earned fees after redistribution
      expect(results11.feeGrowthGlobal1X128).eq(0) // earned fees but withheld
      expect(results11.position2.tokensOwed0).gt(0) // getting swap fees
      expect(results11.position2.tokensOwed1).eq(0)
      let swapAmountIn = WeiPerEther // swapped in 1 eth
      let expectedFees = swapAmountIn.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      let expectedFees2 = expectedFees.mul(5).div(10_000) // 0.05% fee tier = 5 bps
      expect(results11.swapFeesAccumulated0).eq(0) // no withheld fees on this side
      expect(results11.swapFeesAccumulated1).eq(expectedFees2) // fees have been distributed, but distributing creates more fees
      expect(results11.slot0_2.sqrtPriceX96).gt(results11.slot0_1.sqrtPriceX96) // price increased from distribution. greater than because 0/1
    })
    // same as test 3 but with distribution
    // token0 is base token, fees earned in token0, fees are swapped for more token1
    it('can collect fees from a pool after swap pt 12', async () => {
      await factory.setTokenSettings([
        {
          token: token0.address,
          settings: toBytes32(1)
        }
      ])
      const { pool } = await createAndCheckPool([token0.address, token1.address], FeeAmount.LOW)
      expect(await pool.poolTokenSettings()).to.eq(toBytes32(1))
      let tokenSettings = await pool.getPoolTokenSettings()
      expect(tokenSettings.isBaseToken0).to.eq(true)
      expect(tokenSettings.isBaseToken1).to.eq(false)
      await pool.initialize(sqrtPriceX96Initial)

      results12 = await feesAfterSwapTest(pool, true, false)

      expect(results12.feeGrowthGlobal0X128).eq(0) // no fees in this direction
      expect(results12.feeGrowthGlobal1X128).gt(0) // earned fees. not withheld
      expect(results12.position2.tokensOwed0).eq(0)
      expect(results12.position2.tokensOwed1).gt(0)
      expect(results12.swapFeesAccumulated0).eq(0) // no withheld fees
      expect(results12.swapFeesAccumulated1).eq(0) // no withheld fees
      expect(results12.slot0_2.sqrtPriceX96).eq(results12.slot0_1.sqrtPriceX96) // no price change
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

    return { diff0, diff1 }
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
})
