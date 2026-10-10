"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { FileText, Loader2, RefreshCw } from "lucide-react";
import {
  fetchDailyReviews,
  fetchLlmStatus,
  runDailyReview,
  type DailyReview,
  type LlmStatus,
} from "@/lib/agent-api";
import { timeAgo } from "@/lib/utils";

const REVIEW_SECTIONS = ["Result", "Trades", "What worked / what didn't", "Rule check", "Watch tomorrow"] as const;

/** Bold, bullets and paragraphs only — the model is told to answer in short Markdown. */
function MiniMarkdown({ text }: { text: string }) {
  const inline = (line: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>
    );

  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}
      </ul>
    );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }
    flush();
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(heading ? <h4 key={blocks.length}>{inline(heading[1])}</h4> : <p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="ai-md">{blocks}</div>;
}

function reviewTitle(label: string): (typeof REVIEW_SECTIONS)[number] | string {
  const key = label.toLowerCase().replace(/\s+/g, " ").trim();
  return REVIEW_SECTIONS.find((section) => section.toLowerCase() === key) ?? label;
}

/** The model often writes every heading in one paragraph. Split those labels into sections. */
function parseReview(text: string): { title: string; body: string }[] {
  const pattern = /\*{0,2}(Result|Trades|What worked\s*\/\s*what didn't|Rule check|Watch tomorrow)\*{0,2}\s*[—–:-]\s*/gi;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return [];
  return matches.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
    const body = text
      .slice(start, end)
      .replace(/\s+(?=\d+[.)]\s)/g, "\n")
      .replace(/\s+(?=[-*•]\s)/g, "\n")
      .trim();
    return body ? [{ title: reviewTitle(match[1]), body }] : [];
  });
}

function NotConfigured() {
  return (
    <div className="ai-empty">
      No language model is configured. Set <code>OPENAI_API_KEY</code> (and optionally <code>OPENAI_BASE_URL</code> /{" "}
      <code>OPENAI_MODEL</code>) in the agent&apos;s <code>.env</code>, then restart the agent.
    </div>
  );
}

export function AiDesk({ readOnly }: { readOnly?: boolean }) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [reviews, setReviews] = useState<DailyReview[]>([]);
  const [selected, setSelected] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadReviews = useCallback(async () => {
    try {
      const r = await fetchDailyReviews();
      setReviews(r.reviews);
    } catch {
      /* agent offline: keep whatever is shown */
    }
  }, []);

  useEffect(() => {
    fetchLlmStatus().then(setStatus).catch(() => setStatus(null));
    void loadReviews();
  }, [loadReviews]);

  const enabled = status?.enabled ?? false;

  const writeReview = async () => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await runDailyReview();
      await loadReviews();
      setSelected(0);
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };

  const review = reviews[selected];
  const sections = review ? parseReview(review.text) : [];

  return (
    <div className="ai-desk">
      <div className="panel ai-panel">
        <div className="section-header">
          <h2><FileText size={15} /> Daily review</h2>
          {!readOnly && enabled && (
            <button className="ghost-button" onClick={() => void writeReview()} disabled={reviewBusy}>
              {reviewBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              {reviewBusy ? "Writing…" : "Review today so far"}
            </button>
          )}
        </div>
        {reviews.length > 0 && (
          <div className="ai-days">
            {reviews.slice(0, 10).map((r, i) => (
              <button key={r.day} className={`ai-chip${i === selected ? " active" : ""}`} onClick={() => setSelected(i)}>
                {r.day.slice(5)}{r.partial ? " · so far" : ""}
              </button>
            ))}
          </div>
        )}
        {reviewError && <div className="ai-error">{reviewError}</div>}
        {review ? (
          <div className="ai-review">
            {sections.length > 0 ? (
              <div className="review-sections">
                {sections.map((section) => (
                  <section className="review-section" key={section.title}>
                    <h3>{section.title}</h3>
                    <MiniMarkdown text={section.body} />
                  </section>
                ))}
              </div>
            ) : (
              <MiniMarkdown text={review.text} />
            )}
            <div className="ai-meta">
              {review.model} · written {timeAgo(review.generatedAt)}
              {review.partial ? " · day was still in progress" : ""}
            </div>
          </div>
        ) : status && !enabled && !readOnly ? (
          <NotConfigured />
        ) : (
          <div className="ai-empty">
            No reviews yet. The agent writes one automatically shortly after each UTC midnight
            {readOnly ? "." : ", or write one for today now."}
          </div>
        )}
      </div>
    </div>
  );
}
