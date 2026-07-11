"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  Send,
  ChevronDown,
  X,
  Loader2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { sendCommand, type CommandResult } from "@/lib/agent-api";

interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  ok?: boolean;
  suggestions?: string[];
}

function FormattedMessage({ text }: { text: string }) {
  const parts = useMemo(() => {
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^[━─]{4,}/.test(trimmed)) {
        elements.push(
          <div key={i} className="border-t border-neon/10 my-1" />
        );
        continue;
      }

      if (/^[▸►]/.test(trimmed)) {
        elements.push(
          <div key={i} className="text-neon/90 font-semibold mt-2 mb-0.5 text-[11px]">
            {trimmed}
          </div>
        );
        continue;
      }

      if (/^(📊|💼|🌐|⚙️|🛒|📤|📖|📋|❓|⚠️|✅|❌)/.test(trimmed)) {
        elements.push(
          <div key={i} className="text-text-primary font-bold text-[11px]">
            {trimmed}
          </div>
        );
        continue;
      }

      if (/^💡/.test(trimmed)) {
        elements.push(
          <div key={i} className="text-neon/60 italic mt-1 text-[10px]">
            {trimmed}
          </div>
        );
        continue;
      }

      if (/^•/.test(trimmed)) {
        elements.push(
          <div key={i} className="text-text-secondary pl-2">
            {trimmed}
          </div>
        );
        continue;
      }

      const kvMatch = trimmed.match(/^(\S[\w\s()\/&]+?):\s{2,}(.+)$/);
      if (kvMatch) {
        elements.push(
          <div key={i} className="flex gap-1">
            <span className="text-text-muted shrink-0">{kvMatch[1]}:</span>
            <span className="text-text-primary">{kvMatch[2]}</span>
          </div>
        );
        continue;
      }

      if (trimmed === "") {
        elements.push(<div key={i} className="h-1" />);
        continue;
      }

      const hasTableChars = /^[A-Z─🟢🔴🟡]/.test(trimmed) && /\s{2,}/.test(trimmed);
      if (hasTableChars) {
        if (/^[─]+/.test(trimmed)) {
          elements.push(<div key={i} className="border-t border-white/5 my-0.5" />);
        } else {
          elements.push(
            <div key={i} className="text-text-secondary font-mono">{line}</div>
          );
        }
        continue;
      }

      elements.push(
        <div key={i} className="text-text-primary">{line}</div>
      );
    }

    return elements;
  }, [text]);

  return <div className="space-y-0">{parts}</div>;
}

const SUGGESTIONS = [
  "Portfolio",
  "Buy opportunities",
  "Top signals",
  "Eligible tokens",
  "Market overview",
  "Agent status",
];

