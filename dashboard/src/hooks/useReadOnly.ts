"use client";

import { useEffect, useState } from "react";

/** Hostnames that always render as monitoring-only (no agent controls). */
const PUBLIC_DASHBOARD_HOSTS = new Set([
  "neuralalpha.io",
  "www.neuralalpha.io",
  "agents.clipx.app",
]);

export function isPublicDashboardHost(hostname: string): boolean {
  return PUBLIC_DASHBOARD_HOSTS.has(hostname.toLowerCase());
}

function isLocalOperatorHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * True on public deployments (neuralalpha.io) or when NEXT_PUBLIC_READONLY=true.
 * Localhost stays an operator UI even if that flag is copied from the public .env,
 * matching the API proxy (mutations are allowed from 127.0.0.1).
 * Hostname is checked on first client render so production builds work even if the
 * env var was missing at `next build` time.
 */
export function useReadOnly(): boolean {
  const envLocked = process.env.NEXT_PUBLIC_READONLY === "true";
  const [readOnly, setReadOnly] = useState(envLocked);

  useEffect(() => {
    const host = window.location.hostname;
    if (isLocalOperatorHost(host)) {
      setReadOnly(false);
      return;
    }
    setReadOnly(envLocked || isPublicDashboardHost(host));
  }, [envLocked]);

  return readOnly;
}
