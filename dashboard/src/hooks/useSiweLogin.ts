"use client";

import { useCallback, useState } from "react";
import {
  createWalletClient,
  custom,
  getAddress,
  toHex,
  type Address,
  type EIP1193Provider,
} from "viem";
import { bsc } from "viem/chains";
import { SiweMessage } from "siwe";

declare global {
  interface Window {
    ethereum?: EIP1193Provider & {
      providers?: EIP1193Provider[];
      isMetaMask?: boolean;
    };
  }
}

export type WalletConnector = "injected" | "walletconnect";

export type SiwePhase =
  | "idle"
  | "connecting"
  | "switching"
  | "signing"
  | "verifying";

function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const eth = window.ethereum;
  if (!eth) return null;
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    return (
      eth.providers.find((p) => (p as { isMetaMask?: boolean }).isMetaMask) ||
      eth.providers[0]
    );
  }
  return eth;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out. Try again or use Browser Wallet.`)),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Best-effort BSC switch — never block login forever (WC often hangs here). */
async function ensureBsc(provider: EIP1193Provider) {
  try {
    const chainId = (await Promise.race([
      provider.request({ method: "eth_chainId" }),
      new Promise<string>((r) => setTimeout(() => r(""), 2000)),
    ])) as string;

    if (chainId && Number.parseInt(chainId, 16) === 56) return;

    await withTimeout(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x38" }],
      }),
      8_000,
      "Switch to BNB Smart Chain"
    );
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      try {
        await withTimeout(
          provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x38",
                chainName: "BNB Smart Chain",
                nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                rpcUrls: ["https://bsc-dataseed.binance.org"],
                blockExplorerUrls: ["https://bscscan.com"],
              },
            ],
          }),
          12_000,
          "Add BNB Smart Chain"
        );
      } catch {
        /* continue — SIWE still works if wallet stays on another EVM chain for personal_sign */
      }
      return;
    }
    /* ignore switch timeouts / unsupported methods */
  }
}

async function createWalletConnectProvider(): Promise<EIP1193Provider> {
  const projectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ||
    process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error(
      "WalletConnect is not configured: set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env"
    );
  }

  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId,
    chains: [56],
    optionalChains: [56],
    showQrModal: true,
    metadata: {
      name: "Neural Alpha",
      description: "Autonomous BSC trading agents",
      url: typeof window !== "undefined" ? window.location.origin : "https://neural-alpha.app",
      icons: [],
    },
  });

  // Prefer connect(); fall back to enable() for older provider builds
  if (typeof provider.connect === "function") {
    await provider.connect();
  } else {
    await provider.enable();
  }
  return provider as unknown as EIP1193Provider;
}

async function signSiweMessage(
  provider: EIP1193Provider,
  address: Address,
  prepared: string
): Promise<string> {
  const attempts: Array<() => Promise<unknown>> = [
    // Most WalletConnect mobile wallets
    () =>
      (provider.request as (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>)({
        method: "personal_sign",
        params: [toHex(prepared), address],
      }),
    // Some wallets expect UTF-8 string, not hex
    () =>
      (provider.request as (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>)({
        method: "personal_sign",
        params: [prepared, address],
      }),
    // viem fallback
    () => {
      const walletClient = createWalletClient({
        chain: bsc,
        transport: custom(provider),
      });
      return walletClient.signMessage({
        account: address,
        message: prepared,
      });
    },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const sig = (await withTimeout(attempt(), 120_000, "Sign-in request")) as string;
      if (sig) return sig;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/reject|denied|cancel/i.test(msg)) throw err;
      if (/timed out/i.test(msg)) throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Wallet did not return a signature");
}

async function completeSiwe(
  provider: EIP1193Provider,
  onPhase: (phase: SiwePhase) => void
): Promise<string> {
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  const raw = accounts[0];
  if (!raw) throw new Error("No account selected");

  const address = getAddress(raw) as Address;

  onPhase("switching");
  await ensureBsc(provider);

  onPhase("signing");
  const nonceRes = await fetch("/api/auth/nonce");
  if (!nonceRes.ok) throw new Error("Could not get login nonce");
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  if (!nonce) throw new Error("Could not get login nonce");

  const domain = window.location.host;
  const message = new SiweMessage({
    domain,
    address,
    statement: "Sign in to Neural Alpha to manage your trading agents.",
    uri: window.location.origin,
    version: "1",
    chainId: 56,
    nonce,
  });
  const prepared = message.prepareMessage();

  const signature = await signSiweMessage(provider, address, prepared);

  onPhase("verifying");
  const verifyRes = await fetch("/api/auth/siwe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: prepared, signature }),
  });
  const data = (await verifyRes.json()) as {
    ok?: boolean;
    wallet?: string;
    error?: unknown;
  };
  if (!verifyRes.ok || !data.ok) {
    const errMsg =
      typeof data.error === "string"
        ? data.error
        : data.error && typeof data.error === "object"
          ? JSON.stringify(data.error)
          : "SIWE login failed";
    throw new Error(errMsg);
  }
  return (data.wallet || address).toLowerCase();
}

export function useSiweLogin() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SiwePhase>("idle");
  const [activeConnector, setActiveConnector] = useState<WalletConnector | null>(
    null
  );

  const login = useCallback(async (connector: WalletConnector = "injected"): Promise<string> => {
    setLoading(true);
    setActiveConnector(connector);
    setError(null);
    setPhase("connecting");
    try {
      let provider: EIP1193Provider;

      if (connector === "walletconnect") {
        provider = await createWalletConnectProvider();
      } else {
        const injected = getInjectedProvider();
        if (!injected) {
          throw new Error(
            "No browser wallet found: install MetaMask, or use WalletConnect"
          );
        }
        provider = injected;
      }

      return await completeSiwe(provider, setPhase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg === "[object Object]" ? "Login failed" : msg);
      throw err;
    } finally {
      setLoading(false);
      setActiveConnector(null);
      setPhase("idle");
    }
  }, []);

  return { login, loading, error, activeConnector, phase };
}

export function siwePhaseLabel(
  phase: SiwePhase,
  connector: WalletConnector | null
): string {
  switch (phase) {
    case "connecting":
      return connector === "walletconnect"
        ? "Scan QR / approve connection…"
        : "Connecting wallet…";
    case "switching":
      return "Checking BNB Smart Chain…";
    case "signing":
      return "Sign the login message in your wallet…";
    case "verifying":
      return "Verifying signature…";
    default:
      return "Working…";
  }
}
