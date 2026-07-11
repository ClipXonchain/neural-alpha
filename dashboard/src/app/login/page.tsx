"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useSiweLogin,
  siwePhaseLabel,
  type WalletConnector,
} from "@/hooks/useSiweLogin";
import { useAuthWallet } from "@/hooks/useReadOnly";
import { Wallet, Loader2, QrCode } from "lucide-react";

function LoginForm() {
  const { login, loading, error, activeConnector, phase } = useSiweLogin();
  const { wallet, setWallet } = useAuthWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/profile";
  const [localErr, setLocalErr] = useState<string | null>(null);

  const hasWalletConnect = Boolean(
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ||
      process.env.NEXT_PUBLIC_WC_PROJECT_ID?.trim()
  );

  if (wallet) {
    router.replace(next.startsWith("/") ? next : "/profile");
  }

  const handleLogin = async (connector: WalletConnector) => {
    setLocalErr(null);
    try {
      const addr = await login(connector);
      setWallet(addr);
      router.push(next.startsWith("/") ? next : "/profile");
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : e && typeof e === "object" && "message" in e
            ? String((e as { message: unknown }).message)
            : typeof e === "string"
              ? e
              : "Login failed";
      setLocalErr(msg === "[object Object]" ? "Login failed" : msg);
    }
  };

  const statusText =
    loading && activeConnector ? siwePhaseLabel(phase, activeConnector) : null;

  return (
    <div className="min-h-screen bg-void grid-bg flex items-center justify-center px-4">
      <div className="glass-raised rounded-2xl p-8 max-w-md w-full">
        <h1
          className="text-2xl font-bold text-text-primary mb-2"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Connect Wallet
        </h1>
        <p className="text-sm text-text-secondary mb-6">
          Sign in with your BSC wallet (SIWE) to deploy and control Neural Alpha agents.
        </p>

        <div className="flex flex-col gap-3">
          <button
            onClick={() => handleLogin("injected")}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-neon/15 text-neon border border-neon/30 hover:bg-neon/25 disabled:opacity-50 font-semibold transition-colors"
          >
            {loading && activeConnector === "injected" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wallet className="size-4" />
            )}
            {loading && activeConnector === "injected"
              ? statusText
              : "Browser Wallet"}
          </button>

          <button
            onClick={() => handleLogin("walletconnect")}
            disabled={loading || !hasWalletConnect}
            title={
              hasWalletConnect
                ? "Scan with Trust Wallet, MetaMask mobile, etc."
                : "Set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to enable"
            }
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl glass-raised text-text-primary border border-border-dim hover:border-cyan/40 disabled:opacity-40 font-semibold transition-colors"
          >
            {loading && activeConnector === "walletconnect" ? (
              <Loader2 className="size-4 animate-spin text-cyan" />
            ) : (
              <QrCode className="size-4 text-cyan" />
            )}
            {loading && activeConnector === "walletconnect"
              ? statusText
              : "WalletConnect"}
          </button>
        </div>

        {statusText && (
          <p className="mt-3 text-[11px] text-cyan font-mono text-center leading-relaxed">
            {phase === "signing"
              ? "Connection done. Check your phone/wallet for a second prompt to sign the login message."
              : statusText}
          </p>
        )}

        {!hasWalletConnect && (
          <p className="mt-3 text-[11px] text-text-muted font-mono leading-relaxed">
            WalletConnect needs{" "}
            <code className="text-cyan">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code>{" "}
            from{" "}
            <a
              href="https://cloud.walletconnect.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan hover:underline"
            >
              cloud.walletconnect.com
            </a>
          </p>
        )}

        {(error || localErr) && (
          <p className="mt-4 text-xs text-danger font-mono whitespace-pre-wrap break-all">
            {error || localErr}
          </p>
        )}

        <p className="mt-6 text-xs text-text-muted text-center">
          <Link href="/" className="text-cyan hover:underline">
            ← Back home
          </Link>
          {" · "}
          <Link href="/explore" className="text-cyan hover:underline">
            Explore agents
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-void flex items-center justify-center">
          <Loader2 className="size-6 text-neon animate-spin" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
