/**
 * Deployment script for the Web3Nexus contract.
 *
 * Beyond deploying, this script is the bridge between the two workspace packages: it
 * writes the deployed address and compiled ABI into the frontend as a TypeScript module.
 * That keeps the frontend pinned to whatever contract is actually live on the chain,
 * instead of a hand-copied address that drifts out of date.
 *
 * Run against a node started by `bun contracts:node`:
 *
 *     bun contracts:deploy
 *
 * A fresh Hardhat node starts with no deployed contract, so this must be re-run after
 * every node restart.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Initial value for the contract's `rewardRate`, in 18-decimal fixed point.
 *
 * Expressed via `parseEther` rather than a raw integer literal because the contract's
 * reward math divides by `1e18`; writing it in "ether" units keeps the intent legible.
 */
const INITIAL_REWARD_RATE = ethers.parseEther("100");

/** Where the deploy script writes the address/ABI module the frontend imports. */
const FRONTEND_CONTRACTS_DIR = path.join(__dirname, "../../frontend/src/contracts");

/** Hardhat's compiled artifact for Web3Nexus, the source of the exported ABI. */
const ARTIFACT_PATH = path.join(
  __dirname,
  "../artifacts/contracts/Web3Nexus.sol/Web3Nexus.json"
);

async function main() {
  console.log("Starting Web3Nexus deployment...");

  // The first signer is Hardhat account #0. It pays for the deployment and therefore
  // becomes the contract's `Ownable` owner — the account the admin panel expects.
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contract with the account:", deployer.address);

  const Web3NexusFactory = await ethers.getContractFactory("Web3Nexus");
  const web3Nexus = await Web3NexusFactory.deploy(INITIAL_REWARD_RATE);

  // Deployment is only mined after this resolves; reading the address before it would
  // race the transaction.
  await web3Nexus.waitForDeployment();
  const contractAddress = await web3Nexus.getAddress();

  console.log(`Web3Nexus contract successfully deployed to: ${contractAddress}`);

  if (!fs.existsSync(FRONTEND_CONTRACTS_DIR)) {
    fs.mkdirSync(FRONTEND_CONTRACTS_DIR, { recursive: true });
  }

  // Only the ABI is taken from the artifact. The rest of the artifact (bytecode, source
  // maps, link references) is build detail the frontend has no use for.
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));

  const contractDetails = {
    address: contractAddress,
    abi: artifact.abi,
  };

  // `as const` is what makes this useful on the frontend: it preserves the ABI's literal
  // types, which is how Wagmi infers function names, argument types, and return types at
  // each call site rather than falling back to `any`.
  const tsContent = `export const Web3NexusConfig = ${JSON.stringify(contractDetails, null, 2)} as const;\n`;
  fs.writeFileSync(path.join(FRONTEND_CONTRACTS_DIR, "Web3Nexus.ts"), tsContent);

  console.log(
    `Successfully exported contract configuration (ABI & address) to frontend at: ${path.join(FRONTEND_CONTRACTS_DIR, "Web3Nexus.ts")}`
  );
}

// Exit codes matter here: a non-zero exit on failure is what stops a shell chain such as
// `bun contracts:deploy && bun dev` from starting the frontend against a contract that
// was never deployed.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error deploying contract:", error);
    process.exit(1);
  });
