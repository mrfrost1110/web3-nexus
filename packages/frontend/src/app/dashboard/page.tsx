"use client";

/**
 * Staking dashboard — the app's main authenticated surface.
 *
 * Responsibilities:
 *   - Open stakes at a chosen lockup tier
 *   - List open stakes with live-ticking accrued yield
 *   - Drive the two-phase withdrawal: request, then claim after cooldown
 *   - Claim accrued NEX across all stakes
 *   - Stream contract events into a live activity log
 *
 * Everything on this page is derived from chain state. There is no backend and no local
 * database — the contract is the only source of truth, and each render reflects what a
 * fresh read of the chain returns.
 */

import React, { useState, useEffect } from "react";
import { useAccount, useBalance, useReadContract, useWriteContract, useWaitForTransactionReceipt, useWatchContractEvent } from "wagmi";
import { formatEther, parseEther } from "viem";
import { Web3NexusConfig } from "@/contracts/Web3Nexus";
import { useToast } from "@/components/Toast";
import { Wallet, Landmark, Coins, TrendingUp, RefreshCw, Send, ArrowDownLeft, Award, Lock, Hourglass, CheckCircle2 } from "lucide-react";

/** One decoded contract event, as rendered in the activity log. */
interface OnChainEvent {
  id: string;
  name: string;
  args: any;
  txHash: string;
}

/**
 * A staking position flattened for display.
 *
 * Amounts stay `bigint` all the way to the render call. Wei values exceed the range
 * JavaScript numbers represent exactly, so converting early would silently lose precision;
 * `formatEther` performs the conversion once, at the point of display.
 */
interface StakeDetail {
  id: number;
  amount: bigint;
  startTime: bigint;
  duration: bigint;
  multiplier: bigint;
  earned: bigint;
}

/** A queued withdrawal awaiting its cooldown. */
interface CooldownRequestDetail {
  id: number;
  amount: bigint;
  releaseTime: bigint;
  claimed: boolean;
}

/** Per-address staking cap enforced by the contract, mirrored here for pre-flight checks. */
const MAX_STAKE_ETH = "50.0";

