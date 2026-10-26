import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Neural Alpha · Server Overview",
  description: "Read-only global SaaS fleet and book monitoring desk",
  robots: { index: false, follow: false },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
