"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Loader2 } from "lucide-react";

interface PublicAgent {
  id: string;
  displayName: string | null;
  tradingWallet: string | null;
  status: string;
  erc8004AgentId: string | null;
  agentNumber: number | null;
  deployedAt: string | null;
}

export default function ExplorePage() {
  const [agents, setAgents] = useState<PublicAgent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/explore")
      .then((r) => r.json())
      .then((d: { agents?: PublicAgent[] }) => setAgents(d.agents || []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-void grid-bg">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <h1
            className="text-2xl font-bold text-text-primary"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Explore Agents
          </h1>
          <Link href="/login" className="text-sm text-cyan hover:underline">
            Login
          </Link>
        </div>

        {loading ? (
          <Loader2 className="size-5 text-neon animate-spin" />
        ) : agents.length === 0 ? (
          <div className="glass-raised rounded-xl p-8 text-center text-text-muted">
            <Bot className="size-10 mx-auto mb-3 opacity-50" />
            No public agents yet.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {agents.map((a) => (
              <Link
                key={a.id}
                href={`/agents/${a.id}`}
                className="glass-raised rounded-xl p-4 block hover:border-cyan/30 border border-transparent"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-text-primary">
                    {a.displayName || `Agent #${a.agentNumber ?? a.id.slice(0, 6)}`}
                  </span>
                  {a.agentNumber != null && (
                    <span className="text-[10px] font-mono text-cyan">#{a.agentNumber}</span>
                  )}
                  <span className="text-[10px] uppercase text-text-muted">{a.status}</span>
                </div>
                <p className="text-[11px] font-mono text-text-muted mt-1 truncate">
                  {a.tradingWallet || "—"}
                </p>
                {a.erc8004AgentId && (
                  <p className="text-[10px] font-mono text-cyan mt-0.5">
                    ERC-8004 {a.erc8004AgentId}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
