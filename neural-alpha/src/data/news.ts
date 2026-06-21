import { logger } from "../utils/logger.js";

const CLIPX_NEWS_URL =
  process.env.CLIPX_NEWS_URL || "https://clipx.app/api/news/feed";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  source: string;
  sourceFeed?: string;
  publishedAt: string;
  project?: string;
}

interface ClipXFeedResponse {
  items?: NewsItem[];
  topPicks?: NewsItem[];
  trending?: NewsItem[];
}

let cachedItems: NewsItem[] = [];
let cacheFetchedAt = 0;

function normalizeItem(raw: Record<string, unknown>): NewsItem | null {
  const title = String(raw.title || "").trim();
  if (!title) return null;

  return {
    id: String(raw.id || `${raw.sourceFeed || "news"}-${Date.now()}-${Math.random()}`),
    title,
    summary: String(raw.summary || "").trim(),
    url: String(raw.url || ""),
    source: String(raw.source || "Unknown"),
    sourceFeed: raw.sourceFeed ? String(raw.sourceFeed) : undefined,
    publishedAt: String(raw.publishedAt || new Date().toISOString()),
    project: raw.project ? String(raw.project) : undefined,
  };
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = item.id || item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Fetch crypto news from ClipX API with 5-minute in-memory cache.
 */
export async function fetchNewsFeed(limit = 30): Promise<NewsItem[]> {
  const now = Date.now();
  if (cachedItems.length > 0 && now - cacheFetchedAt < CACHE_TTL_MS) {
    return cachedItems;
  }

  const url = `${CLIPX_NEWS_URL}?limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`ClipX news HTTP ${res.status}`);
    }

    const body = (await res.json()) as ClipXFeedResponse;
    const merged: NewsItem[] = [];

    for (const bucket of [body.items, body.topPicks, body.trending]) {
      if (!Array.isArray(bucket)) continue;
      for (const raw of bucket) {
        const item = normalizeItem(raw as unknown as Record<string, unknown>);
        if (item) merged.push(item);
      }
    }

    cachedItems = dedupeNews(merged).sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );
    cacheFetchedAt = now;

    logger.info("News feed fetched (ClipX)", { count: cachedItems.length });
    return cachedItems;
  } catch (err) {
    logger.warn("Failed to fetch ClipX news feed", { error: String(err) });
    if (cachedItems.length > 0) {
      logger.info("Using stale news cache", { count: cachedItems.length });
      return cachedItems;
    }
    return [];
  }
}

/** Clear cache (for tests). */
export function clearNewsCache() {
  cachedItems = [];
  cacheFetchedAt = 0;
}
