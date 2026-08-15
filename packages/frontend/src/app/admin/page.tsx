"use client";

/**
 * Owner-only control panel.
 *
 * Exposes every `onlyOwner` function on the contract: emission rate, cooldown length,
 * direct mint and burn, the pause circuit breaker, and the emergency ETH sweep.
 *
 * The access check here is presentational. It hides controls the connected account cannot
 * use and explains why, but it enforces nothing — the contract's `onlyOwner` modifier is
 * the actual boundary, and it rejects a non-owner call regardless of what this UI shows.
 * Anyone can call the contract directly without going through this page at all.
 */

import React, { useState, useEffect } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther, parseEther } from "viem";
import { Web3NexusConfig } from "@/contracts/Web3Nexus";
import { useToast } from "@/components/Toast";
import { ShieldAlert, Play, Pause, Flame, Settings, Plus, RefreshCw, Landmark, ShieldCheck, Hourglass } from "lucide-react";

/** Length of a hex Ethereum address including the `0x` prefix. */
const ADDRESS_LENGTH = 42;

export default function AdminPage() {
  const { address, isConnected } = useAccount();
  const { showToast } = useToast();

  // --- Form state, one pair per admin action ---
  const [newRate, setNewRate] = useState("");
  const [newCooldown, setNewCooldown] = useState("");
  const [mintAddress, setMintAddress] = useState("");
  const [mintAmount, setMintAmount] = useState("");
  const [burnAddress, setBurnAddress] = useState("");
  const [burnAmount, setBurnAmount] = useState("");

  // -------------------------------------------------------------------
  // Contract reads
  //
  // None are account-scoped, so all four run without a connected wallet.
  // -------------------------------------------------------------------

  /** The contract's owner, compared against the connected account below. */
  const { data: ownerAddress, refetch: refetchOwner } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "owner",
  });

  /** Whether the pause circuit breaker is currently engaged. */
  const { data: isPaused, refetch: refetchPaused } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "paused",
  });

  /** Current global emission rate. */
  const { data: currentRate, refetch: refetchRate } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "rewardRate",
  });

  /** Current withdrawal cooldown, in seconds. */
  const { data: currentCooldown, refetch: refetchCooldown } = useReadContract({
    address: Web3NexusConfig.address,
    abi: Web3NexusConfig.abi,
    functionName: "cooldownPeriod",
  });

  /** Re-reads all four configuration values after an admin action confirms. */
  const refreshAdminData = () => {
    refetchOwner();
    refetchPaused();
    refetchRate();
    refetchCooldown();
  };

  /**
   * Whether the connected account is the contract owner.
   *
   * Compared lowercased: wallets return EIP-55 checksummed addresses with mixed casing,
   * and a case-sensitive comparison would report a false mismatch for the correct account.
   */
  const isUserAdmin = address && ownerAddress && address.toLowerCase() === (ownerAddress as string).toLowerCase();

  // -------------------------------------------------------------------
  // Contract writes
  //
  // Same three-stage lifecycle as the dashboard: signature, broadcast, confirmation. One
  // shared `useWriteContract` covers every form on the page.
  // -------------------------------------------------------------------
  const { writeContract, data: txHash, error: txError, isPending: txSubmitting } = useWriteContract();

  const { isLoading: txWaiting, isSuccess: txSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  useEffect(() => {
    if (txSubmitting) {
      showToast("Requesting Admin Signature...", "info");
    }
  }, [txSubmitting]);

  useEffect(() => {
    if (txHash && txWaiting) {
      showToast(`Admin TX submitted: ${txHash.substring(0, 10)}... waiting for confirmation.`, "info");
    }
  }, [txHash, txWaiting]);

  // Clears every form, not just the one submitted. Only one transaction can be in flight
  // at a time, so a confirmation always corresponds to whichever form was last used, and
  // resetting all of them avoids tracking which that was.
  useEffect(() => {
    if (txSuccess) {
      showToast("Admin action executed successfully and recorded to ledger!", "success");
      refreshAdminData();
      setNewRate("");
      setNewCooldown("");
      setMintAddress("");
      setMintAmount("");
      setBurnAddress("");
      setBurnAmount("");
    }
  }, [txSuccess]);

  useEffect(() => {
    if (txError) {
      showToast(txError.message.includes("rejected") ? "Admin signature rejected." : txError.message, "error");
    }
  }, [txError]);

  // -------------------------------------------------------------------
  // Action handlers
  //
  // As on the dashboard, the validation here is a convenience that avoids spending a
  // signature on a call the contract would revert. The contract remains the authority.
  // -------------------------------------------------------------------

  /**
   * Updates the global emission rate.
   *
   * The input is in whole NEX, converted by `parseEther` to the 18-decimal fixed point the
   * contract's reward math expects.
   */
  const handleSetRate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRate || isNaN(Number(newRate)) || Number(newRate) < 0) {
      showToast("Please enter a valid non-negative reward rate.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "setRewardRate",
      args: [parseEther(newRate)],
    });
  };

  /**
   * Updates the withdrawal cooldown.
   *
   * Taken as a plain second count, so `BigInt` rather than `parseEther`. The contract caps
   * this at 14 days and reverts above it.
   */
  const handleSetCooldown = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCooldown || isNaN(Number(newCooldown)) || Number(newCooldown) < 0) {
      showToast("Please enter a valid positive cooldown period in seconds.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "setCooldownPeriod",
      args: [BigInt(newCooldown)],
    });
  };

  /**
   * Mints NEX directly to an address, bypassing the staking flow.
   *
   * The address check is a shape check only — prefix and length. It catches a truncated
   * paste, not an invalid checksum or a wrong-but-well-formed address, and minting to the
   * wrong address is irreversible.
   */
  const handleMint = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mintAddress || !mintAddress.startsWith("0x") || mintAddress.length !== ADDRESS_LENGTH) {
      showToast("Please enter a valid Hexadecimal Ethereum address.", "error");
      return;
    }
    if (!mintAmount || isNaN(Number(mintAmount)) || Number(mintAmount) <= 0) {
      showToast("Please enter a valid positive token amount to mint.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "adminMint",
      args: [mintAddress as `0x${string}`, parseEther(mintAmount)],
    });
  };

  /**
   * Burns NEX from an arbitrary address.
   *
   * The contract requires no allowance from the holder, so this destroys tokens the owner
   * does not hold. Also irreversible.
   */
  const handleBurn = (e: React.FormEvent) => {
    e.preventDefault();
    if (!burnAddress || !burnAddress.startsWith("0x") || burnAddress.length !== ADDRESS_LENGTH) {
      showToast("Please enter a valid Hexadecimal Ethereum address.", "error");
      return;
    }
    if (!burnAmount || isNaN(Number(burnAmount)) || Number(burnAmount) <= 0) {
      showToast("Please enter a valid positive token amount to burn.", "error");
      return;
    }

    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: "adminBurn",
      args: [burnAddress as `0x${string}`, parseEther(burnAmount)],
    });
  };

  /**
   * Toggles the pause circuit breaker.
   *
   * Pausing blocks new stakes and reward claims but deliberately leaves the withdrawal
   * path open, so stakers can still exit while the protocol is halted.
   */
  const handleTogglePause = () => {
    const fn = isPaused ? "unpause" : "pause";
    writeContract({
      address: Web3NexusConfig.address,
      abi: Web3NexusConfig.abi,
      functionName: fn,
    });
  };

  /**
   * Sweeps the contract's entire ETH balance to the owner.
   *
   * The most destructive action available. The balance is not limited to surplus — it
   * includes staked principal and queued withdrawals — so this can leave stakers unable to
   * complete their exits. Confirmed before signing because the transaction is irreversible
   * once mined.
   */
  const handleEmergencyWithdraw = () => {
    if (confirm("WARNING: Are you sure you want to execute emergency withdrawal? This will sweep all contract surplus ETH directly to the owner wallet.")) {
      writeContract({
        address: Web3NexusConfig.address,
        abi: Web3NexusConfig.abi,
        functionName: "emergencyWithdraw",
      });
    }
  };

  // -------------------------------------------------------------------
  // Access states
  //
  // Two distinct cases, each with its own explanation: no wallet at all, and a wallet that
  // is not the owner.
  // -------------------------------------------------------------------
  if (!isConnected) {
    return (
      <div className="container" style={{ minHeight: "calc(100vh - 81px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="glass-card glow-border-purple" style={{ textAlign: "center", maxWidth: "500px", width: "100%", padding: "40px" }}>
          <ShieldAlert size={64} className="glow-text-purple animated-float" style={{ marginBottom: "24px" }} />
          <h2 style={{ fontSize: "28px", fontWeight: 800, marginBottom: "12px" }}>Access Restricted</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: "24px" }}>
            The Administration panel requires an owner-validated cryptographic signature. Connect your wallet to proceed.
          </p>
        </div>
      </div>
    );
  }

  if (!isUserAdmin) {
    return (
      <div className="container" style={{ minHeight: "calc(100vh - 81px)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="glass-card" style={{ textAlign: "center", maxWidth: "520px", width: "100%", padding: "40px", border: "1px solid var(--error)" }}>
          <ShieldAlert size={64} style={{ color: "var(--error)", marginBottom: "24px" }} className="animated-float" />
          <h2 style={{ fontSize: "28px", fontWeight: 800, marginBottom: "12px" }} className="glow-text-error">Access Denied</h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: "24px", lineHeight: "1.6" }}>
            Your connected address (<span style={{ fontFamily: "monospace", color: "white" }}>{address?.substring(0, 8)}...{address?.substring(38)}</span>) is not authorized as the contract administrator.
          </p>
          <div style={{ background: "rgba(239, 68, 68, 0.05)", border: "1px solid rgba(239, 68, 68, 0.2)", padding: "16px", borderRadius: "12px", textAlign: "left", fontSize: "13px", color: "var(--text-secondary)" }}>
            <strong>Empirical Learning Check:</strong><br />
            This is <em>Role-Based Access Control (RBAC)</em> at work. The contract executes <code>require(msg.sender == owner)</code> inside Solidity. Try switching to the deploying account inside MetaMask to unlock these admin tools!
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ padding: "40px 24px" }}>
      {/* Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "40px", flexWrap: "wrap", gap: "20px" }}>
        <div>
          <h1 style={{ fontSize: "36px", fontWeight: 800, marginBottom: "6px" }} className="glow-text-purple">Admin Command Center</h1>
          <p style={{ color: "var(--text-secondary)" }}>You are connected as owner. Execute global settings, mint controls, and emergency protocols.</p>
        </div>
        <button className="btn btn-secondary" onClick={refreshAdminData} style={{ display: "inline-flex", gap: "8px" }}>
          <RefreshCw size={16} /> Sync Configuration
        </button>
      </header>

      {/* Grid: Admin Stats & System State */}
      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "24px", marginBottom: "40px" }}>
        
        {/* Core settings status */}
        <div className="glass-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
            <Settings size={18} className="glow-text-purple" /> Yield Distribution Speed
          </h3>
          <div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>Staking Yield Rate</div>
            <div style={{ fontSize: "24px", fontWeight: 800 }} className="glow-text-cyan">
              {currentRate ? Number(formatEther(currentRate as bigint)).toFixed(0) : "0"} NEX/s
            </div>
          </div>
        </div>

        {/* Cooldown Settings Status */}
        <div className="glass-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
            <Hourglass size={18} className="glow-text-cyan" /> Withdrawal Cooldown safety
          </h3>
          <div>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", textTransform: "uppercase", fontWeight: 600 }}>Active Lock Delay</div>
            <div style={{ fontSize: "24px", fontWeight: 800 }} className="glow-text-purple">
              {currentCooldown ? Number(currentCooldown).toString() : "60"} Seconds
            </div>
          </div>
        </div>

        {/* Global Pause Protocol */}
        <div className="glass-card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", border: isPaused ? "1px solid var(--error)" : "1px solid var(--success)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}>
            <div>
              <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "4px", display: "flex", gap: "8px", alignItems: "center" }}>
                <ShieldCheck size={18} style={{ color: isPaused ? "var(--error)" : "var(--success)" }} /> Emergency Stop
              </h3>
              <p style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                Circuit breaker to freeze staking and claiming logs.
              </p>
            </div>
            <button
              onClick={handleTogglePause}
              className={`btn ${isPaused ? "btn-primary glow-border-cyan" : "btn-danger"}`}
              style={{ minWidth: "120px", padding: "10px 14px" }}
            >
              {isPaused ? (
                <>
                  <Play size={14} /> Unpause
                </>
              ) : (
                <>
                  <Pause size={14} /> Pause System
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Admin Actions Forms Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr", gap: "24px", marginBottom: "40px" }}>
        
        {/* Token Supply adjustments (Mint / Burn) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          {/* Admin Mint Card */}
          <div className="glass-card">
            <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <Plus size={20} className="glow-text-purple" /> Direct Supply Inflation (Mint)
            </h3>
            <form onSubmit={handleMint} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "16px" }}>
                <div className="input-group" style={{ marginBottom: 0 }}>
                  <label className="input-label">Recipient Address</label>
                  <input
                    type="text"
                    placeholder="0x..."
                    className="input-field"
                    value={mintAddress}
                    onChange={(e) => setMintAddress(e.target.value)}
                  />
                </div>
                <div className="input-group" style={{ marginBottom: 0 }}>
                  <label className="input-label">Amount NEX</label>
                  <input
                    type="number"
                    placeholder="0.0"
                    className="input-field"
                    value={mintAmount}
                    onChange={(e) => setMintAmount(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-end" }}>
                Execute On-Chain Mint
              </button>
            </form>
          </div>

          {/* Admin Burn Card */}
          <div className="glass-card">
            <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <Flame size={20} style={{ color: "var(--neon-pink)" }} /> Direct Supply Deflation (Burn)
            </h3>
            <form onSubmit={handleBurn} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "16px" }}>
                <div className="input-group" style={{ marginBottom: 0 }}>
                  <label className="input-label">Target Address</label>
                  <input
                    type="text"
                    placeholder="0x..."
                    className="input-field"
                    value={burnAddress}
                    onChange={(e) => setBurnAddress(e.target.value)}
                  />
                </div>
                <div className="input-group" style={{ marginBottom: 0 }}>
                  <label className="input-label">Amount NEX</label>
                  <input
                    type="number"
                    placeholder="0.0"
                    className="input-field"
                    value={burnAmount}
                    onChange={(e) => setBurnAmount(e.target.value)}
                  />
                </div>
              </div>
              <button type="submit" className="btn btn-secondary" style={{ alignSelf: "flex-end", color: "var(--neon-pink)", borderColor: "rgba(236, 72, 153, 0.3)" }}>
                Execute On-Chain Burn
              </button>
            </form>
          </div>
        </div>

        {/* Global Multipliers & Cooldown Safety Delay */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          
          {/* Staking Reward Rate Adjustment */}
          <div className="glass-card">
            <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <Settings size={20} className="glow-text-cyan" /> Modify Base Yield Speed
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", lineHeight: "1.5", marginBottom: "16px" }}>
              Increase or decrease global reward points emission speed. Affects active stake calculations on succeeding block confirmations.
            </p>
            <form onSubmit={handleSetRate} style={{ display: "flex", gap: "16px", alignItems: "flex-end" }}>
              <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="input-label">New Rate (NEX / ETH / s)</label>
                <input
                  type="number"
                  placeholder="e.g. 100"
                  className="input-field"
                  value={newRate}
                  onChange={(e) => setNewRate(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-primary">
                Update Rate
              </button>
            </form>
          </div>

          {/* Cooldown Safety Duration adjustment */}
          <div className="glass-card">
            <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "16px", display: "flex", gap: "8px", alignItems: "center" }}>
              <Hourglass size={20} className="glow-text-purple" /> Adjust Withdrawal Cooldown Lock
            </h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", lineHeight: "1.5", marginBottom: "16px" }}>
              Modify the safety latency required between requesting unstaking and completed payout (Maximum limit is set to 14 days).
            </p>
            <form onSubmit={handleSetCooldown} style={{ display: "flex", gap: "16px", alignItems: "flex-end" }}>
              <div className="input-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="input-label">Lock Duration (Seconds)</label>
                <input
                  type="number"
                  placeholder="e.g. 60"
                  className="input-field"
                  value={newCooldown}
                  onChange={(e) => setNewCooldown(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary">
                Update Lock
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Emergency sweep card below */}
      <section className="glass-card glow-border-purple" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h3 style={{ fontSize: "18px", fontWeight: 700, marginBottom: "8px", display: "flex", gap: "8px", alignItems: "center" }}>
            <Landmark size={20} className="glow-text-purple" /> Emergency Vault Sweeper Protocol
          </h3>
          <p style={{ color: "var(--text-secondary)", fontSize: "13px", maxWidth: "700px", lineHeight: "1.5" }}>
            In contract migrations or audits, sweep virtual Ether held inside this staking engine contract straight to the owner wallet. Use with extreme security considerations.
          </p>
        </div>
        <button onClick={handleEmergencyWithdraw} className="btn btn-danger" style={{ padding: "12px 24px" }}>
          Sweep Contract Ether
        </button>
      </section>
    </div>
  );
}
