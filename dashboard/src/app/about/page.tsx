import type { Metadata } from "next";
import { SystemExperience } from "@/components/marketing/SystemExperience";

export const metadata: Metadata = {
  title: "Neural Alpha — About",
  description:
    "Neural Alpha placed first in BNB Hack Track 1, then shows how the desk reads eligible bStocks, checks risk, and routes orders through Binance Agentic Wallet.",
};

export default function AboutPage() {
  return <SystemExperience />;
}
