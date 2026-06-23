"use client";

import { useState } from "react";

/** Hostnames that always render as monitoring-only (no agent controls). */
const PUBLIC_DASHBOARD_HOSTS = new Set(["agents.clipx.app"]);

export function isPublicDashboardHost(hostname: string): boolean {
  return PUBLIC_DASHBOARD_HOSTS.has(hostname.toLowerCase());
}

/**
 * True on public deployments (agents.clipx.app) or when NEXT_PUBLIC_READONLY=true.
 * Hostname is checked on first client render so production builds work even if the
 * env var was missing at `next build` time.
 */
export function useReadOnly(): boolean {
  const [readOnly] = useState(() => {
    if (process.env.NEXT_PUBLIC_READONLY === "true") return true;
    if (typeof window !== "undefined") {
      return isPublicDashboardHost(window.location.hostname);
    }
    return false;
  });
  return readOnly;
}
