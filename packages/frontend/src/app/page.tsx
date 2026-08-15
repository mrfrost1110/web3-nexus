"use client";

/**
 * Landing page.
 *
 * Static marketing and explanatory content — it reads no chain state and requires no
 * wallet. Three sections: a hero with the WebGL scene, a capability grid, and a primer
 * explaining wallets, staking, gas, and contracts for readers new to the space.
 *
 * Marked `"use client"` for the dynamic import below, which needs a browser-only bundle.
 */

import React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowRight, Sparkles, Shield, Award, Wallet, Landmark, Zap, FileCode } from "lucide-react";

/**
 * The Three.js scene, loaded on the client only.
 *
 * `ssr: false` is required, not an optimization: Three.js needs a WebGL context, which
 * does not exist on the server. It also splits Three.js into its own chunk, so the initial
 * page payload stays small and the placeholder below holds the hero's layout until the
 * scene arrives.
 */
const WebGLCanvas = dynamic(() => import("@/components/WebGLCanvas"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#030712",
        color: "var(--neon-cyan)",
        fontSize: "14px",
        fontWeight: 600,
        fontFamily: "monospace",
      }}
    >
      <div className="animated-float" style={{ textShadow: "0 0 10px rgba(6,182,212,0.5)" }}>
        CONNECTING LEDGER MATRIX...
      </div>
    </div>
  ),
});

/**
 * The four concepts explained in the primer section, in reading order.
 *
 * Held as data rather than repeated markup so the card shell is written once — the four
 * blocks previously differed only in their icon, accent, and copy.
 *
 * Each `tint` is its `color` at low alpha, used as the icon chip's background. They are
 * written literally rather than derived from the CSS custom properties because those
 * tokens are hex, and `rgba()` cannot take a hex variable.
 */
const EDUCATION_TOPICS = [
  {
    step: 1,
    title: "What is a Wallet?",
    body:
      "A wallet is your identity. It contains a private key (your secret password) and public key (your address). It doesn't store coins; it unlocks your ownership on the public ledger.",
    accent: { color: "var(--neon-cyan)", tint: "rgba(6, 182, 212, 0.12)" },
    Icon: Wallet,
  },
  {
    step: 2,
    title: "What is Staking?",
    body:
      "Staking is locking your assets (ETH) into a smart contract to support a network mechanism. In return, you are minted utility tokens (NEX) as rewards relative to the duration of your lock.",
    accent: { color: "var(--neon-purple)", tint: "rgba(168, 85, 247, 0.12)" },
    Icon: Landmark,
  },
  {
    step: 3,
    title: "What is Gas?",
    body:
      'Every calculation on a decentralized computer takes electric power. "Gas" is the micro-payment (in Gwei/ETH) you pay to validators to execute and append your transaction to the ledger.',
    accent: { color: "var(--neon-pink)", tint: "rgba(236, 72, 153, 0.12)" },
    Icon: Zap,
  },
  {
    step: 4,
    title: "What is a Contract?",
    body:
      "A Smart Contract is a self-executing, immutable program running on-chain. It functions exactly as written (e.g., our Staking math) without relying on any intermediary bank or database.",
    accent: { color: "var(--success)", tint: "rgba(16, 185, 129, 0.12)" },
    Icon: FileCode,
  },
] as const;

