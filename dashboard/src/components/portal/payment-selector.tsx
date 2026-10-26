"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";

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
  icons?: Record<string, string>;
};

const list = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06 } },
};

const item = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] as const } },
};

export function AssetLogo({ asset, src }: { asset: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full bg-[#101214]">
        <img src={src} alt="" width={32} height={32} className="h-8 w-8 object-cover" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[11px] font-medium text-[#c5d0d4]" aria-hidden="true">
      {asset.slice(0, 1)}
    </span>
  );
}

/** Payment list adapted from the 21st.dev Payment selector. Brand colors, no card chrome. */
export function PaymentMethodSelector({ label, methods, selectedId, onSelectionChange, layout = "stack", icons }: PaymentMethodSelectorProps) {
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
              {row ? <AssetLogo asset={method.id} src={icons?.[method.id]} /> : null}
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[#f1f5f9] sm:text-[14px]">{method.label}</span>
                {method.detail ? (
                  <span className="mt-0.5 block truncate font-mono text-[10px] leading-tight text-[#8ea0a6]">{method.detail}</span>
                ) : null}
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