export default function DashboardPage() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();

  // --- Form state ---
  const [stakeAmount, setStakeAmount] = useState("");
  const [lockupIndex, setLockupIndex] = useState("0"); // "0" flexible | "1" 7 days | "2" 30 days
  const [localEvents, setLocalEvents] = useState<OnChainEvent[]>([]);

  /**
   * Local one-second clock, in Unix seconds.
   *
   * Yield accrues continuously on-chain, but nothing pushes that to the client between
   * blocks. This ticker gives the countdowns and the accrued-yield figures something to
   * re-render against, and it is also a dependency of the stake and cooldown fetch effects
   * below — which is what makes those numbers tick up live rather than freezing until the
   * next transaction.
   */
  const [currentTime, setCurrentTime] = useState<number>(Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Math.floor(Date.now() / 1000)), 1000);
    // Cleared on unmount; without this the interval would outlive the page and keep
    // setting state on an unmounted component.
    return () => clearInterval(timer);
  }, []);

  // -------------------------------------------------------------------
  // Contract reads
  //
  // Each `useReadContract` is a cached, reactive query. The `query.enabled` guards keep a
  // call from firing before `address` exists — an account-scoped read with an undefined
  // argument would fail — and every hook exposes a `refetch` so `refreshAllStats` can
  // re-pull the whole page after a transaction confirms.
  // -------------------------------------------------------------------

  /** Native ETH balance of the connected wallet. */
  const { data: ethBalance, refetch: refetchEthBalance } = useBalance({
    address,
  });

  /** Protocol-wide staked ETH (TVL). */
  const { data: totalStaked, refetch: refetchTotalStaked } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "totalStaked",
  });

  /** Current global emission rate. */
  const { data: globalRewardRate } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "rewardRate",
  });

  /** The connected account's NEX token balance (already-claimed rewards). */
  const { data: nexBalance, refetch: refetchNex } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  /** Unclaimed NEX accrued across all of the account's stakes. */
  const { data: cumulativeEarned, refetch: refetchCumulativeEarned } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "totalEarned",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  /**
   * Number of stake slots the account holds.
   *
   * The contract exposes stakes as an array behind a public mapping, with no getter that
   * returns them all at once. Reading the count first is what bounds the per-index reads
   * in the effect below.
   */
  const { data: stakesCount, refetch: refetchStakesCount } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "getStakesCount",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const [activeStakes, setActiveStakes] = useState<StakeDetail[]>([]);

  /**
   * Loads every stake the account holds, one index at a time.
   *
   * Two reads per stake: the struct itself from the public `userStakes` mapping, and its
   * current accrued yield from `earned`. Closed stakes (`amount == 0`) are filtered out —
   * the contract keeps their slots so indices stay stable, but they have nothing to show.
   *
   * Re-runs on `currentTime`, so the accrued-yield column re-reads once per second and
   * ticks visibly rather than sitting still between transactions.
   *
   * Per-stake reads are wrapped individually: one unreadable index logs and is skipped
   * instead of discarding every other stake the account owns.
   */
  useEffect(() => {
    if (!address || !stakesCount) {
      setActiveStakes([]);
      return;
    }

    const fetchAllStakes = async () => {
      const tempStakes: StakeDetail[] = [];
      const count = Number(stakesCount);

      for (let i = 0; i < count; i++) {
        try {
          const stakeData = await fetchContractData("userStakes", [address, BigInt(i)]);
          const rewardData = await fetchContractData("earned", [address, BigInt(i)]);

          // Index 0 is `amount`; a zero here means the stake was already withdrawn.
          if (stakeData && stakeData[0] > 0n) {
            tempStakes.push({
              id: i,
              amount: stakeData[0],
              startTime: stakeData[1],
              duration: stakeData[2],
              multiplier: stakeData[3],
              earned: rewardData || 0n,
            });
          }
        } catch (e) {
          console.error("Error reading stake info", e);
        }
      }
      setActiveStakes(tempStakes);
    };

    fetchAllStakes();
  }, [stakesCount, address, currentTime]);

  /** Number of withdrawal request slots the account holds. */
  const { data: cooldownCount, refetch: refetchCooldownCount } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "getCooldownRequestsCount",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const [cooldownRequests, setCooldownRequests] = useState<CooldownRequestDetail[]>([]);

  /**
   * Loads the account's pending withdrawal requests.
   *
   * Mirrors the stake loader: read the count, then read each index. Already-claimed
   * requests (index 2 of the struct) are filtered out, leaving only ETH still owed.
   */
  useEffect(() => {
    if (!address || !cooldownCount) {
      setCooldownRequests([]);
      return;
    }

    const fetchAllCooldowns = async () => {
      const tempCooldowns: CooldownRequestDetail[] = [];
      const count = Number(cooldownCount);

      for (let i = 0; i < count; i++) {
        try {
          const cdData = await fetchContractData("cooldownRequests", [address, BigInt(i)]);
          // Index 2 is `claimed`; skip requests already paid out.
          if (cdData && !cdData[2]) {
            tempCooldowns.push({
              id: i,
              amount: cdData[0],
              releaseTime: cdData[1],
              claimed: cdData[2],
            });
          }
        } catch (e) {
          console.error("Error reading cooldown request info", e);
        }
      }
      setCooldownRequests(tempCooldowns);
    };

    fetchAllCooldowns();
  }, [cooldownCount, address, currentTime]);

  /**
   * Imperative contract read, for calls made inside effects.
   *
   * The `useReadContract` hook cannot be used here: the number of stakes is only known at
   * runtime, and hooks cannot be called in a loop. This wraps Wagmi's imperative
   * `readContract` action instead.
   *
   * Reads go through a standalone Hardhat config rather than the connected wallet, so the
   * list still loads when the wallet is pointed at another network. These are view calls —
   * no signature, no gas — so no wallet involvement is needed.
   *
   * Returns `null` on failure rather than throwing, so a single failed index does not tear
   * down the whole loop.
   *
   * Note: this constructs a fresh config per call, which is wasteful at one call per stake
   * per second. Hoisting it to module scope would be the obvious improvement.
   */
  const fetchContractData = async (functionName: string, args: any[]): Promise<any> => {
    try {
      const { readContract } = await import("wagmi/actions");
      const { getDefaultConfig } = await import("@rainbow-me/rainbowkit");
      const { hardhat } = await import("wagmi/chains");
      const { http, createConfig } = await import("wagmi");

      const config = createConfig({
        chains: [hardhat],
        transports: { [hardhat.id]: http("http://127.0.0.1:8545") },
      });

      return await readContract(config, {
        address: Web3NexusConfig.address,
        abi: Web3NexusConfig.abi,
        functionName: functionName as any,
        args: args as any,
      });
    } catch (e) {
      return null;
    }
  };

  /**
   * Re-pulls every cached read at once.
   *
   * Called after a transaction confirms and from the manual sync button. A confirmed
   * transaction changes several values simultaneously — balance, TVL, stake list — and
   * refetching them together avoids a frame where some figures are new and others stale.
   */
  const refreshAllStats = () => {
    refetchEthBalance();
    refetchTotalStaked();
    refetchNex();
    refetchCumulativeEarned();
    refetchStakesCount();
    refetchCooldownCount();
  };

  // -------------------------------------------------------------------
  // Contract writes
  //
  // A write passes through three states, and the user sees a distinct toast at each:
  //
  //   txSubmitting  awaiting the signature in the wallet
  //   txWaiting     broadcast, awaiting inclusion in a block
  //   txSuccess     mined and confirmed
  //
  // A single `useWriteContract` instance is shared by every action on the page, since only
  // one transaction can be in flight at a time.
  // -------------------------------------------------------------------
  const { writeContract, data: txHash, error: txError, isPending: txSubmitting } = useWriteContract();

  // Watches the mempool for the hash produced above and resolves once it is mined.
  const { isLoading: txWaiting, isSuccess: txSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (txSubmitting) showToast("Sign the transaction signature in your wallet...", "info");
  }, [txSubmitting]);

  useEffect(() => {
    if (txHash && txWaiting) {
      showToast(`Transaction submitted! Hash: ${txHash.substring(0, 10)}... pending confirmation.`, "info");
    }
  }, [txHash, txWaiting]);

  // Confirmation is the point at which chain state has actually changed, so this is where
  // the page re-reads and the form clears — not at submission, which may still fail.
  useEffect(() => {
    if (txSuccess) {
      showToast("Ledger transaction confirmed successfully!", "success");
      refreshAllStats();
      setStakeAmount("");
    }
  }, [txSuccess]);

  // A user declining the wallet prompt is an ordinary outcome, not a fault, so it gets a
  // short message instead of the raw provider error.
  useEffect(() => {
    if (txError) {
      showToast(txError.message.includes("rejected") ? "Signature rejected." : txError.message, "error");
    }
  }, [txError]);

  /**
   * Live subscription to every event the contract emits.
   *
   * Two distinct purposes:
   *
   *   1. The activity log shows *all* events, from every account, so the shared nature of
   *      a public ledger is visible — other people's transactions appear too.
   *   2. Events whose `user` matches the connected account also raise a toast and trigger
   *      a refresh, which is what keeps the UI current when a transaction is confirmed
   *      from another tab or device.
   */
  useWatchContractEvent({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    onLogs(logs) {
      logs.forEach((log: any) => {
        const eventName = log.eventName;
        if (!eventName) return;

        const args = log.args;
        const txHash = log.transactionHash;

        setLocalEvents((prev) => [
          {
            // Transaction hash alone is not unique — one transaction can emit several
            // events — so the log index disambiguates them.
            id: `${txHash}-${log.logIndex}`,
            name: eventName,
            args,
            txHash,
          },
          // Newest first, capped at 10 entries so the panel cannot grow without bound.
          ...prev.slice(0, 9),
        ]);

        if (args.user === address) {
          if (eventName === "Staked") {
            showToast(`Ledger Event: Lockup Stake Created! ${formatEther(args.amount)} ETH`, "success");
            refreshAllStats();
          } else if (eventName === "WithdrawalRequested") {
            showToast(`Ledger Event: Cooldown Withdrawal Initiated! Locked for 1 Min.`, "info");
            refreshAllStats();
          } else if (eventName === "WithdrawalCompleted") {
            showToast(`Ledger Event: ETH payout completed! Sent ${formatEther(args.amount)} ETH to wallet.`, "success");
            refreshAllStats();
          } else if (eventName === "RewardsClaimed") {
            showToast(`Ledger Event: Accrued NEX yield minted to wallet!`, "success");
            refreshAllStats();
          }
        }
      });
    },
  });

  // -------------------------------------------------------------------
  // Action handlers
  //
  // The client-side validation below duplicates checks the contract already enforces. That
  // is deliberate: the contract is the authority, but a revert costs gas and surfaces as an
  // opaque wallet error, so obvious mistakes are caught before a signature is requested.
  // These checks are a convenience, never a security boundary.
  // -------------------------------------------------------------------

  /** Opens a new stake at the selected lockup tier. */
  const handleStake = (e: React.FormEvent) => {
    e.preventDefault();
    if (!stakeAmount || isNaN(Number(stakeAmount)) || Number(stakeAmount) <= 0) {
      showToast("Please enter a valid positive ETH amount to stake.", "error");
      return;
    }

    // Mirrors the contract's anti-whale rule: the cap applies to cumulative open stake,
    // not to this deposit alone.
    const cumulativeStaked = activeStakes.reduce((acc, curr) => acc + curr.amount, 0n);
    if (cumulativeStaked + parseEther(stakeAmount) > parseEther(MAX_STAKE_ETH)) {
      showToast("Anti-Whale Safety: Your cumulative active stakes cannot exceed 50 ETH.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "stake",
      args: [BigInt(lockupIndex)],
      // `value` sends native ETH with the call — this is the staked principal, not a
      // function argument.
      value: parseEther(stakeAmount),
    });
  };

  /** Phase one of withdrawal: closes the stake and starts its cooldown. Moves no ETH. */
  const handleRequestWithdrawal = (stakeId: number) => {
    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "requestWithdrawal",
      args: [BigInt(stakeId)],
    });
  };

  /** Phase two of withdrawal: releases the principal once the cooldown has elapsed. */
  const handleCompleteWithdrawal = (requestId: number) => {
    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "completeWithdrawal",
      args: [BigInt(requestId)],
    });
  };

  /**
   * Mints all accrued NEX across the account's stakes.
   *
   * Guarded on a zero balance because the contract reverts with "No pending rewards to
   * claim" — better to say so directly than to spend a signature on a failing call.
   */
  const handleClaimGlobalRewards = () => {
    if (!cumulativeEarned || (cumulativeEarned as bigint) === 0n) {
      showToast("You have no pending rewards to claim currently.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "claimRewards",
    });
  };

  // Every figure on this page is account-scoped, so there is nothing to render before a
  // wallet is connected.
  if (!isConnected) {
    return (
      <div className="container" style={{ minHeight: "calc(100vh - 81px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="glass-card glow-border-purple" style={{ textAlign: "center", maxWidth: "500px", width: "100%", padding: "40px" }}>
          <Lock size={64} className="glow-text-purple animated-float" style={{ marginBottom: "24px" }} />
          <h2 style={{ fontSize: "28px", fontWeight: 800, marginBottom: "12px" }}>Wallet Connection Required</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: "32px", lineHeight: "1.6" }}>
            Unlock Web3 Ledger features, view active stakes, track lockups, and execute live on-chain operations by connecting your decentralized wallet.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: "40px 24px" }}>
      {/* Dashboard title header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "40px", flexWrap: "wrap", gap: "20px" }}>
        <div>
          <h1 style={{ fontSize: "36px", fontWeight: 800, marginBottom: "6px" }} className="glow-text-cyan">Staking Dashboard</h1>
          <p style={{ color: "var(--text-secondary)" }}>Securely manage lockup contracts, monitor multipliers, and complete pre-commitment withdrawals.</p>
        </div>
        <button className="btn btn-secondary" onClick={refreshAllStats} style={{ display: "inline-flex", gap: "8px" }}>
          <RefreshCw size={16} /> Sync Live Data
        </button>
      </header>

      {/* Grid: Global stats */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px", marginBottom: "40px" }}>
        <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(6, 182, 212, 0.1)" }}>
            <Wallet size={24} style={{ color: "var(--neon-cyan)" }} />
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase" }}>Available Wallet</div>
            <div style={{ fontSize: "18px", fontWeight: 800 }}>
              {ethBalance ? Number(ethBalance.formatted).toFixed(4) : "0.00"} ETH
            </div>
          </div>
        </div>

        <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(168, 85, 247, 0.1)" }}>
            <Landmark size={24} style={{ color: "var(--neon-purple)" }} />
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase" }}>My Total Staked</div>
            <div style={{ fontSize: "18px", fontWeight: 800 }} className="glow-text-purple">
              {activeStakes.length > 0
                ? (activeStakes.reduce((acc, curr) => acc + Number(formatEther(curr.amount)), 0)).toFixed(4)
                : "0.0000"}{" "}
              ETH
            </div>
          </div>
        </div>

        <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(236, 72, 153, 0.1)" }}>
            <Coins size={24} style={{ color: "var(--neon-pink)" }} />
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 600, textTransform: "uppercase" }}>NEX Token Balance</div>
            <div style={{ fontSize: "18px", fontWeight: 800 }}>
              {nexBalance ? Number(formatEther(nexBalance as bigint)).toFixed(2) : "0.00"} NEX
            </div>
          </div>
        </div>

        <div className="glass-card" style={{ display: "flex", alignItems: "center", gap: "16px", border: "1px solid rgba(6, 182, 212, 0.3)" }}>
          <div style={{ padding: "12px", borderRadius: "12px", background: "rgba(6, 182, 212, 0.2)" }} className="animated-float">
            <TrendingUp size={24} style={{ color: "var(--neon-cyan)" }} />
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "var(--neon-cyan)", fontWeight: 700, textTransform: "uppercase" }}>Cumulative Earnings</div>
            <div style={{ fontSize: "18px", fontWeight: 800 }} className="glow-text-cyan">
              {cumulativeEarned ? Number(formatEther(cumulativeEarned as bigint)).toFixed(6) : "0.000000"} NEX
            </div>
          </div>
        </div>
      </section>

      {/* Main Panel grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: "30px", alignItems: "start" }}>
        
        {/* Left Side: Staking Input & Active Stakes Ledger */}
        <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
          
          {/* Staking Input Panel */}
          <div className="glass-card glow-border-cyan">
            <h2 style={{ fontSize: "20px", fontWeight: 800, marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <Send size={18} className="glow-text-cyan" /> Secure Multiplier Staking Vault
            </h2>

            <form onSubmit={handleStake} style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 1fr", gap: "16px", alignItems: "flex-end" }}>
              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label">Amount to Stake (ETH)</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  max="50"
                  placeholder="0.0 ETH"
                  className="input-field"
                  value={stakeAmount}
                  onChange={(e) => setStakeAmount(e.target.value)}
                />
              </div>

              <div className="input-group" style={{ marginBottom: 0 }}>
                <label className="input-label">Lockup Contract Period</label>
                <select
                  className="input-field"
                  value={lockupIndex}
                  onChange={(e) => setLockupIndex(e.target.value)}
                  style={{ cursor: "pointer", background: "#0e1325" }}
                >
                  <option value="0">Standard Yield (1.0x - No Lock)</option>
                  <option value="1">Accelerated (1.5x - 7 Days Lock)</option>
                  <option value="2">Hyper Yield (2.5x - 30 Days Lock)</option>
                </select>
              </div>

              <button type="submit" className="btn btn-primary" style={{ height: "49px" }}>
                Stake ETH
              </button>
            </form>
            <div style={{ display: "flex", marginTop: "12px", background: "rgba(6, 182, 212, 0.03)", padding: "10px", borderRadius: "8px", border: "1px dashed rgba(6,182,212,0.15)", fontSize: "11px", color: "var(--text-secondary)", gap: "6px" }}>
              <span>⚠️</span>
              <span><strong>Anti-Whale Limit active:</strong> Staking is restricted to a maximum of 50 cumulative ETH per address. Locked stakes earn yields faster but cannot be unlocked until the lock period expires.</span>
            </div>
          </div>

          {/* Active Stakes list */}
          <div className="glass-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px", borderBottom: "1px solid var(--border-color)", paddingBottom: "12px" }}>
              <h2 style={{ fontSize: "20px", fontWeight: 800 }}>My Active Stakes Ledger</h2>
              <button onClick={handleClaimGlobalRewards} className="btn btn-primary" style={{ padding: "8px 16px", fontSize: "12px" }}>
                <Award size={14} /> Claim All Accrued Yield ({activeStakes.length} Nodes)
              </button>
            </div>

            {activeStakes.length === 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>
                You have no active staking nodes registered on this contract ledger. Use the panel above to open a vault stake!
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", textAlign: "left" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)" }}>
                      <th style={{ padding: "10px 8px" }}>ID</th>
                      <th style={{ padding: "10px 8px" }}>Staked ETH</th>
                      <th style={{ padding: "10px 8px" }}>Lockup Period</th>
                      <th style={{ padding: "10px 8px" }}>Multiplier</th>
                      <th style={{ padding: "10px 8px" }}>Accrued Yield</th>
                      <th style={{ padding: "10px 8px", textAlign: "right" }}>Operation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeStakes.map((stake) => {
                      const releaseTime = Number(stake.startTime + stake.duration);
                      const isLocked = currentTime < releaseTime;
                      const secondsRemaining = releaseTime - currentTime;
                      
                      return (
                        <tr key={stake.id} style={{ borderBottom: "1px solid var(--border-color)", transition: "background 0.2s" }} className="table-row-hover">
                          <td style={{ padding: "14px 8px", fontWeight: 700, fontFamily: "monospace" }}>#{stake.id}</td>
                          <td style={{ padding: "14px 8px", fontWeight: 700 }}>{Number(formatEther(stake.amount)).toFixed(3)} ETH</td>
                          <td style={{ padding: "14px 8px" }}>
                            {stake.duration === 0n ? (
                              <span style={{ color: "var(--text-muted)" }}>None (Flexible)</span>
                            ) : isLocked ? (
                              <span style={{ color: "var(--neon-pink)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <Hourglass size={12} /> {secondsRemaining > 3600 ? `${(secondsRemaining / 3600).toFixed(1)} hrs` : `${secondsRemaining}s`}
                              </span>
                            ) : (
                              <span style={{ color: "var(--success)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <CheckCircle2 size={12} /> Complete
                              </span>
                            )}
                          </td>
                          <td style={{ padding: "14px 8px" }}>
                            <span style={{ background: "rgba(168, 85, 247, 0.15)", color: "var(--neon-purple)", padding: "2px 8px", borderRadius: "8px", fontWeight: 700, fontSize: "11px" }}>
                              {(Number(stake.multiplier) / 10000).toFixed(1)}x
                            </span>
                          </td>
                          <td style={{ padding: "14px 8px", fontFamily: "monospace", color: "var(--neon-cyan)", fontWeight: 700 }}>
                            {Number(formatEther(stake.earned)).toFixed(6)} NEX
                          </td>
                          <td style={{ padding: "14px 8px", textAlign: "right" }}>
                            <button
                              onClick={() => handleRequestWithdrawal(stake.id)}
                              disabled={isLocked}
                              className={`btn ${isLocked ? "btn-secondary" : "btn-danger"}`}
                              style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 700 }}
                            >
                              {isLocked ? "Locked" : "Unstake ETH"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Cooldown Queue & Event Log */}
        <div style={{ display: "flex", flexDirection: "column", gap: "30px" }}>
          
          {/* Pre-Commitment Withdrawal Queue (Cooldowns) */}
          <div className="glass-card glow-border-purple">
            <h2 style={{ fontSize: "20px", fontWeight: 800, marginBottom: "6px" }}>Pre-Commitment Cooldowns</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", marginBottom: "20px" }}>To prevent Flash-Loan exploit vectors, unstaked ETH is held in cooldown for 1 minute before release.</p>

            {cooldownRequests.length === 0 ? (
              <div style={{ padding: "30px 0", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                No active withdrawal payouts currently waiting in the security cooldown queue.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {cooldownRequests.map((req) => {
                  const release = Number(req.releaseTime);
                  const isLocked = currentTime < release;
                  const secondsRemaining = release - currentTime;

                  return (
                    <div
                      key={req.id}
                      style={{
                        padding: "16px",
                        background: "rgba(255, 255, 255, 0.01)",
                        border: isLocked ? "1px solid var(--border-color)" : "1px solid rgba(16, 185, 129, 0.3)",
                        borderRadius: "12px",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div style={{ fontSize: "11px", color: "var(--text-secondary)", fontWeight: 600 }}>Unlocking Payout</div>
                        <div style={{ fontSize: "18px", fontWeight: 800 }}>{Number(formatEther(req.amount)).toFixed(3)} ETH</div>
                        <div style={{ fontSize: "11px", color: isLocked ? "var(--neon-pink)" : "var(--success)", display: "flex", alignItems: "center", gap: "4px", marginTop: "4px" }}>
                          {isLocked ? (
                            <>
                              <Hourglass size={12} /> Cooldown locked: {secondsRemaining}s
                            </>
                          ) : (
                            <>
                              <CheckCircle2 size={12} /> Cooldown completed. Funds Ready!
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => handleCompleteWithdrawal(req.id)}
                        disabled={isLocked}
                        className={`btn ${isLocked ? "btn-secondary" : "btn-primary"}`}
                        style={{ padding: "8px 16px", fontSize: "12px" }}
                      >
                        Claim Payout
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Node event log */}
          <div className="glass-card" style={{ minHeight: "300px" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 800, marginBottom: "4px" }}>On-Chain Node Event Log</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "11px", marginBottom: "16px" }}>Subscribed to live events on the smart contract...</p>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", maxHeight: "250px", overflowY: "auto", paddingRight: "4px" }}>
              {localEvents.length === 0 ? (
                <div style={{ textAlign: "center", color: "var(--text-muted)", padding: "30px 0", fontSize: "13px" }}>
                  No transaction events received yet. Initiate staking to observe raw block emissions!
                </div>
              ) : (
                localEvents.map((event) => (
                  <div
                    key={event.id}
                    style={{
                      padding: "10px",
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "8px",
                      fontSize: "11px",
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span
                        style={{
                          fontWeight: 700,
                          textTransform: "uppercase",
                          color:
                            event.name === "Staked"
                              ? "var(--success)"
                              : event.name === "WithdrawalRequested"
                              ? "var(--neon-pink)"
                              : event.name === "WithdrawalCompleted"
                              ? "var(--warning)"
                              : "var(--neon-cyan)",
                        }}
                      >
                        {event.name === "WithdrawalRequested" ? "WithdrawRequest" : event.name}
                      </span>
                      <span style={{ color: "var(--text-muted)" }}>
                        tx: {event.txHash.substring(0, 8)}...
                      </span>
                    </div>

                    <div style={{ background: "rgba(0,0,0,0.15)", padding: "6px", borderRadius: "4px", color: "var(--text-secondary)", fontFamily: "monospace" }}>
                      {event.name === "Staked" && (
                        <div>
                          User: {event.args.user.substring(0, 6)}...<br />
                          Amt: {Number(formatEther(event.args.amount)).toFixed(3)} ETH | Lockup: {Number(event.args.lockupDuration) / (3600 * 24)} days
                        </div>
                      )}
                      {event.name === "WithdrawalRequested" && (
                        <div>
                          User: {event.args.user.substring(0, 6)}...<br />
                          Amt: {Number(formatEther(event.args.amount)).toFixed(3)} ETH | Release: Cooldown +1 Min
                        </div>
                      )}
                      {event.name === "WithdrawalCompleted" && (
                        <div>
                          User: {event.args.user.substring(0, 6)}...<br />
                          Amt: {Number(formatEther(event.args.amount)).toFixed(3)} ETH | Transfer complete.
                        </div>
                      )}
                      {event.name === "RewardsClaimed" && (
                        <div>
                          User: {event.args.user.substring(0, 6)}...<br />
                          Amt: {Number(formatEther(event.args.amount)).toFixed(3)} NEX claimed.
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </div>

      {/* Contract context details */}
      <section style={{ marginTop: "40px" }} className="glass-card">
        <h3 style={{ fontWeight: 700, marginBottom: "8px" }}>Ledger Integrity Details</h3>
        <ul style={{ color: "var(--text-secondary)", fontSize: "13px", lineHeight: "1.8", paddingLeft: "16px" }}>
          <li>Contract Ledger Address: <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>{Web3NexusConfig.address}</span></li>
          <li>System Staking Multipliers: <span style={{ color: "var(--neon-purple)", fontWeight: 700 }}>Flexible: 1.0x | 7 Days: 1.5x | 30 Days: 2.5x</span></li>
          <li>Active System Cooldown Delay: <span style={{ color: "var(--neon-pink)", fontWeight: 700 }}>1 Minute (60 Seconds)</span></li>
          <li>Global System TVL: <span style={{ color: "var(--neon-cyan)", fontWeight: 700 }}>{totalStaked ? Number(formatEther(totalStaked as bigint)).toFixed(4) : "0.00"} ETH</span></li>
        </ul>
      </section>
    </div>
  );
}
