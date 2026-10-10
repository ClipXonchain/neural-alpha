import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BSC_USDT_ADDRESS } from "../config.js";
import { dedupeWalletPositions, fetchWalletPositions } from "./binance-web3-wallet.js";

const ADDRESS = "0xc571161563A6586622b8a701b0dDd31250A5088c";

function row(symbol: string, contract: string, qty = 1, price = 10) {
  return {
    chainId: "56",
    address: ADDRESS,
    contractAddress: contract,
    symbol,
    decimals: 18,
    price,
    percentChange24h: 0,
    remainQty: qty,
  };
}

describe("wallet position dedupe", () => {
  const original = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original;
  });

  it("keeps one row per contract", () => {
    const usdt = {
      symbol: "USDT",
      contractAddress: BSC_USDT_ADDRESS,
      chainId: "56",
      remainQty: 476.81,
      price: 1,
      valueUsd: 476.81,
    };
    const copies = Array.from({ length: 11 }, () => ({ ...usdt }));
    const unique = dedupeWalletPositions(copies);
    assert.equal(unique.length, 1);
    assert.equal(unique[0]?.remainQty, 476.81);
  });

  it("stops when Binance repeats the first page instead of summing it", async () => {
    let calls = 0;
    const page = [
      row("USDT", BSC_USDT_ADDRESS, 476.81, 1),
      row("BNB", "", 0.0001, 700),
      ...Array.from({ length: 48 }, (_, i) =>
        row(`SPAM${i}`, `0x${(i + 1).toString(16).padStart(40, "0")}`, 1, 1)
      ),
    ];
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ success: true, data: { list: page } }),
      };
    }) as typeof fetch;

    const positions = await fetchWalletPositions(ADDRESS);
    assert.equal(calls, 2);
    assert.equal(positions.filter((p) => p.symbol === "USDT").length, 1);
    const nav = positions.reduce((sum, p) => sum + p.remainQty * p.price, 0);
    assert.ok(nav < 1000, `nav should be the real wallet, got ${nav}`);
  });
});
