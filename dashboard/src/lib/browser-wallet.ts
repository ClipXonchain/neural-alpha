/**
 * The browser wallet (MetaMask, Trust, Binance's in-app browser, ...) is used for exactly two things:
 *
 *  1. proving who you are, by signing a plain text message (login, linking a login wallet), and
 *  2. sending the one subscription payment the customer clicked "Pay with wallet" for.
 *
 * It never asks for a spending approval, never trades, and never sees the Binance Agentic Wallet.
 */
type Eth = { request(args: { method: string; params?: unknown[] | object }): Promise<unknown> };

const BSC = {
  chainId: "0x38",
  chainName: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: ["https://bsc-dataseed.binance.org"],
  blockExplorerUrls: ["https://bscscan.com"],
};

export const NO_WALLET = "No browser wallet found. Open this page in your wallet's browser, or install a wallet extension.";

export function getEthereum(): Eth | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { ethereum?: Eth }).ethereum ?? null;
}

export function shortAddress(address: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Wallets reject with { code: 4001 } when the person says no; that is not an error worth shouting about. */
export function walletErrorMessage(err: unknown, fallback: string) {
  const e = err as { code?: number; message?: string } | null;
  if (e?.code === 4001) return "You declined in your wallet. Nothing was sent.";
  return e?.message && !/^\[object/.test(e.message) ? e.message : fallback;
}

export async function connectAccount(eth: Eth): Promise<string> {
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account || !/^0x[a-fA-F0-9]{40}$/.test(account)) throw new Error("No wallet account was selected.");
  return account.toLowerCase();
}

export async function signMessage(eth: Eth, account: string, message: string): Promise<string> {
  const signature = await eth.request({ method: "personal_sign", params: [message, account] });
  if (typeof signature !== "string") throw new Error("The wallet did not return a signature.");
  return signature;
}

async function ensureBsc(eth: Eth) {
  const current = await eth.request({ method: "eth_chainId" }).catch(() => null);
  if (typeof current === "string" && current.toLowerCase() === BSC.chainId) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC.chainId }] });
  } catch (err) {
    if ((err as { code?: number })?.code !== 4902) throw err; // 4902: this wallet has not added BSC yet
    await eth.request({ method: "wallet_addEthereumChain", params: [BSC] });
  }
}

const ADDR = /^0x[a-fA-F0-9]{40}$/;

/** ERC-20 transfer(to, amount): selector, then two 32-byte words. */
export function transferData(to: string, amountWei: string) {
  if (!ADDR.test(to)) throw new Error("The treasury address is invalid.");
  const amount = BigInt(amountWei);
  if (amount <= BigInt(0)) throw new Error("The amount is invalid.");
  return `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

export type PaymentOrder = { asset: string; tokenContract: string; treasuryAddress: string; amountWei: string };

/** Sends the exact quoted amount to the treasury and returns the transaction hash. */
export async function sendPayment(eth: Eth, from: string, order: PaymentOrder): Promise<string> {
  if (!ADDR.test(order.treasuryAddress)) throw new Error("The treasury address is invalid.");
  await ensureBsc(eth);
  const tx =
    order.asset === "BNB"
      ? { from, to: order.treasuryAddress, value: `0x${BigInt(order.amountWei).toString(16)}` }
      : { from, to: order.tokenContract, data: transferData(order.treasuryAddress, order.amountWei) };
  if (order.asset !== "BNB" && !ADDR.test(order.tokenContract)) throw new Error("The token contract is invalid.");
  const hash = await eth.request({ method: "eth_sendTransaction", params: [tx] });
  if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("The wallet did not return a transaction hash.");
  return hash.toLowerCase();
}
