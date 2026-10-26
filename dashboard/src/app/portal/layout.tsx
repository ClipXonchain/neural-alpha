import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Neural Alpha",
  description: "Pay the software fee and open your agent",
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
