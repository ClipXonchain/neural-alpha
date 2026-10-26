"use client";

import { AnimatePresence, motion } from "framer-motion";
import Image from "next/image";

export type PayChoice = {
  id: string;
  label: string;
  detail?: string;
};

type PaymentMethodSelectorProps = {
  label: string;
  methods: PayChoice[];
  selectedId: string;
  onSelectionChange: (id: string) => void;
  layout?: "stack" | "row";
};

const list = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as const } },
};

export function AssetLogo({ asset }: { asset: string }) {
  if (asset === "BNB") {
    return <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#f3ba2f]/10"><Image src="/brand/bnb-chain/BNB-Chain-Symbol-Yellow.svg" alt="" width={19} height={19} /></span>;
  }
  const colors: Record<string, string> = { USDT: "#26a17b", USDC: "#2775ca", U: "#7658df", USD1: "#31798a" };
  const color = colors[asset] || "#728087";
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full" style={{ background: `${color}20`, color }} aria-hidden="true">
      <svg viewBox="0 0 32 32" className="h-6 w-6" fill="none">
        <circle cx="16" cy="16" r="15" fill={color} />
        {asset === "USDT" ? <><path d="M7 8h18M16 8v16M10 12h12c2.2 0 3.5.8 3.5 2s-1.3 2-3.5 2h-6" stroke="white" strokeWidth="2.2" strokeLinecap="round"/><path d="M16 16v7" stroke="white" strokeWidth="2.2" strokeLinecap="round"/></> : null}
        {asset === "USDC" ? <><path d="M20.6 10.2a7 7 0 1 0 0 11.6M22.3 13.2a4 4 0 1 0 0 5.6" stroke="white" strokeWidth="2.2" strokeLinecap="round"/><path d="M16 9v14" stroke="white" strokeWidth="1.7" strokeLinecap="round"/></> : null}
        {asset === "U" ? <path d="M10 9v8a6 6 0 0 0 12 0V9" stroke="white" strokeWidth="3" strokeLinecap="round"/> : null}
        {asset === "USD1" ? <><path d="M21 11.5c-1.1-1-2.8-1.5-4.8-1.5-2.6 0-4.3 1-4.3 2.7 0 4.4 9.3 1.8 9.3 6.5 0 1.8-1.8 3-4.8 3-2.1 0-4-.6-5.4-1.8" stroke="white" strokeWidth="1.9" strokeLinecap="round"/><path d="M16 7.5v17" stroke="white" strokeWidth="1.5" strokeLinecap="round"/></> : null}
      </svg>
    </span>
  );
}

/** Payment list adapted from the 21st.dev Payment selector. Brand colors, no card chrome. */
export function PaymentMethodSelector({ label, methods, selectedId, onSelectionChange, layout = "stack" }: PaymentMethodSelectorProps) {
  const row = layout === "row";
  return (
    <div>
      <p className="mb-3 text-[13px] text-[#7e8a97]">{label}</p>
      <motion.div className={row ? "grid grid-cols-2 gap-2 sm:grid-cols-5" : "grid gap-2"} variants={list} initial="hidden" animate="visible" role="radiogroup" aria-label={label}>
        {methods.map((method) => {
          const on = selectedId === method.id;
          return (
            <motion.button
              key={method.id}
              type="button"
              variants={item}
              onClick={() => onSelectionChange(method.id)}
              className={row ? "flex min-h-16 w-full items-center gap-2 rounded-xl border px-2 py-3 text-left transition hover:border-white/20 sm:gap-2.5 sm:px-3" : "flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-left transition hover:border-white/20"}
              style={{
                borderColor: on ? "#12b264" : "rgba(255,255,255,0.08)",
                background: on ? "#0c1c14" : "#101214",
              }}
              role="radio"
              aria-checked={on}
            >
              {row ? <AssetLogo asset={method.id} /> : null}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[#f1f5f9] sm:text-[14px]">{method.label}</span>
                {method.detail ? <span className="mt-0.5 block font-mono text-[10px] text-[#7e8a97] sm:text-[11px]">{method.detail}</span> : null}
              </span>
              {row ? null : <span
                className="grid h-5 w-5 place-items-center rounded-full border"
                style={{ borderColor: on ? "#12b264" : "rgba(255,255,255,0.16)" }}
              >
                <AnimatePresence>
                  {on ? (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      exit={{ scale: 0 }}
                      className="h-2.5 w-2.5 rounded-full bg-[#12b264]"
                    />
                  ) : null}
                </AnimatePresence>
              </span>}
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
