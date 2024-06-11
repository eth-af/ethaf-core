import { BigNumber, BigNumberish, Wallet, ContractTransaction } from 'ethers'
import { ethers, waffle } from 'hardhat'
import { EthAfFactory } from '../typechain/EthAfFactory'
import { EthAfPoolDeployerModule } from '../typechain/EthAfPoolDeployerModule'
import { EthAfSwapFeeDistributor } from '../typechain/EthAfSwapFeeDistributor'
import { EthAfPool } from '../typechain/EthAfPool'
import { TestERC20 } from '../typechain/TestERC20'
import { TestEthAfCallee } from '../typechain/TestEthAfCallee'
import { MockFlasher } from '../typechain/MockFlasher'
import { MockBlast } from '../typechain/MockBlast'
import { MockBlastPoints } from '../typechain/MockBlastPoints'
import { MockERC20Rebasing } from '../typechain/MockERC20Rebasing'
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

describe('EthAfPoolWithBaseToken5', () => {
  let wallet: Wallet, other: Wallet

  let factory: EthAfFactory
  let poolDeployerModule: EthAfPoolDeployerModule
  let swapFeeDistributor: EthAfSwapFeeDistributor
  let poolBytecode: string

  let usdb: MockERC20Rebasing
  let weth: MockERC20Rebasing

  let token0: TestERC20
  let token1: MockERC20Rebasing
  let token2: MockERC20Rebasing
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

  let mockBlast: MockBlast
  let mockBlastPoints: MockBlastPoints

  //let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  const fixtureWithPools = async () => {
    const mockBlastFactory = await ethers.getContractFactory('MockBlast')
    mockBlast = (await mockBlastFactory.deploy()) as MockBlast
    const mockBlastPointsFactory = await ethers.getContractFactory('MockBlastPoints')
    mockBlastPoints = (await mockBlastPointsFactory.deploy()) as MockBlastPoints

    const poolDeployerModuleFactory = await ethers.getContractFactory('EthAfPoolDeployerModule')
    poolDeployerModule = (await poolDeployerModuleFactory.deploy()) as EthAfPoolDeployerModule
    const factoryFactory = await ethers.getContractFactory('EthAfFactory')
    //const factory = (await factoryFactory.deploy(poolDeployerModule.address)) as EthAfFactory
    factory = (await factoryFactory.deploy(poolDeployerModule.address, mockBlast.address, mockBlastPoints.address, wallet.address, wallet.address)) as EthAfFactory
    const swapFeeDistributorFactory = await ethers.getContractFactory('EthAfSwapFeeDistributor')
    swapFeeDistributor = (await swapFeeDistributorFactory.deploy(factory.address)) as EthAfSwapFeeDistributor
    await factory.setSwapFeeDistributor(swapFeeDistributor.address)

    const tokenFactory = await ethers.getContractFactory('TestERC20')
    const rebasingTokenFactory = await ethers.getContractFactory('MockERC20Rebasing')

    const tokenA = (await rebasingTokenFactory.deploy(BigNumber.from(2).pow(200))) as MockERC20Rebasing
    const tokenB = (await rebasingTokenFactory.deploy(BigNumber.from(2).pow(200))) as MockERC20Rebasing
    [usdb, weth] = [tokenA, tokenB].sort((tokenA, tokenB) =>
      tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1
    )
    token1 = usdb
    token2 = weth

    // keep rolling to get tokens in order
    token0 = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
    while(token0.address.toLowerCase() >= token1.address.toLowerCase()) {
      token0 = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
    }
    token3 = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
    while(token3.address.toLowerCase() <= token2.address.toLowerCase()) {
      token3 = (await tokenFactory.deploy(BigNumber.from(2).pow(255))) as TestERC20
    }

    const calleeContractFactory = await ethers.getContractFactory('TestEthAfCallee')
    swapTargetCallee = (await calleeContractFactory.deploy()) as TestEthAfCallee

    const tkn0 = token0.address // pump token 0
    const tkn1 = token1.address // usdb
    const tkn2 = token2.address // weth
    const tkn3 = token3.address // pump token 3

    await factory.setTokenSettings([
      {
        token: tkn1,
        settings: FactoryTokenSettings.USDB_FLAGS,
      },
      {
        token: tkn2,
        settings: FactoryTokenSettings.WETH_FLAGS,
      }
    ]) // others are pump tokens

    // non erc20s
    const res0 = await createAndCheckPool([TEST_ADDRESSES[0], TEST_ADDRESSES[1]], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.NO_BASE_TOKEN)
    pool0 = res0.pool
    // usdb/weth pairs
    const res1 = await createAndCheckPool([tkn1, tkn2], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.USDB_WETH_POOL_FLAGS)
    pool1 = res1.pool
    const res2 = await createAndCheckPool([tkn1, tkn2], FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM], PoolTokenSettings.USDB_WETH_POOL_FLAGS)
    pool2 = res2.pool
    const res3 = await createAndCheckPool([tkn1, tkn2], FeeAmount.HIGH, TICK_SPACINGS[FeeAmount.HIGH], PoolTokenSettings.USDB_WETH_POOL_FLAGS)
    pool3 = res3.pool
    // test combos
    const res4 = await createAndCheckPool([tkn0, tkn1], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_USDB_TOKEN1_FLAGS)
    pool4 = res4.pool
    const res5 = await createAndCheckPool([tkn0, tkn2], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_WETH_TOKEN1_FLAGS)
    pool5 = res5.pool
    const res6 = await createAndCheckPool([tkn0, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.NO_BASE_TOKEN)
    pool6 = res6.pool
    const res7 = await createAndCheckPool([tkn1, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_USDB_TOKEN0_FLAGS)
    pool7 = res7.pool
    const res8 = await createAndCheckPool([tkn2, tkn3], FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW], PoolTokenSettings.IS_WETH_TOKEN0_FLAGS)
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
      //...fixtureResponse,
      //pools,
      //mockFlasher,
      //poolFunctions,
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

  enum YieldMode {
      AUTOMATIC,
      VOID,
      CLAIMABLE
  }

  describe("blast settings", function () {
    it('pool configured blast successfully', async function () {
      expect(await mockBlast.isConfiguredAutomaticYield(pool1.address)).to.be.false
      expect(await mockBlast.isConfiguredClaimableGas(pool1.address)).to.be.true
      expect(await mockBlast.getGovernor(pool1.address)).to.eq(wallet.address)
      expect(await mockBlastPoints.operators(pool1.address)).to.eq(wallet.address)
    })
    it('pool configured native yield successfully', async function () {
      expect(await weth.userModes(pool0.address)).to.eq(YieldMode.AUTOMATIC) // not in pool
      expect(await usdb.userModes(pool0.address)).to.eq(YieldMode.AUTOMATIC)
      expect(await weth.userModes(pool1.address)).to.eq(YieldMode.CLAIMABLE) // in pool
      expect(await usdb.userModes(pool1.address)).to.eq(YieldMode.CLAIMABLE)
      expect(await weth.userModes(pool8.address)).to.eq(YieldMode.CLAIMABLE)
      expect(await usdb.userModes(pool8.address)).to.eq(YieldMode.AUTOMATIC)
    })
    it('factory has correct blast parameters', async function () {
      let blastParameters = await factory.blastParameters()
      expect(blastParameters.blast).eq(mockBlast.address)
      expect(blastParameters.blastPoints).eq(mockBlastPoints.address)
      expect(blastParameters.gasCollector).eq(wallet.address)
      expect(blastParameters.pointsOperator).eq(wallet.address)
    })
  })

  describe("distributing native yield", function () {
    it('can distribute one pool with rewards', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)

      // regular distribute, no native yield

      const balP0 = await getBalances(pool1.address)

      const amountUsdb_1 = WeiPerEther.mul(100)
      const amountWeth_1 = WeiPerEther.div(10)
      await usdb.transfer(mockFlasher.address, amountUsdb_1)
      await weth.transfer(mockFlasher.address, amountWeth_1)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      let p1 = swapFeeDistributor.distributeFeesForPool(pool1.address)
      let tx1 = await p1
      const balP1 = await getBalances(pool1.address)
      let diffP01 = checkBalanceDiff(balP0, balP1, false, "pool")
      expect(diffP01.usdb).eq(amountUsdb_1)
      expect(diffP01.weth).eq(amountWeth_1)

      let swapFeesAccumulated0_1 = await pool1.swapFeesAccumulated0()
      expect(swapFeesAccumulated0_1).to.eq(amountUsdb_1.mul(5).div(10_000)) // swap fees from 5 bps

      await expect(p1).to.emit(pool1, "Swap")
      await expect(p1).to.emit(usdb, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, amountUsdb_1)
      let receipt1 = await tx1.wait()
      //console.log(`gasUsed: ${receipt1.gasUsed.toNumber().toLocaleString()}`)

      // with native yield enabled

      const amountUsdb_2 = WeiPerEther.mul(500)
      const amountWeth_2 = WeiPerEther.mul(2)
      await usdb.setClaimableAmount(amountUsdb_2)
      await weth.setClaimableAmount(amountWeth_2)
      expect(await usdb.claimableAmount()).eq(amountUsdb_2)
      expect(await weth.claimableAmount()).eq(amountWeth_2)
      expect(await usdb.getClaimableAmount(pool1.address)).eq(amountUsdb_2)
      expect(await weth.getClaimableAmount(pool1.address)).eq(amountWeth_2)

      let p2 = swapFeeDistributor.distributeFeesForPool(pool1.address)
      let tx2 = await p2

      const balP2 = await getBalances(pool1.address)
      let diffP12 = checkBalanceDiff(balP1, balP2, false, "pool")
      expect(diffP12.usdb).eq(amountUsdb_2)
      expect(diffP12.weth).eq(amountWeth_2)

      let swapFeesAccumulated0_2 = await pool1.swapFeesAccumulated0()
      let expectedUsdbTransferAmount = amountUsdb_2.add(swapFeesAccumulated0_1)
      let expectedSwapFees = expectedUsdbTransferAmount.mul(5).div(10_000)
      expect(swapFeesAccumulated0_2).to.eq(expectedSwapFees) // swap fees from 5 bps

      await expect(p2).to.emit(pool1, "Swap")
      await expect(p2).to.emit(usdb, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, expectedUsdbTransferAmount)
      await expect(p2).to.emit(weth, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, amountWeth_2)

      let receipt2 = await tx2.wait()
      //console.log(`gasUsed: ${receipt2.gasUsed.toNumber().toLocaleString()}`)
    })

    it('can try distribute one pool', async function () {
      const mintPosition1 = {
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.LOW]), // full range
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.LOW]),
        liquidity: expandTo18Decimals(10_000), // ~10,000 of each token
      }
      await poolFunctions1.mint(wallet.address, mintPosition1.tickLower, mintPosition1.tickUpper, mintPosition1.liquidity)

      // regular distribute, no native yield

      const balP0 = await getBalances(pool1.address)

      const amountUsdb_1 = WeiPerEther.mul(100)
      const amountWeth_1 = WeiPerEther.div(10)
      await usdb.transfer(mockFlasher.address, amountUsdb_1)
      await weth.transfer(mockFlasher.address, amountWeth_1)
      await mockFlasher.flash(pool1.address, 0, 0) // distribute fees

      let p1 = swapFeeDistributor.tryDistributeFeesForPool(pool1.address)
      let tx1 = await p1
      const balP1 = await getBalances(pool1.address)
      let diffP01 = checkBalanceDiff(balP0, balP1, false, "pool")
      expect(diffP01.usdb).eq(amountUsdb_1)
      expect(diffP01.weth).eq(amountWeth_1)

      let swapFeesAccumulated0_1 = await pool1.swapFeesAccumulated0()
      expect(swapFeesAccumulated0_1).to.eq(amountUsdb_1.mul(5).div(10_000)) // swap fees from 5 bps

      await expect(p1).to.emit(pool1, "Swap")
      await expect(p1).to.emit(usdb, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, amountUsdb_1)
      let receipt1 = await tx1.wait()
      //console.log(`gasUsed: ${receipt1.gasUsed.toNumber().toLocaleString()}`)

      // with native yield enabled

      const amountUsdb_2 = WeiPerEther.mul(500)
      const amountWeth_2 = WeiPerEther.mul(2)
      await usdb.setClaimableAmount(amountUsdb_2)
      await weth.setClaimableAmount(amountWeth_2)
      expect(await usdb.claimableAmount()).eq(amountUsdb_2)
      expect(await weth.claimableAmount()).eq(amountWeth_2)
      expect(await usdb.getClaimableAmount(pool1.address)).eq(amountUsdb_2)
      expect(await weth.getClaimableAmount(pool1.address)).eq(amountWeth_2)

      let p2 = swapFeeDistributor.tryDistributeFeesForPool(pool1.address)
      let tx2 = await p2

      const balP2 = await getBalances(pool1.address)
      let diffP12 = checkBalanceDiff(balP1, balP2, false, "pool")
      expect(diffP12.usdb).eq(amountUsdb_2)
      expect(diffP12.weth).eq(amountWeth_2)

      let swapFeesAccumulated0_2 = await pool1.swapFeesAccumulated0()
      let expectedUsdbTransferAmount = amountUsdb_2.add(swapFeesAccumulated0_1)
      let expectedSwapFees = expectedUsdbTransferAmount.mul(5).div(10_000)
      expect(swapFeesAccumulated0_2).to.eq(expectedSwapFees) // swap fees from 5 bps

      await expect(p2).to.emit(pool1, "Swap")
      await expect(p2).to.emit(usdb, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, expectedUsdbTransferAmount)
      await expect(p2).to.emit(weth, "Transfer").withArgs(pool1.address, swapFeeDistributor.address, amountWeth_2)

      let receipt2 = await tx2.wait()
      //console.log(`gasUsed: ${receipt2.gasUsed.toNumber().toLocaleString()}`)
    })
  })

  async function getBalances(address:string) {
    return {
      //token0: await token0.balanceOf(address),
      //token1: await token1.balanceOf(address),
      //token2: await token2.balanceOf(address),
      //token3: await token3.balanceOf(address),
      usdb: await usdb.balanceOf(address),
      weth: await weth.balanceOf(address),
    }
  }

  function checkBalanceDiff(b0:any, b1:any, log=false, name="") {
    //let diff0 = b1.token0.sub(b0.token0)
    //let diff1 = b1.token1.sub(b0.token1)
    //let diff2 = b1.token2.sub(b0.token2)
    //let diff3 = b1.token3.sub(b0.token3)

    let diffUsdb = b1.usdb.sub(b0.usdb)
    let diffWeth = b1.weth.sub(b0.weth)

    if(log) {
      /*
      if(diff0.gt(0)) console.log(`${name} token0 balance increased by ${formatUnits(diff0)}`)
      else if(diff0.lt(0)) console.log(`${name} token0 balance decreased by ${formatUnits(diff0.mul(-1))}`)
      else console.log(`${name} token0 balance did not change`)

      if(diff1.gt(0)) console.log(`${name} token1 balance increased by ${formatUnits(diff1)}`)
      else if(diff1.lt(0)) console.log(`${name} token1 balance decreased by ${formatUnits(diff1.mul(-1))}`)
      else console.log(`${name} token1 balance did not change`)

      if(diff2.gt(0)) console.log(`${name} token2 balance increased by ${formatUnits(diff2)}`)
      else if(diff2.lt(0)) console.log(`${name} token2 balance decreased by ${formatUnits(diff2.mul(-1))}`)
      else console.log(`${name} token2 balance did not change`)

      if(diff3.gt(0)) console.log(`${name} token3 balance increased by ${formatUnits(diff3)}`)
      else if(diff3.lt(0)) console.log(`${name} token3 balance decreased by ${formatUnits(diff3.mul(-1))}`)
      else console.log(`${name} token3 balance did not change`)
      */
      if(diffUsdb.gt(0)) console.log(`${name} usdb balance increased by ${formatUnits(diffUsdb)}`)
      else if(diffUsdb.lt(0)) console.log(`${name} usdb balance decreased by ${formatUnits(diffUsdb.mul(-1))}`)
      else console.log(`${name} usdb balance did not change`)

      if(diffWeth.gt(0)) console.log(`${name} weth balance increased by ${formatUnits(diffWeth)}`)
      else if(diffWeth.lt(0)) console.log(`${name} weth balance decreased by ${formatUnits(diffWeth.mul(-1))}`)
      else console.log(`${name} weth balance did not change`)
    }

    //return { token0: diff0, token1: diff1, token2: diff2, token3: diff3 }
    return { usdb: diffUsdb, weth: diffWeth }
  }
})
