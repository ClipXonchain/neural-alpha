import { test } from "node:test";
import assert from "node:assert/strict";
import { excerptFromReport } from "./research-store.js";

test("single-ticker report: excerpt is the report head", () => {
  const text = "# NVDA outlook\nStrong data-center demand.";
  assert.equal(excerptFromReport({ tickers: ["NVDA"], text }, "NVDAB"), text);
});

test("multi-ticker JSON report: excerpt is only that stock's section", () => {
  const text = JSON.stringify({
    results: [
      { symbol: "AAPL", rating: "hold", summary: "iPhone cycle flat" },
      { symbol: "TSLA", rating: "sell", summary: "Margins compressing" },
    ],
  });
  const out = excerptFromReport({ tickers: ["AAPL", "TSLA"], text }, "TSLAB")!;
  assert.match(out, /Margins compressing/);
  assert.doesNotMatch(out, /iPhone/);
});

test("multi-ticker Markdown report: excerpt keeps paragraphs naming the ticker", () => {
  const text = "## AAPL\nServices growth steady.\n\n## MSFT\nAzure re-accelerating.";
  const out = excerptFromReport({ tickers: ["AAPL", "MSFT"], text }, "MSFTB")!;
  assert.match(out, /Azure/);
  assert.doesNotMatch(out, /Services/);
});
