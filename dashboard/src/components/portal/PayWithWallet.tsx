"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, Wallet } from "lucide-react";
import { connectAccount, getEthereum, NO_WALLET, sendPayment, shortAddress, signMessage, walletErrorMessage } from "@/lib/browser-wallet";

type PayOrder = {
  asset: string;
  amountDisplay: string;
  amountWei: string;
  tokenContract: string;
  treasuryAddress: string;
  paymentTx: string | null;
  status: string;
};

async function json(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error === "string" ? data.error : "Request failed");
  return data;
}

/**
 * Pays the quoted subscription fee straight from a browser wallet. The portal's usual watcher
 * confirms it by itself; if that is slow, one signature from the same wallet confirms it now.
 */
export function PayWithWallet({ order, expired, onVerified }: { order: PayOrder; expired: boolean; onVerified: (data: Record<string, unknown>) => void | Promise<void> }) {
  const [busy, setBusy] = useState<"" | "pay" | "confirm">("");
  const [hash, setHash] = useState(order.paymentTx || "");
  const [account, setAccount] = useState("");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  async function pay() {
    setNote(null);
    const eth = getEthereum();
    if (!eth) return setNote({ text: NO_WALLET, ok: false });
    setBusy("pay");
    try {
      const from = await connectAccount(eth);
      setAccount(from);
      const tx = await sendPayment(eth, from, order);
      setHash(tx);
      setNote({ text: "Payment sent. It needs about a minute of confirmations; this page will open your agent by itself.", ok: true });
    } catch (err) {
      setNote({ text: walletErrorMessage(err, "The payment was not sent."), ok: false });
    } finally {
      setBusy("");
    }
  }

  async function confirm() {
    setNote(null);
    const eth = getEthereum();
    if (!eth || !hash) return;
    setBusy("confirm");
    try {
      const from = account || (await connectAccount(eth));
      const challenge = await json(
        await fetch("/api/portal/challenge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "payment", paymentTx: hash }),
        }),
      );
      const signature = await signMessage(eth, from, String(challenge.message));
      const data = await json(
        await fetch("/api/portal/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paymentTx: hash, signature }),
        }),
      );
      setNote({ text: "Confirmed. Opening your agent…", ok: true });
      // The server clears the order cookie once this succeeds, so the page's own poll cannot take over.
      await onVerified(data);
    } catch (err) {
      setNote({ text: walletErrorMessage(err, "Could not confirm yet. Try again in a few seconds."), ok: false });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-5 rounded-xl border border-[#3b9eff]/25 bg-[#3b9eff]/[0.05] p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-[#e4eef7]">
        <Wallet size={15} className="text-[#61b0ff]" /> Pay with your browser wallet
      </p>
      <p className="mt-1.5 text-xs leading-5 text-[#9fb2c0]">
        Sends exactly <span className="font-mono text-[#cfe3f2]">{order.amountDisplay} {order.asset}</span> to the treasury on BNB Smart Chain.
        We never ask for a token approval, and this wallet is only used for this payment and for signing in.
      </p>
      {hash ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a
            href={`https://bscscan.com/tx/${hash}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-[#61b0ff] underline-offset-2 hover:underline"
          >
            {shortAddress(hash.slice(0, 42))}… on BscScan
          </a>
          <button
            type="button"
            onClick={confirm}
            disabled={busy === "confirm"}
            className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-xs text-[#c2cdd1] transition hover:bg-white/[0.06] disabled:opacity-50"
          >
            {busy === "confirm" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Confirm now with a signature
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={pay}
          disabled={busy === "pay" || expired || order.status !== "pending"}
          className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#3b9eff,#2467c9)] px-5 text-sm font-semibold text-white transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
        >
          {busy === "pay" ? <Loader2 size={15} className="animate-spin" /> : <Wallet size={15} />}
          {busy === "pay" ? "Check your wallet…" : "Pay with wallet"}
        </button>
      )}
      {note && (
        <p role="status" className={`mt-3 text-xs leading-5 ${note.ok ? "text-[#42da99]" : "text-[#ff8e97]"}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}
