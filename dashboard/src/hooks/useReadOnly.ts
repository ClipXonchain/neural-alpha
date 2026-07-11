"use client";

import { useState, useEffect } from "react";

/**
 * Read-only when:
 * - Explicit forcePublic (public viewer)
 * - Logged-in user is NOT the agent owner (isOwner === false)
 * - Global NEXT_PUBLIC_READONLY=true AND ownership is unknown/not owner
 *
 * Owners always get full controls, even if a public-monitor env flag is set.
 */
export function useReadOnly(opts?: {
  isOwner?: boolean | null;
  forcePublic?: boolean;
}): boolean {
  const [envReadonly] = useState(() => {
    return process.env.NEXT_PUBLIC_READONLY === "true";
  });

  if (opts?.forcePublic) return true;
  // Confirmed owner → always full control
  if (opts?.isOwner === true) return false;
  // Confirmed non-owner → monitoring only
  if (opts?.isOwner === false) return true;
  // Ownership unknown — fall back to global public-monitor flag
  return envReadonly;
}

export function useAuthWallet() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/siwe")
      .then((r) => r.json())
      .then((d: { loggedIn?: boolean; wallet?: string }) => {
        if (!cancelled) {
          setWallet(d.loggedIn && d.wallet ? d.wallet : null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWallet(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = async () => {
    await fetch("/api/auth/siwe", { method: "DELETE" });
    setWallet(null);
  };

  return { wallet, loading, logout, setWallet };
}
