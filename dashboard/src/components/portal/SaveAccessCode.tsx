"use client";

import { Check, Copy, Download } from "lucide-react";

/** Shows the access code once, lets the customer keep it, and gates "continue" until they say they did. */
export function SaveAccessCode({
  code,
  saved,
  onSaved,
  onCopy,
}: {
  code: string;
  saved: boolean;
  onSaved: (value: boolean) => void;
  onCopy: (value: string) => void;
}) {
  function download() {
    const blob = new Blob(
      [`Neural Alpha access code\n\n${code}\n\nKeep this somewhere safe. It opens your agent from any browser.\nLost it? Sign in with a linked wallet, or make a new one from Settings while signed in.\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neural-alpha-access-code.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="mx-6 mb-2 rounded-xl border border-[#18cf7a]/25 bg-[#18cf7a]/[0.05] px-4 py-4 sm:mx-9">
      <p className="text-[10px] uppercase tracking-[.16em] text-[#42da99]">Your access code</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="font-mono text-xl tracking-[.14em] text-[#edf5f0]">{code}</p>
        <button type="button" aria-label="Copy access code" className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 text-[#42da99] hover:bg-white/[0.05]" onClick={() => onCopy(code)}>
          <Copy size={14} />
        </button>
        <button type="button" className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-[#c2cdd1] hover:bg-white/[0.05]" onClick={download}>
          <Download size={13} /> Download
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-[#8e9d98]">
        This is shown once. It opens your agent from any browser. Paid from an exchange? Link a login wallet in Settings so you can always get back in.
      </p>
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs text-[#cbd7d0]">
        <input type="checkbox" className="peer sr-only" checked={saved} onChange={(e) => onSaved(e.target.checked)} />
        <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border border-white/25 peer-checked:border-[#18cf7a] peer-checked:bg-[#18cf7a] peer-focus-visible:ring-2 peer-focus-visible:ring-white/40">
          {saved ? <Check size={11} className="text-[#00160d]" strokeWidth={3.5} /> : null}
        </span>
        <span>I saved my access code somewhere safe.</span>
      </label>
    </div>
  );
}