export default function LandingPage() {
  return (
    <div className="container">
      {/* Hero Section */}
      <section className="hero-section">
        <div className="hero-content">
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              background: "rgba(6, 182, 212, 0.1)",
              border: "1px solid rgba(6, 182, 212, 0.2)",
              padding: "6px 12px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: 600,
              color: "var(--neon-cyan)",
              marginBottom: "16px",
            }}
          >
            <Sparkles size={14} />
            <span>Next-Generation Staking Yield Engine</span>
          </div>
          
          <h1 className="hero-title">
            Enter the <span className="glow-text-cyan">Web3</span> <span className="glow-text-purple">Nexus</span>
          </h1>
          
          <p className="hero-subtitle">
            An immersive, fullstack decentralized platform designed to teach you Web3 concepts
            empirically. Stake virtual ETH on a local ledger, earn real-time utility NEX tokens,
            and monitor cryptographic transactions live.
          </p>
          
          <div style={{ display: "flex", gap: "16px" }}>
            <Link href="/dashboard" className="btn btn-primary" style={{ textDecoration: "none" }}>
              Launch Dashboard <ArrowRight size={16} />
            </Link>
            <a href="#education" className="btn btn-secondary" style={{ textDecoration: "none" }}>
              Learn How It Works
            </a>
          </div>
        </div>
        
        {/* Beautiful Interactive 3D WebGL Canvas */}
        <div className="hero-canvas-container">
          <WebGLCanvas />
        </div>
      </section>

      {/* Feature grid */}
      <section style={{ padding: "80px 0" }}>
        <div style={{ textAlign: "center", marginBottom: "48px" }}>
          <h2 style={{ fontSize: "36px", fontWeight: 800, marginBottom: "12px" }}>Engine Capabilities</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: "600px", margin: "0 auto" }}>
            Web3 Nexus is fully equipped with professional-grade smart contract integrations and responsive animations.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "24px" }}>
          <div className="glass-card">
            <Shield size={32} className="glow-text-cyan" style={{ marginBottom: "16px" }} />
            <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>Cryptographic Security</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
              Built using industry-standard OpenZeppelin frameworks featuring ReentrancyGuards and strict owner access control patterns.
            </p>
          </div>

          <div className="glass-card">
            <Award size={32} className="glow-text-purple" style={{ marginBottom: "16px" }} />
            <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>High-Fidelity Yield</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
              Our yield accumulator updates your balances per block using solid-state mathematical tracking on the virtual machine.
            </p>
          </div>

          <div className="glass-card">
            <Sparkles size={32} style={{ color: "var(--neon-pink)", marginBottom: "16px" }} />
            <h3 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>Interactive Administration</h3>
            <p style={{ color: "var(--text-secondary)", fontSize: "14px", lineHeight: "1.6" }}>
              Features a fully functional administrative command center allowing the owner to pause activities, adjust rates, and manage supply.
            </p>
          </div>
        </div>
      </section>

      {/* Educational Section */}
      <section id="education" style={{ padding: "80px 0", borderTop: "1px solid var(--border-color)" }}>
        <div style={{ textAlign: "center", marginBottom: "48px" }}>
          <h2 style={{ fontSize: "36px", fontWeight: 800, marginBottom: "12px" }}>Web3 Decoded for Beginners</h2>
          <p style={{ color: "var(--text-secondary)", maxWidth: "600px", margin: "0 auto" }}>
            Web3 can feel complex. Let's break down exactly what happens when you use this app.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "24px" }}>
          {EDUCATION_TOPICS.map(({ step, title, body, accent, Icon }) => (
            <div key={step} className="glass-card">
              {/* Accent lives in the icon's tinted chip, matching the stat cards on the
                  dashboard. Each topic gets its own icon so the four cards are told apart
                  by subject rather than by color alone. */}
              <div
                style={{
                  display: "inline-flex",
                  padding: "10px",
                  borderRadius: "12px",
                  background: accent.tint,
                  marginBottom: "16px",
                }}
              >
                <Icon size={22} style={{ color: accent.color }} />
              </div>
              <h4 style={{ fontWeight: 700, marginBottom: "8px" }}>
                {/* The step number is reading order for a beginner, not decoration — the
                    grid reflows, so the sequence has to be stated rather than implied. */}
                <span style={{ color: "var(--text-muted)", marginRight: "6px" }}>{step}.</span>
                {title}
              </h4>
              <p style={{ color: "var(--text-secondary)", fontSize: "13px", lineHeight: "1.6" }}>
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer style={{ padding: "40px 0", borderTop: "1px solid var(--border-color)", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
        <p>© 2026 Web3 Nexus Ledger. Created as an advanced fullstack reference implementation.</p>
      </footer>
    </div>
  );
}
