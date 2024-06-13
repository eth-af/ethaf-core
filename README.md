# ETH AF Core

Core smart contracts of ETH AF


This repository contains the core smart contracts for the ETH AF Protocol.
For higher level contracts, see the [ethaf-periphery](https://github.com/wwHysenberg/ethaf-periphery)
repository.

## Local deployment

In order to deploy this code to a local testnet, you should install the npm package
`@ethaf/ethaf-core`
and import the factory bytecode located at
`@ethaf/ethaf-core/artifacts/contracts/EthAfFactory.sol/EthAfFactory.json`.
For example:

```typescript
import {
  abi as FACTORY_ABI,
  bytecode as FACTORY_BYTECODE,
} from '@ethaf/ethaf-core/artifacts/contracts/EthAfFactory.sol/EthAfFactory.json'

// deploy the bytecode
```

This will ensure that you are testing against the same bytecode that is deployed to
mainnet and public testnets, and all ETH AF code will correctly interoperate with
your local deployment.

## Using solidity interfaces

The ETH AF interfaces are available for import into solidity smart contracts
via the npm artifact `@ethaf/ethaf-core`, e.g.:

```solidity
import '@ethaf/ethaf-core/contracts/interfaces/IEthAfPool.sol';

contract MyContract {
  IEthAfPool pool;

  function doSomethingWithPool() {
    // pool.swap(...);
  }
}

```

## Licensing

The primary license for ETH AF Core is `GPL-2.0-or-later`

### Other Exceptions

- `contracts/libraries/FullMath.sol` is licensed under `MIT` (as indicated in its SPDX header), see [`contracts/libraries/LICENSE_MIT`](contracts/libraries/LICENSE_MIT)
- All files in `contracts/test` remain unlicensed (as indicated in their SPDX headers).
