"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthWallet } from "@/hooks/useReadOnly";
import { Bot, Plus, LogOut, ExternalLink, Loader2 } from "lucide-react";

interface AgentSummary {
  id: string;
  display_name: string | null;
  trading_wallet: string | null;
  status: string;
  erc8004_agent_id: string | null;
  agent_number: number | null;
  deployed_at: string | null;
  created_at: string;
}

export default function ProfilePage() {
  const { wallet, loading: authLoading, logout } = useAuthWallet();
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!wallet) {
      router.replace("/login");
      return;
    }
    fetch("/api/agents")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Failed to load agents");
        setAgents(d.agents || []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [wallet, authLoading, router]);

  if (authLoading || (!wallet && loading)) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <Loader2 className="size-6 text-neon animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-void grid-bg">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1
              className="text-2xl font-bold text-text-primary"
              style={{ fontFamily: "var(--font-display)" }}
            >
              My Agents
            </h1>
            <p className="text-xs text-text-muted font-mono mt-1">
              {wallet?.slice(0, 6)}…{wallet?.slice(-4)}
            </p>
          </div>
          <div className="flex gap-2">
            <Link
              href="/deploy"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-neon/15 text-neon border border-neon/30 text-sm font-semibold hover:bg-neon/25"
            >
              <Plus className="size-4" /> Deploy
            </Link>
            <button
              onClick={async () => {
                await logout();
                router.push("/login");
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-text-muted hover:text-danger text-sm"
            >
              <LogOut className="size-4" /> Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-4 py-2 text-xs text-danger font-mono">
            {error}
          </div>
        )}

        {loading ? (
          <Loader2 className="size-5 text-neon animate-spin" />
        ) : agents.length === 0 ? (
          <div className="glass-raised rounded-xl p-8 text-center">
            <Bot className="size-10 text-text-muted mx-auto mb-3" />
            <p className="text-text-secondary mb-4">No agents yet.</p>
            <Link
              href="/deploy"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-neon/15 text-neon border border-neon/30 text-sm font-semibold"
            >
              <Plus className="size-4" /> Deploy your first agent
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                className="glass-raised rounded-xl p-4 hover:border-neon/30 border border-transparent transition-colors block"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-text-primary truncate">
                        {a.display_name || `Agent ${a.id.slice(0, 8)}`}
                      </h2>
                      {a.agent_number != null && (
                        <span className="text-[10px] font-mono text-cyan">#{a.agent_number}</span>
                      )}
                      <span
                        className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
                          a.status === "running"
                            ? "bg-neon/10 text-neon"
                            : a.status === "failed"
                              ? "bg-danger/10 text-danger"
                              : "bg-warning/10 text-warning"
                        }`}
                      >
                        {a.status}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-muted font-mono mt-1 truncate">
                      {a.trading_wallet || "—"} · id {a.id.slice(0, 8)}…
                    </p>
                    {a.erc8004_agent_id && (
                      <p className="text-[10px] text-cyan font-mono mt-0.5">
                        ERC-8004: {a.erc8004_agent_id}
                      </p>
                    )}
                  </div>
                  <ExternalLink className="size-4 text-text-muted shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        )}

        <p className="mt-8 text-xs text-text-muted text-center">
          <Link href="/" className="text-cyan hover:underline">
            Monitor
          </Link>
          {" · "}
          <Link href="/explore" className="text-cyan hover:underline">
            Explore
          </Link>
        </p>
      </div>
    </div>
  );
}