export function CommandPanel({ connected }: { connected: boolean }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "agent",
      text: "Hey! I'm your Neural Alpha AI assistant. Ask me anything: trade tokens, check signals, analyze the market, or just chat about crypto.",
      timestamp: Date.now(),
      ok: true,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingHint, setLoadingHint] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = useCallback(
    async (text?: string) => {
      const cmd = (text ?? input).trim();
      if (!cmd || loading) return;

      const userMsg: Message = {
        id: `u-${Date.now()}`,
        role: "user",
        text: cmd,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);
      setLoadingHint(
        /^(buy|sell|swap)\b/i.test(cmd)
          ? "Executing on-chain: may take up to 2 minutes…"
          : null
      );

      try {
        const result: CommandResult = connected
          ? await sendCommand(cmd)
          : { ok: false, intent: "offline", message: "Agent is offline: start it first." };

        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "agent",
            text: result.message,
            timestamp: Date.now(),
            ok: result.ok,
            suggestions: result.suggestions,
          },
        ]);
      } catch (err) {
        let msg = err instanceof Error ? err.message : String(err);
        if (/^unauthorized$/i.test(msg.trim())) {
          msg =
            "Unauthorized: the dashboard could not authenticate with the agent. " +
            "On localhost: restart the dashboard after pulling latest (it now reads API_SECRET from the repo .env). " +
            "On agents.clipx.app: trading is disabled (monitoring-only).";
        }
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: "agent",
            text: msg,
            timestamp: Date.now(),
            ok: false,
          },
        ]);
      } finally {
        setLoading(false);
        setLoadingHint(null);
      }
    },
    [input, loading, connected],
  );

  return (
    <>
      {/* Floating toggle */}
      {!open && (
        <motion.button
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center justify-center size-12 rounded-full bg-neon/20 text-neon border border-neon/30 shadow-lg shadow-neon/10 backdrop-blur-md hover:bg-neon/30 transition-colors"
        >
          <Sparkles className="size-5" />
        </motion.button>
      )}

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ y: 400, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 400, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-6 right-6 z-50 w-[420px] max-h-[520px] flex flex-col rounded-xl border border-neon/20 bg-void/95 backdrop-blur-xl shadow-2xl shadow-neon/5 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 bg-surface/50">
              <div className="flex items-center gap-2 text-sm font-mono font-semibold text-neon">
                <Sparkles className="size-4" />
                AI Assistant
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setOpen(false)}
                  className="p-1 rounded hover:bg-white/5 text-text-muted hover:text-text-primary transition-colors"
                >
                  <ChevronDown className="size-4" />
                </button>
                <button
                  onClick={() => {
                    setMessages((prev) => [prev[0]]);
                    setOpen(false);
                  }}
                  className="p-1 rounded hover:bg-white/5 text-text-muted hover:text-text-primary transition-colors"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[260px] max-h-[360px] scrollbar-thin"
            >
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex",
                    msg.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  <div
                    className={cn(
                      "max-w-[90%] rounded-lg px-3 py-2 text-xs font-mono leading-relaxed",
                      msg.role === "user"
                        ? "bg-neon/10 text-neon border border-neon/20 whitespace-pre-wrap"
                        : msg.ok === false
                          ? "bg-danger/5 text-danger/90 border border-danger/10"
                          : "bg-surface/80 text-text-primary border border-white/5"
                    )}
                  >
                    {msg.role === "agent" ? (
                      <>
                        <FormattedMessage text={msg.text} />
                        {msg.suggestions && msg.suggestions.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-white/5">
                            {msg.suggestions.map((s) => (
                              <button
                                key={s}
                                type="button"
                                onClick={() => submit(s)}
                                disabled={loading}
                                className="px-2 py-0.5 rounded text-[10px] font-mono bg-neon/10 text-neon hover:bg-neon/20 border border-neon/20 transition-all disabled:opacity-40"
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      msg.text
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="flex flex-col gap-1 px-3 py-2 rounded-lg bg-surface/80 border border-white/5 text-xs text-text-muted">
                    <div className="flex items-center gap-2">
                      <Loader2 className="size-3 animate-spin" />
                      {loadingHint ?? "Processing…"}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Suggestions */}
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  disabled={loading}
                  className="px-2 py-0.5 rounded text-[10px] font-mono bg-white/5 text-text-muted hover:text-neon hover:bg-neon/5 border border-white/5 hover:border-neon/20 transition-all disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Input */}
            <div className="px-3 pb-3 pt-1">
              <div className="flex items-center gap-2 rounded-lg bg-surface/60 border border-white/10 focus-within:border-neon/30 transition-colors px-3 py-2">
                <span className="text-neon/60 text-xs font-mono select-none">{">"}</span>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  placeholder="Ask anything..."
                  disabled={loading}
                  className="flex-1 bg-transparent text-xs font-mono text-text-primary placeholder:text-text-muted outline-none disabled:opacity-50"
                />
                <button
                  onClick={() => submit()}
                  disabled={loading || !input.trim()}
                  className="text-neon/70 hover:text-neon disabled:opacity-30 transition-colors"
                >
                  <Send className="size-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
