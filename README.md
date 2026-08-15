# Web3 Nexus

A fullstack Ethereum staking and yield reference implementation. Users stake ETH into a
Solidity contract, choose a lockup tier that sets their yield multiplier, and claim an
ERC-20 utility token (`NEX`) minted against accrued rewards.

The repository is a Bun workspace monorepo with two packages: the Hardhat contract
environment and a Next.js frontend that talks to it over Wagmi/Viem.

> **This project targets a local Hardhat chain (chain ID 31337).** The contract has not been
> audited and carries known trust assumptions (see [Security model](#security-model)).
> Do not deploy it to a public network with real funds.

---

## Table of contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Connecting a wallet](#connecting-a-wallet)
- [Contract reference](#contract-reference)
- [Yield math](#yield-math)
- [Security model](#security-model)
- [Testing](#testing)
- [Configuration](#configuration)
- [Available scripts](#available-scripts)

---

## Architecture

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│  packages/frontend           │        │  packages/contracts          │
│  Next.js 14 (App Router)     │        │  Hardhat + Solidity 0.8.24   │
│                              │        │                              │
│  Web3Provider ──► Wagmi ─────┼──JSON──┼──► Web3Nexus.sol             │
│                   RainbowKit │   RPC  │    (ERC20 + staking vault)   │
│                              │        │                              │
│  src/contracts/Web3Nexus.ts ◄┼────────┼── scripts/deploy.ts writes   │
│  (generated address + ABI)   │        │   the address and ABI here   │
└──────────────────────────────┘        └──────────────────────────────┘
```

`scripts/deploy.ts` is the bridge between the two packages. After deploying, it writes the
live contract address and compiled ABI to `packages/frontend/src/contracts/Web3Nexus.ts`,
so the frontend always builds against the contract currently on the chain. That file is
generated output committed for convenience — re-running the deploy overwrites it.

### Stack

| Layer | Technology | Role |
| --- | --- | --- |
| Contract | Solidity `^0.8.24` | `Web3Nexus.sol` — ERC-20 token plus staking vault |
| Contract libs | OpenZeppelin `^5.0` | `ERC20`, `Ownable`, `Pausable`, `ReentrancyGuard` |
| Tooling | Hardhat `^2.22` | Compile, test, local node, deploy |
| Frontend | Next.js `^14.2` (App Router) | Routing, SSR, build pipeline |
| Chain client | Wagmi `^2.9` + Viem `^2.13` | Typed contract reads, writes, event subscriptions |
| Wallet UI | RainbowKit `^2.1` | Wallet connection and chain switching |
| 3D | React Three Fiber + Three.js | Landing page WebGL scene |
| Styling | Plain CSS with custom properties | `globals.css`, no CSS framework |

---

## Repository layout

```text
.
├── packages/
│   ├── contracts/
│   │   ├── contracts/Web3Nexus.sol   Staking vault and NEX token
│   │   ├── scripts/deploy.ts         Deploys and exports address/ABI to the frontend
│   │   ├── test/Web3Nexus.test.ts    Hardhat/Chai test suite
│   │   └── hardhat.config.ts         Solidity compiler and network config
│   └── frontend/
│       ├── src/app/
│       │   ├── page.tsx              Landing page
│       │   ├── dashboard/page.tsx    Staking, cooldown queue, live event log
│       │   ├── admin/page.tsx        Owner-only control panel
│       │   ├── layout.tsx            Root layout and provider tree
│       │   └── globals.css           Design tokens and component styles
│       ├── src/components/           Navigation, Toast, WebGLCanvas
│       ├── src/contracts/            Generated contract address and ABI
│       ├── src/providers/            Wagmi + RainbowKit setup
│       └── next.config.js
└── package.json                      Workspace definition and top-level scripts
```

Build output (`artifacts/`, `cache/`, `typechain-types/`, `.next/`) and `node_modules/`
are ignored — see `.gitignore`.

---

## Prerequisites

- [Bun](https://bun.sh/) `1.x` — package manager and script runner
- A browser wallet such as MetaMask, for interacting with the dashboard

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## Getting started

### 1. Install dependencies

```bash
bun install
```

Bun resolves and links all workspace packages from the repository root.

### 2. Start the local chain

```bash
bun contracts:node
```

Hardhat starts a JSON-RPC node on `http://127.0.0.1:8545` with 20 pre-funded accounts.
**Leave this running in its own terminal** — every later step targets this node.

### 3. Deploy the contract

In a second terminal:

```bash
bun contracts:deploy
```

This compiles `Web3Nexus.sol`, deploys it to the local node, and writes the resulting
address and ABI to `packages/frontend/src/contracts/Web3Nexus.ts`. Re-run it whenever you
restart the node — a fresh node has no deployed contract, and the address may change.

### 4. Start the frontend

```bash
bun dev
```

The app is served at [http://localhost:3000](http://localhost:3000).

---

## Connecting a wallet

The dashboard requires a wallet connected to the local Hardhat chain.

1. Add a custom network in your wallet:

   | Field | Value |
   | --- | --- |
   | Network name | `Hardhat Localhost` |
   | RPC URL | `http://127.0.0.1:8545` |
   | Chain ID | `31337` |
   | Currency symbol | `ETH` |

2. Import a test account. `bun contracts:node` prints 20 accounts with their private keys
   on startup. Account `#0` is the deployer, and therefore the contract owner:

   ```
   Address:     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
   Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
   ```

   > These are Hardhat's standard, publicly documented development keys. They are known to
   > everyone and hold no value outside a local chain. **Never send real funds to them, and
   > never reuse them on a public network.**

3. Visit `/admin` while connected as account `#0` to access owner controls. Connecting any
   other account renders an access-denied state — the contract's `onlyOwner` modifier
   rejects those calls on-chain, and the UI mirrors that check.

---

## Contract reference

`Web3Nexus` is an `ERC20` token (`Nexus Token` / `NEX`) that doubles as the staking vault.
Staked collateral is native ETH; rewards are newly minted NEX.

### User functions

| Function | Description |
| --- | --- |
| `stake(uint256 lockupIndex) payable` | Opens a new stake with the sent ETH. `lockupIndex` selects the tier: `0` = flexible (1.0×), `1` = 7 days (1.5×), `2` = 30 days (2.5×). |
| `requestWithdrawal(uint256 stakeId)` | Closes a stake and queues its principal for release. Reverts while the lockup is unexpired. Does **not** transfer ETH. |
| `completeWithdrawal(uint256 requestId)` | Pays out a queued request once its cooldown has elapsed. |
| `claimRewards()` | Mints all accrued NEX across every stake to the caller. |

### View functions

| Function | Returns |
| --- | --- |
| `earned(address, uint256 stakeId)` | NEX accrued by one stake |
| `totalEarned(address)` | NEX accrued across all of an account's stakes |
| `totalUserStaked(address)` | ETH currently staked by an account |
| `getStakesCount(address)` | Number of stake entries (including closed ones) |
| `getCooldownRequestsCount(address)` | Number of withdrawal requests |
| `totalStaked` | Protocol-wide staked ETH |
| `rewardRate` | Global emission rate |
| `cooldownPeriod` | Current withdrawal delay, in seconds |

### Owner functions

| Function | Description |
| --- | --- |
| `setRewardRate(uint256)` | Adjusts the global emission rate |
| `setCooldownPeriod(uint256)` | Adjusts the withdrawal delay (capped at 14 days) |
| `adminMint(address, uint256)` | Mints NEX directly, subject to the supply cap |
| `adminBurn(address, uint256)` | Burns NEX from an address |
| `pause()` / `unpause()` | Circuit breaker for `stake` and `claimRewards` |
| `emergencyWithdraw()` | Transfers the contract's **entire** ETH balance to the owner |

### Constants

| Constant | Value | Purpose |
| --- | --- | --- |
| `MAX_SUPPLY_CAP` | 100,000,000 NEX | Hard ceiling on total supply |
| `MAX_STAKE_LIMIT` | 50 ETH | Per-address cap on concurrent stake |

### Events

`Staked`, `WithdrawalRequested`, `WithdrawalCompleted`, `RewardsClaimed`,
`RewardRateUpdated`, `CooldownPeriodUpdated`, `EmergencyEtherWithdrawn`.

The dashboard subscribes to these via `useWatchContractEvent` and renders them in a live
log panel.

---

## Yield math

Rewards accrue per second and scale linearly with stake size, elapsed time, the global
rate, and the tier multiplier:

```
reward = (amount × elapsedSeconds × rewardRate × multiplier) / (1e18 × 10000)
```

- `amount` — staked ETH, in wei
- `elapsedSeconds` — seconds since the stake's `lastRewardTime`
- `rewardRate` — owner-controlled, 18-decimal fixed point
- `multiplier` — basis points; `10000` = 1.0×, `15000` = 1.5×, `25000` = 2.5×

The two divisors normalize the wei and basis-point scaling factors back out, leaving a NEX
amount in 18-decimal fixed point.

Rewards keep accruing after a lockup expires — the lockup gates *withdrawal*, not accrual.

---

## Security model

The contract inherits OpenZeppelin's `ReentrancyGuard`, `Pausable`, and `Ownable`, and adds
several application-level protections:

| Protection | Mechanism |
| --- | --- |
| Reentrancy | `nonReentrant` on every state-changing entry point; withdrawal marks `claimed = true` before transferring |
| Flash-loan state manipulation | Two-phase withdrawal — `requestWithdrawal` queues, `completeWithdrawal` pays out only after `cooldownPeriod` |
| Whale concentration | `MAX_STAKE_LIMIT` caps concurrent stake at 50 ETH per address |
| Unbounded inflation | `MAX_SUPPLY_CAP` checked before every mint, including `adminMint` |
| Incident response | `pause()` freezes `stake` and `claimRewards` |
| Double withdrawal | `requestWithdrawal` zeroes `stake.amount` before queuing |

### Known trust assumptions

These are deliberate properties of this reference implementation, not oversights. They are
the reason it should stay on a local chain:

- **`emergencyWithdraw()` sweeps the full contract balance**, which includes user principal
  and queued withdrawals. The owner can drain the vault. A production system would restrict
  this to surplus above `totalStaked`, or place it behind a timelock.
- **The owner can mint NEX at will** via `adminMint`, up to the supply cap, and can burn
  from any address via `adminBurn` without allowance.
- **Ownership is a single EOA.** There is no multisig, timelock, or role separation.
- **`claimRewards` and `totalEarned` loop over every stake an account holds.** An account
  with a very large number of stakes can push these past the block gas limit.
- **`cooldownPeriod` defaults to 1 minute** so the demo is watchable. A real deployment
  would use days.

---

## Testing

```bash
bun contracts:test
```

The suite covers 8 cases across four areas:

| Area | Cases |
| --- | --- |
| Anti-whale protections | Single stake over the cap; cumulative stakes over the cap |
| Lockup multipliers | Tier assignment; withdrawal blocked while locked; withdrawal allowed after expiry |
| Withdrawal cooldown | Payout blocked during cooldown; payout succeeds after cooldown, net of gas |
| Inflation protections | `adminMint` rejected above the supply cap |

Time-dependent cases use `evm_increaseTime` and `evm_mine` to advance the local chain.

---

## Configuration

### WalletConnect project ID

RainbowKit needs a WalletConnect Cloud project ID to offer mobile and QR-based wallets.
Set it via environment variable:

```bash
cp packages/frontend/.env.example packages/frontend/.env.local
```

```dotenv
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id_here
```

Get one at [cloud.walletconnect.com](https://cloud.walletconnect.com). If unset, the app
falls back to a shared public demo ID, which is sufficient for local browser-extension
wallets but should be replaced for anything you distribute.

### Supported chains

`Web3Provider.tsx` registers `hardhat`, `sepolia`, and `mainnet`. Only `hardhat` is wired to
a working contract deployment; the other two are present so chain-switching behavior can be
observed in the wallet UI.

---

## Available scripts

Run from the repository root:

| Script | Action |
| --- | --- |
| `bun contracts:compile` | Compile Solidity sources |
| `bun contracts:test` | Run the Hardhat test suite |
| `bun contracts:node` | Start the local JSON-RPC node |
| `bun contracts:deploy` | Deploy to the local node and export address/ABI to the frontend |
| `bun frontend:dev` / `bun dev` | Start the Next.js dev server |
| `bun frontend:build` | Production build of the frontend |
| `bun frontend:start` | Serve the production build |

---

## License

MIT
