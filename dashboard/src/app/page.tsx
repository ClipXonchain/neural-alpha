"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthWallet } from "@/hooks/useReadOnly";
import { Bot, Wallet, Rocket, Compass, ArrowRight, Loader2 } from "lucide-react";

export default function HomePage() {
  const { wallet, loading } = useAuthWallet();
  const router = useRouter();

  useEffect(() => {
    if (!loading && wallet) {
      router.replace("/profile");
    }
  }, [wallet, loading, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <Loader2 className="size-6 text-neon animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void grid-bg flex flex-col">
      <header className="px-6 py-5 flex items-center justify-between max-w-5xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <Bot className="size-5 text-neon" />
          <span
            className="font-bold tracking-tight text-text-primary"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Neural Alpha
          </span>
        </div>
        <Link
          href="/explore"
          className="text-xs text-cyan hover:underline font-mono"
        >
          Explore agents
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 pb-16">
        <div className="max-w-xl w-full text-center">
          <h1
            className="text-4xl md:text-5xl font-bold text-text-primary mb-4"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Deploy your autonomous
            <span className="text-neon text-glow-neon"> BSC agent</span>
          </h1>
          <p className="text-text-secondary text-sm md:text-base mb-10 leading-relaxed">
            Connect your wallet, deploy an isolated self-custodial trading agent,
            fund it with USDT, and control it from your dashboard. Live execution
            on BNB Smart Chain only: no paper trading.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-12">
            <Link
              href="/login"
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-neon/15 text-neon border border-neon/30 font-semibold hover:bg-neon/25 transition-colors"
            >
              <Wallet className="size-4" />
              Connect wallet
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/login?next=/deploy"
              className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl glass-raised text-text-primary border border-border-dim font-semibold hover:border-cyan/30 transition-colors"
            >
              <Rocket className="size-4 text-cyan" />
              Deploy agent
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
            {[
              {
                step: "1",
                title: "Connect",
                desc: "Sign in with your BSC wallet (SIWE). You stay in control of ownership.",
              },
              {
                step: "2",
                title: "Deploy",
                desc: "Pay a small BNB fee and get a dedicated agent + trading wallet.",
              },
              {
                step: "3",
                title: "Trade live",
                desc: "Fund the agent wallet with USDT + BNB gas. Monitor and configure from your dashboard.",
              },
            ].map((item) => (
              <div
                key={item.step}
                className="glass-raised rounded-xl p-4 border border-border-dim/60"
              >
                <span className="text-[10px] font-mono text-cyan font-bold">
                  STEP {item.step}
                </span>
                <h3 className="text-sm font-semibold text-text-primary mt-1 mb-1">
                  {item.title}
                </h3>
                <p className="text-[11px] text-text-muted leading-relaxed">
                  {item.desc}
                </p>
              </div>
            ))}
          </div>

          <Link
            href="/explore"
            className="inline-flex items-center gap-1.5 mt-8 text-xs text-text-muted hover:text-cyan transition-colors"
          >
            <Compass className="size-3.5" />
            Browse public agents
          </Link>
        </div>
      </main>
    </div>
  );

}
