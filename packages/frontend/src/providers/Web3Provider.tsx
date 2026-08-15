"use client";

/**
 * Root Web3 provider stack.
 *
 * Three providers must wrap the app, in this order, for the chain hooks to work:
 *
 *   WagmiProvider        supplies chain config and the transport layer
 *   └─ QueryClientProvider   Wagmi v2 stores all read results in React Query
 *      └─ RainbowKitProvider wallet connection UI, needs the two above to exist
 *
 * The order is a hard requirement, not a style choice — each layer consumes context from
 * the one outside it. Mounted once in `app/layout.tsx`.
 */

import React from "react";
import "@rainbow-me/rainbowkit/styles.css";
import { getDefaultConfig, RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { WagmiProvider, http } from "wagmi";
import { hardhat, sepolia, mainnet } from "wagmi/chains";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

/**
 * React Query client backing every Wagmi read hook.
 *
 * Created at module scope rather than inside the component so it survives re-renders. A
 * client constructed in the render body would be replaced on each render, discarding the
 * cache and re-fetching every contract read.
 */
const queryClient = new QueryClient();

/**
 * WalletConnect Cloud project ID, required for QR and mobile wallet connections.
 *
 * Falls back to a shared public demo ID so the app runs with no setup — sufficient for
 * local development with a browser-extension wallet. Set
 * `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env.local` before distributing a build; see
 * `.env.example`.
 */
const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "b56e18d47c72ab683b10814fe9495694";

/**
 * Wagmi + RainbowKit configuration.
 *
 * Only `hardhat` has a deployed contract behind it. `sepolia` and `mainnet` are registered
 * so the wallet's network switcher has somewhere to switch to, which is what makes the
 * app's wrong-network handling observable.
 */
const config = getDefaultConfig({
  appName: "Web3 Nexus",
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [hardhat, sepolia, mainnet],
  // Required for Next.js App Router: without it, Wagmi tries to read wallet state during
  // server rendering and the client hydrates against a mismatched tree.
  ssr: true,
  transports: {
    // Points at the node started by `bun contracts:node`.
    [hardhat.id]: http("http://127.0.0.1:8545"),
    // Bare `http()` falls back to the chain's default public RPC endpoint.
    [sepolia.id]: http(),
    [mainnet.id]: http(),
  },
});

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          // Matches the neon palette in globals.css so the wallet modal does not read as a
          // third-party surface dropped on top of the app.
          theme={darkTheme({
            accentColor: "#06b6d4", // --neon-cyan
            accentColorForeground: "white",
            borderRadius: "medium",
            overlayBlur: "small",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
