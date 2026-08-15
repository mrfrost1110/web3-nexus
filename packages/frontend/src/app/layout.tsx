/**
 * Root layout for the App Router.
 *
 * Establishes the provider tree every route depends on. The nesting is ordered by
 * dependency: `Web3Provider` supplies the chain hooks, `ToastProvider` supplies the
 * notification context those hooks report into, and `Navigation` consumes both — it
 * renders RainbowKit's connect button, so it must sit inside the Web3 provider.
 *
 * This file stays a server component. Each provider carries its own `"use client"`
 * directive, which keeps the client boundary as small as possible.
 */

import React from "react";
import type { Metadata } from "next";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { ToastProvider } from "@/components/Toast";
import Navigation from "@/components/Navigation";

export const metadata: Metadata = {
  title: "Web3 Nexus - Yield & Staking Engine",
  description:
    "A fullstack Ethereum staking and yield reference implementation with an interactive WebGL landing page.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>
          <ToastProvider>
            <Navigation />
            <main>{children}</main>
          </ToastProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
