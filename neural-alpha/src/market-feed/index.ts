/**
 * Entry: shared market-data feed (one CMC/Binance Web3 trending poll → all agents).
 *   npm run market-feed --workspace=neural-alpha
 *   MARKET_FEED_URL=http://127.0.0.1:4100
 */
import "../load-env.js";
import { startMarketFeedServer } from "./server.js";

startMarketFeedServer();
