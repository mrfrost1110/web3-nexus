"use client";

/**
 * Persistent top navigation bar, rendered by the root layout on every route.
 *
 * Owns the wallet connect button, which is why this must be a client component: it reads
 * the current pathname and RainbowKit's connection state, neither of which exists during
 * server rendering.
 */

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Cpu } from "lucide-react";

export default function Navigation() {
  // Drives the active-link highlight. `usePathname` re-renders on client-side navigation,
  // which a static `window.location` read would not.
  const pathname = usePathname();

  return (
    <nav className="navbar">
      <Link href="/" className="nav-logo">
        <Cpu size={28} className="glow-text-cyan" />
        <span>WEB3<span className="glow-text-purple">NEXUS</span></span>
      </Link>

      <div className="nav-links">
        <Link href="/" className={`nav-link ${pathname === "/" ? "active" : ""}`}>
          Home
        </Link>
        <Link href="/dashboard" className={`nav-link ${pathname === "/dashboard" ? "active" : ""}`}>
          Dashboard
        </Link>
        <Link href="/admin" className={`nav-link ${pathname === "/admin" ? "active" : ""}`}>
          Admin Portal
        </Link>

        {/*
          RainbowKit's connect button handles the whole wallet lifecycle: connect, account
          display, network switching, and the wrong-network warning.

          `showBalance` is off because the dashboard already shows the ETH balance in a
          stat card, and duplicating it in the nav invites the two to disagree while a
          transaction is confirming.
        */}
        <ConnectButton
          showBalance={false}
          chainStatus="icon"
          accountStatus="address"
        />
      </div>
    </nav>
  );
}
