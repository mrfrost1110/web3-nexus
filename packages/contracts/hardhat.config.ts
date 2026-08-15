/**
 * Hardhat configuration for the Web3Nexus contract package.
 *
 * Defines the Solidity compiler settings and the two local networks used by the project:
 * the in-process chain that tests run against, and the standalone node the frontend talks
 * to. No public networks are configured — see the README's security notes.
 */

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

// Loads `.env` if present. Nothing here requires it today, but it is the hook for adding
// an RPC URL and deployer key when configuring a public network.
dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    // Pinned to match the `pragma solidity ^0.8.24` in Web3Nexus.sol. 0.8.x gives checked
    // arithmetic by default, which is why the contract's reward math needs no SafeMath.
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        // 200 is the standard trade-off: it tunes the optimizer for contracts that are
        // called a moderate number of times, balancing deployment cost against per-call
        // gas. Raise it to favor runtime cost, lower it to favor deployment size.
        runs: 200,
      },
    },
  },
  networks: {
    // In-process chain, spun up fresh for each `hardhat test` run.
    hardhat: {
      chainId: 31337,
    },
    // The standalone node started by `bun contracts:node`. `bun contracts:deploy` targets
    // this network, and the frontend's Wagmi transport points at the same URL.
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
};

export default config;
