import { BigNumber, BigNumberish, Wallet, ContractTransaction } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { EthAfFactory } from '../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../typechain/EthAfPoolDeployerModule'
import { EthAfSwapFeeDistributor } from '../typechain/EthAfSwapFeeDistributor'
import { EthAfPool } from '../typechain/EthAfPool'
import { TestERC20 } from '../typechain/TestERC20'
import { TestEthAfCallee } from '../typechain/TestEthAfCallee'
import { MockFlasher } from '../typechain/MockFlasher'
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

const TEST_ADDRESSES: [string, string] = [
  '0x1000000000000000000000000000000000000000',
  '0x2000000000000000000000000000000000000000',
]


const createFixtureLoader = waffle.createFixtureLoader

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T
type PoolFunctions = ReturnType<typeof createPoolFunctions>

const sqrtPriceX96Initial = encodePriceSqrt(1, 1)

describe('EthAfPoolWithBaseToken4', () => {
  let wallet: Wallet, other: Wallet

  let factory: EthAfFactory
  let poolDeployerModule: EthAfPoolDeployerModule
  let swapFeeDistributor: EthAfSwapFeeDistributor
  let poolBytecode: string

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20
  let token3: TestERC20

  let swapTargetCallee: TestEthAfCallee

  let mockFlasher: MockFlasher

  let pools: any[];
  let pool0: any;
  let pool1: any;
  let pool2: any;
  let pool3: any;
  let pool4: any;
  let pool5: any;
  let pool6: any;
  let pool7: any;
  let pool8: any;
  let poolsLength = 9
  let poolFunctions: any[];
  let poolFunctions1: any;
  let poolFunctions2: any;
  let poolFunctions3: any;
  let poolFunctions4: any;
  let poolFunctions5: any;
  let poolFunctions6: any;
  let poolFunctions7: any;
  let poolFunctions8: any;


  let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  const fixtureWithPools = async () => {
    let fixtureResponse = await loadFixture(poolFixture)
    factory = fixtureResponse.factory
    factory = fixtureResponse.factory
    poolDeployerModule = fixtureResponse.poolDeployerModule
    swapFeeDistributor = fixtureResponse.swapFeeDistributor
    token0 = fixtureResponse.token0
    token1 = fixtureResponse.token1
    token2 = fixtureResponse.token2
    token3 = fixtureResponse.token3
    createPool = fixtureResponse.createPool
    swapTargetCallee = fixtureResponse.swapTargetCallee

    const tkn0 = fixtureResponse.token0.address // pump token 0
    const tkn1 = fixtureResponse.token1.address // usdb
    const tkn2 = fixtureResponse.token2.address // weth
    const tkn3 = fixtureResponse.token3.address // pump token 3

    await fixtureResponse.factory.setTokenSettings([
      {
        token: tkn1,
        settings: FactoryTokenSettings.IS_BASE_TOKEN_USD_MASK,
      },
      {
        token: tkn2,
        settings: FactoryTokenSettings.IS_BASE_TOKEN_ETH_MASK,
      }
    ]) // others are pump tokens

    // non erc20s
    const res0 = await createAndCheckPool([TEST_ADDRESSES[0], TEST_ADDRESSES[1]], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.NO_BASE_TOKEN)
    pool0 = res0.pool
    // usdb/weth pairs
    const res1 = await createAndCheckPool([tkn1, tkn2], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
    pool1 = res1.pool
    const res2 = await createAndCheckPool([tkn1, tkn2], FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM], PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
    pool2 = res2.pool
    const res3 = await createAndCheckPool([tkn1, tkn2], FeeAmount.HIGH, TICK_SPACINGS[FeeAmount.HIGH], PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
    pool3 = res3.pool
    // test combos
    const res4 = await createAndCheckPool([tkn0, tkn1], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_TOKEN1_BASE_TOKEN_MASK)
    pool4 = res4.pool
    const res5 = await createAndCheckPool([tkn0, tkn2], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_TOKEN1_BASE_TOKEN_MASK)
    pool5 = res5.pool
    const res6 = await createAndCheckPool([tkn0, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.NO_BASE_TOKEN)
    pool6 = res6.pool
    const res7 = await createAndCheckPool([tkn1, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
    pool7 = res7.pool
    const res8 = await createAndCheckPool([tkn2, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_TOKEN0_BASE_TOKEN_MASK)
    pool8 = res8.pool

    pools = [pool0, pool1, pool2, pool3, pool4, pool5, pool6, pool7, pool8]

    await pool0.initialize(sqrtPriceX96Initial)
    await pool1.initialize(sqrtPriceX96Initial)
    await pool2.initialize(sqrtPriceX96Initial)
    await pool3.initialize(sqrtPriceX96Initial)
    await pool4.initialize(sqrtPriceX96Initial)
    await pool5.initialize(sqrtPriceX96Initial)
    await pool6.initialize(sqrtPriceX96Initial)
    await pool7.initialize(sqrtPriceX96Initial)
    await pool8.initialize(sqrtPriceX96Initial)

    poolFunctions = [
      undefined,
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token1, token1: token2, pool: pool1 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token1, token1: token2, pool: pool2 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token1, token1: token2, pool: pool3 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token0, token1: token1, pool: pool4 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token0, token1: token2, pool: pool5 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token0, token1: token3, pool: pool6 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token1, token1: token3, pool: pool7 }),
      createPoolFunctions({ swapTarget: swapTargetCallee, token0: token2, token1: token3, pool: pool8 }),
    ]
    poolFunctions1 = poolFunctions[1]
    poolFunctions2 = poolFunctions[2]
    poolFunctions3 = poolFunctions[3]
    poolFunctions4 = poolFunctions[4]
    poolFunctions5 = poolFunctions[5]
    poolFunctions6 = poolFunctions[6]
    poolFunctions7 = poolFunctions[7]
    poolFunctions8 = poolFunctions[8]

    const flasherFactory = await ethers.getContractFactory('MockFlasher')
    mockFlasher = (await flasherFactory.deploy()) as MockFlasher

    return {
      ...fixtureResponse,
      pools,
      mockFlasher,
      poolFunctions,
    }
  }

  let loadFixture: ReturnType<typeof createFixtureLoader>
  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    loadFixture = createFixtureLoader([wallet, other])
  })

  before('load pool bytecode', async () => {
    poolBytecode = (await ethers.getContractFactory('EthAfPool')).bytecode
  })

  beforeEach('deploy factory and pools', async () => {
    let fixtureResponse:any = await loadFixture(fixtureWithPools)
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

    const len = await factory.allPoolsLength()
    const index = len.sub(1)
    expect(await factory.allPools(index)).to.eq(create2Address)

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

  describe("distributor", function () {
    it('initializes correctly', async function () {
      expect(pools.length).eq(poolsLength)
      expect(await swapFeeDistributor.nextPoolIndex()).eq(0)
      expect(await swapFeeDistributor.safeGasStartLoop()).eq(330_000)
      expect(await swapFeeDistributor.safeGasForDistribute()).eq(300_000)
    })

    it('reverts if pool has non erc20s 1', async function () {
      await expect(swapFeeDistributor.distributeFeesForPool(pool0.address)).to.be.reverted
    })
    it('reverts if pool has non erc20s 2', async function () {
      await expect(swapFeeDistributor.distributeFeesForPools([pool0.address])).to.be.reverted
    })

    it('can fail gracefully using try 1', async function () {
      let success = await swapFeeDistributor.callStatic.tryDistributeFeesForPool(pool0.address)
      expect(success).to.be.false
      await expect(swapFeeDistributor.tryDistributeFeesForPool(pool0.address)).to.not.be.reverted
    })
    it('can fail gracefully using try 2', async function () {
      let success = await swapFeeDistributor.callStatic.tryDistributeFeesForPools([pool0.address])
      expect(success.length).to.eq(1)
      expect(success[0]).to.be.false
      await expect(swapFeeDistributor.tryDistributeFeesForPools([pool0.address])).to.not.be.reverted
    })

    it('can distribute one pool with no liquidity', async function () {
      let p = swapFeeDistributor.distributeFeesForPool(pool1.address)
      let tx = await p
      await expect(p).to.not.emit(pool1, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })
    it('can distribute one pool with no rewards', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)

      let p = swapFeeDistributor.distributeFeesForPool(pool1.address)
      let tx = await p
      await expect(p).to.not.emit(pool1, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })
    it('can distribute one pool with rewards', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      let p = swapFeeDistributor.distributeFeesForPool(pool1.address)
      let tx = await p
      await expect(p).to.emit(pool1, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })

    it('can try distribute one pool', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      let success = await swapFeeDistributor.callStatic.tryDistributeFeesForPool(pool1.address)
      expect(success).to.be.true

      let p = swapFeeDistributor.tryDistributeFeesForPool(pool1.address)
      let tx = await p
      await expect(p).to.emit(pool1, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })

    it('can distribute multiple pools', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const mintPosition2 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions2.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      const amount1_1 = WeiPerEther.mul(3)
      const amount2_1 = WeiPerEther.mul(7)
      await token1.transfer(mockFlasher.address, amount1_1)
      await token2.transfer(mockFlasher.address, amount2_1)
      await mockFlasher.flash(pool2.address, 0, 0) // distribute fees

      let p = swapFeeDistributor.distributeFeesForPools([pool1.address, pool2.address])
      let tx = await p
      await expect(p).to.emit(pool1, "Swap")
      await expect(p).to.emit(pool2, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })
    it('can try distribute multiple pools', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const mintPosition2 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions2.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      const amount1_1 = WeiPerEther.mul(3)
      const amount2_1 = WeiPerEther.mul(7)
      await token1.transfer(mockFlasher.address, amount1_1)
      await token2.transfer(mockFlasher.address, amount2_1)
      await mockFlasher.flash(pool2.address, 0, 0) // distribute fees

      let success = await swapFeeDistributor.callStatic.tryDistributeFeesForPools([pool1.address, pool2.address])
      expect(success.length).to.eq(2)
      expect(success[0]).to.be.true
      expect(success[1]).to.be.true

      let p = swapFeeDistributor.tryDistributeFeesForPools([pool1.address, pool2.address])
      let tx = await p
      await expect(p).to.emit(pool1, "Swap")
      await expect(p).to.emit(pool2, "Swap")
      let receipt = await tx.wait()
      //console.log(`gasUsed: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    })

    it('can loop over multiple pools', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const mintPosition2 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions2.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      const amount1_1 = WeiPerEther.mul(3)
      const amount2_1 = WeiPerEther.mul(7)
      await token1.transfer(mockFlasher.address, amount1_1)
      await token2.transfer(mockFlasher.address, amount2_1)
      await mockFlasher.flash(pool2.address, 0, 0) // distribute fees

      expect(await swapFeeDistributor.nextPoolIndex()).eq(0)

      // start loop - first 3 pools
      let p1 = swapFeeDistributor.tryDistributeFactoryLoop({gasLimit: 600_000})
      let tx1 = await p1
      expect(await swapFeeDistributor.nextPoolIndex()).eq(3)
      await expect(p1).to.emit(pool1, "Swap")
      await expect(p1).to.emit(pool2, "Swap")
      await expect(p1).to.emit(swapFeeDistributor, "SwapFeesDistributed").withArgs(pool1.address)
      await expect(p1).to.emit(swapFeeDistributor, "SwapFeesDistributed").withArgs(pool2.address)
      let receipt1 = await tx1.wait()
      //console.log(`gasUsed: ${receipt1.gasUsed.toNumber().toLocaleString()}`)

      // next loop - next 4 pools
      let p2 = swapFeeDistributor.tryDistributeFactoryLoop({gasLimit: 470_000})
      let tx2 = await p2
      expect(await swapFeeDistributor.nextPoolIndex()).eq(7)
      await expect(p2).to.not.emit(pool1, "Swap") // not in this iter
      await expect(p2).to.not.emit(pool2, "Swap")
      await expect(p2).to.not.emit(pool3, "Swap") // no swap required
      await expect(p2).to.not.emit(pool4, "Swap")
      await expect(p2).to.not.emit(pool5, "Swap")
      await expect(p2).to.not.emit(pool6, "Swap")
      await expect(p2).to.not.emit(swapFeeDistributor, "SwapFeesDistributed")
      let receipt2 = await tx2.wait()
      //console.log(`gasUsed: ${receipt2.gasUsed.toNumber().toLocaleString()}`)

      // finish loop and reset
      let p3 = swapFeeDistributor.tryDistributeFactoryLoop({gasLimit: 1_000_000})
      let tx3 = await p3
      expect(await swapFeeDistributor.nextPoolIndex()).eq(0)
      let receipt3 = await tx3.wait()
      //console.log(`gasUsed: ${receipt3.gasUsed.toNumber().toLocaleString()}`)

      // whole loop
      let p4 = swapFeeDistributor.tryDistributeFactoryLoop({gasLimit: 10_000_000})
      let tx4 = await p4
      expect(await swapFeeDistributor.nextPoolIndex()).eq(0)
      let receipt4 = await tx4.wait()
      //console.log(`gasUsed: ${receipt4.gasUsed.toNumber().toLocaleString()}`)
    })
  })

  describe("setSafeGasPerLoop", function () {
    it("cannot be set by non owner", async function () {
      await expect(swapFeeDistributor.connect(other).setSafeGasPerLoop(1,1)).to.be.reverted
    })
    it("owner can set", async function () {
      let gasLimitStart = 600_000
      let gasLimitDistribute = 500_000
      let p = swapFeeDistributor.setSafeGasPerLoop(gasLimitStart, gasLimitDistribute)
      let tx = await p
      await expect(p).to.emit(swapFeeDistributor, "SetSafeGasPerLoop").withArgs(gasLimitStart, gasLimitDistribute)
      expect(await swapFeeDistributor.safeGasStartLoop()).eq(gasLimitStart)
      expect(await swapFeeDistributor.safeGasForDistribute()).eq(gasLimitDistribute)
    })
    it('can loop using new fees', async function () {
      let gasLimitStart = 600_000
      let gasLimitDistribute = 500_000
      await swapFeeDistributor.setSafeGasPerLoop(gasLimitStart, gasLimitDistribute)

      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)
      const mintPosition2 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions2.mint(wallet.address, mintPosition2.tickLower, mintPosition2.tickUpper, mintPosition2.liquidity)

      const amount1_0 = WeiPerEther
      const amount2_0 = WeiPerEther.mul(2)
      await token1.transfer(mockFlasher.address, amount1_0)
      await token2.transfer(mockFlasher.address, amount2_0)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      const amount1_1 = WeiPerEther.mul(3)
      const amount2_1 = WeiPerEther.mul(7)
      await token1.transfer(mockFlasher.address, amount1_1)
      await token2.transfer(mockFlasher.address, amount2_1)
      await mockFlasher.flash(pool2.address, 0, 0) // distribute fees

      expect(await swapFeeDistributor.nextPoolIndex()).eq(0)

      // start loop - first 3 pools
      let p1 = swapFeeDistributor.tryDistributeFactoryLoop({gasLimit: 900_000}) // same test requires more gas because higher gas limits
      let tx1 = await p1
      expect(await swapFeeDistributor.nextPoolIndex()).eq(3)
      await expect(p1).to.emit(pool1, "Swap")
      await expect(p1).to.emit(pool2, "Swap")
      await expect(p1).to.emit(swapFeeDistributor, "SwapFeesDistributed").withArgs(pool1.address)
      await expect(p1).to.emit(swapFeeDistributor, "SwapFeesDistributed").withArgs(pool2.address)
      let receipt1 = await tx1.wait()
      //console.log(`gasUsed: ${receipt1.gasUsed.toNumber().toLocaleString()}`) // uses the same amount of gas
    })
  })
})
