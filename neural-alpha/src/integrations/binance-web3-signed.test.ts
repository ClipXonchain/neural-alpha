import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { buildPreHash, signPreHash } from "./binance-web3-signed.js";

test("signed path keeps the /build prefix in the pre-hash", () => {
  const timestamp = "2026-05-11T10:08:57.715Z";
  const path = "/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT";
  const preHash = buildPreHash(timestamp, "get", path, "");
  assert.equal(
    preHash,
    "2026-05-11T10:08:57.715ZGET/build/api/v1/dex/market/price?chainId=1&symbol=ETH%20USDT"
  );
  assert.equal(preHash.includes("/build/api/"), true);
});

test("HMAC signature is base64 and changes with the secret", () => {
  const preHash = buildPreHash("2026-05-11T10:08:57.715Z", "GET", "/build/api/v1/dex/market/rwa/tokens", "");
  const first = signPreHash(preHash, "secret-a");
  const second = signPreHash(preHash, "secret-b");
  const expected = createHmac("sha256", "secret-a").update(preHash, "utf8").digest("base64");
  assert.equal(first, expected);
  assert.notEqual(first, second);
});
