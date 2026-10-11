# BNB Hack: Tokenized Stocks Edition

Source: [bnbchain.org/en/hackathons/tokenized-stocks](https://www.bnbchain.org/en/hackathons/tokenized-stocks?tab=overview)

This is **not** the bStock AI-Powered PnL Contest (17 Aug – 1 Sep 2026). Judges do not score realized PnL. They score a working tokenized-stock product, how deeply it uses the Binance Web3 stack, and a written developer-experience report.

**Submissions lock Sunday 11 Oct 2026, 12:00 UTC.** Judging runs 12–23 Oct. Winners are announced the week of 26 Oct. The repo, demo, and deployed link must stay up through judging.

Prize pool: **$20,000**, funded by BNB Chain and Binance Web3 Wallet.

| Placement | Prize |
| --- | --- |
| 1st | $6,000 |
| 2nd | $4,000 |
| 3rd | $3,000 |
| 4th | $2,000 |
| 5th | $1,000 |
| Best Use of Agentic Wallet / Wallet Skills | $2,000 |
| Best Use of BNB Agent Studio | $2,000 |

A project can win a placement and a special. Specials are awarded across every submission. There is no separate entry.

Restricted regions (do not register from these): United States, Canada, the Netherlands, Iran, Cuba, North Korea, Crimea, Donetsk People's Republic, Luhansk People's Republic, the United Kingdom, and Japan.

## Track rules

One track: **Tokenized Stocks Products & Agents**. Build something people would use with tokenized stocks on BSC. Agents are expected. A deck is not a submission.

- At least one of **bStocks**, **Ondo**, or **xStocks** must be central.
- Cross-asset products are allowed (equity plus crypto or stablecoins).
- **Spot only.** Perps are out.
- **BSC mainnet only.** Dry-run while building, then demo with a small live amount. Teams fund their own wallets.

## What judges score

| Criterion | Weight |
| --- | --- |
| Technical implementation | 30% |
| Creativity and originality | 25% |
| Developer Experience Report | 25% |
| Product quality and UX | 20% |

The report is required. Perfunctory or AI-generated reports are rejected. AI-assisted code is allowed.

## What to submit

1. A working project on one or more [Binance Web3 API](https://web3.binance.com/en/dev-docs/introduction) modules. Agentic Wallet and Wallet Skills are optional and heavily weighted.
2. A public repository.
3. A deployed link, or instructions a judge can follow.
4. A demo video, four minutes or less. Strongly recommended, optional.
5. The [Developer Experience Report](https://forms.gle/EUQ39xf54GHjC2ys5).

Forms:

- Register: https://forms.gle/NEmy3FxYc4f5Dua47
- Submit the project: https://forms.gle/yToDUzaDMwWnq6R6A
- Developer Experience Report: https://forms.gle/EUQ39xf54GHjC2ys5
- API key (developer portal): https://web3.binance.com/en/dev-portal
- Builder Telegram: https://t.me/+MhiOLT0YUnlmNWFk

The report has to cover, with specific pages and error text:

- Time from docs to the first successful API call, and where onboarding stuck.
- Documentation errors, with the page and the location on the page.
- API pitfalls: bad errors, edge cases, latency.
- AI stack: Wallet Skills, Agentic Wallet, or the CLI. What worked, what did not, what is missing.
- Tokenized-stock behavior: liquidity, slippage, hours when the underlying market is closed, on-chain price versus reference price, and how bStocks, Ondo, and xStocks differ.
- How you would rebuild the developer platform.
- Endpoints, SDKs, or tools you want added.

## Stack they want

| Module | Role |
| --- | --- |
| RWA Data API | Token lists, on-chain price vs reference, ticker search, company profile, market status, sector filters |
| Market API | Prices, candles, token analytics |
| Trading API | Aggregated quotes, swaps, approvals, MEV protection |
| Transaction API | Simulate, then broadcast |
| Wallet API | Balances, positions, portfolio |
| DeFi API | TVL, APY, deposit/redeem/LP calldata |
| b402 Payments | Pay-per-call between agents |
| Agentic Wallet / Wallet Skills | AI execution layer. Special prize |
| BNB Agent Studio | Persistent agent: wallet, ERC-8004 identity, ERC-8183 tasks, managed runtime, x402. Special prize |

## Neural Alpha against those rules

Repo: https://github.com/ClipXonchain/neural-alpha

Public surfaces already in the project: https://neuralalpha.io and https://agents.clipx.app

| Requirement | Status | What exists |
| --- | --- | --- |
| bStocks central, spot, BSC mainnet | Ready | type=3 bStock universe, `baw market-order swap` on chainId 56. No perps. Ondo and xStocks are excluded on purpose. |
| Working agent, not a deck | Ready | `neural-alpha/` scores, checks risk, and routes swaps. `dashboard/` is the live monitor. `/about` is a public overview with fixed sample figures. |
| Public repo a judge can open | Ready if the GitHub repo stays public through 23 Oct | Deploy docs point at `ClipXonchain/neural-alpha`. Confirm the default branch a judge will clone still builds. |
| Deployed link through judging | Ready if the VPS stays up through 23 Oct | `neuralalpha.io` is the public site. The agent API is localhost-only behind that dashboard. |
| Agentic Wallet / Wallet Skills | Strong | `baw` quotes, and Developer Mode `contract-call` broadcasts the simulated Trading API calldata. `market-order swap` is the fallback when Developer Mode is off. x402 payments still go through `baw`. |
| Agent Studio | Research leg | A closed-market buy can call `STUDIO_AGENT_URL`. Until that URL is set, the paid job at `https://stock-agent.bnbchain.org/x402/analyze/async` is the research input. Studio's own wallet is not the bStock signer. |
| Binance Web3 API modules (signed REST) | In the live path when `OC_API_KEY` is set | RWA hours and spread, Market candles, Trading quote and calldata, Transaction simulate, Wallet portfolio read, DeFi APY read. |
| RWA on-chain vs reference price | In the gate | `marketStatus` allows or blocks. A spread of 1.5% or more vetoes a rich buy. `referencePrice` is the API's per-share conversion, not an NYSE quote. |
| Small live mainnet demo | Ready to send | Live mode caps a closed-market buy at `HACKATHON_MAX_TRADE_USD` (default $15). `npm run hackathon:check` never sends a swap. A fill still needs `baw auth signin` and Developer Mode. |
| Hackathon registration form | Not in the repo | The old PnL-contest Join Now flow is a different form. Register at the hackathon Google Form if that has not been done. |
| Project submission form | Not done | https://forms.gle/yToDUzaDMwWnq6R6A |
| Developer Experience Report | Not done | 25% of the score. Write it from real integration notes. Do not generate it. |
| Demo video (≤ 4 min) | Not in the repo | Optional, and worth doing if there is time. |

## Checklist

Work for this event lives on the `hackathon` branch.

| Step | Who | Status |
| --- | --- | --- |
| bStock spot agent on BSC, public site, public repo | Code | Done. Site `https://neuralalpha.io`. Repo `https://github.com/ClipXonchain/neural-alpha`. |
| Signed RWA Data client (hours, profile, sector list, on-chain vs reference) | Code | Done. The live book uses it when keys are set. |
| Market candles, Trading quote, Wallet read, DeFi APY | Code | Done in `neural-alpha/src/integrations/binance-web3-signed.ts`. |
| Transaction simulate, then one broadcast | Code | Simulate runs before send. `baw contract-call execute` broadcasts that call when Developer Mode is on. REST broadcast runs only if a raw `signedTransaction` exists. |
| Closed-market size cap | Code | $8–$15 unless the operator sets an explicit amount. Pause and a rich spread block the buy. |
| `baw` signed in, Developer Mode on, one small live swap | You | The check never sends a swap. |
| Signature includes the `/build` prefix | Code | Done, with a unit test. The docs call a missing prefix the usual `40102`. |
| API key in the environment | You | Create a project at the [developer portal](https://web3.binance.com/en/dev-portal/project). Put `OC_API_KEY` and `OC_SECRET_KEY` in `.env`. Do not commit them. |
| `baw` signed in, and one small live swap you can show | You | The check prints the session. It does not send a swap. Sign in with `baw auth signin` if it says not logged in, then place a small bStock swap from the agent. |
| Register | You | https://forms.gle/NEmy3FxYc4f5Dua47 |
| Submit the project | You | https://forms.gle/yToDUzaDMwWnq6R6A — repo, branch `hackathon`, site `https://neuralalpha.io` |
| Developer Experience Report | You | https://forms.gle/EUQ39xf54GHjC2ys5 — write it from your own notes. A generated report is rejected. Facts worth using are below. |
| Demo video, 4 minutes or less | You | Optional. |
| Keep the repo and site up through 23 Oct | You | Required. |

Run the machine-check from `neural-alpha/`:

```bash
npm run hackathon:check
```

## Facts for the report you write

These are from the official docs and from this codebase. Rewrite them in your own words before you file the form.

- Public bStock quotes already work without a developer key, from `https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=3`. That is not the signed RWA Data API.
- The signed API base is `https://web3.binance.com/build`. The signature string is `timestamp + METHOD + /build/api/v1/... + body`. Leaving `/build` out of the signed path returns `40102 Invalid signature`. Auth page: https://web3.binance.com/en/dev-docs/authentication
- RWA price is `GET /api/v1/dex/market/rwa/price` with `binanceChainId` and `tokenContractAddresses`. The docs define `referencePrice` as a per-share conversion of the on-chain token price, not an official stock-market quote.
- Transaction simulation is `POST /api/v1/dex/pre-transaction/simulate`. When the Trading API returns EVM calldata, that call is simulated and then `baw contract-call` broadcasts it. `market-order swap` runs only when Developer Mode is off or the route is RFQ with no calldata. REST `broadcast` needs a raw signed transaction, which the CLI does not return.
- Agentic Wallet is a separate login (`baw auth signin`). A Web3 API key does not sign the CLI in. Developer Mode is enabled in the Binance app.
- Agent Studio research is `STUDIO_AGENT_URL` when set, otherwise `https://stock-agent.bnbchain.org/x402/analyze/async`. That research wallet does not hold the bStock inventory.

## Verdict

The code on `hackathon` puts the signed book in front of a live BSC send. Submission still needs a signed-in `baw` session, Developer Mode, one small fill, and the three forms.
