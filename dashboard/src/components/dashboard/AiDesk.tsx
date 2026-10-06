"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { Bot, FileText, Loader2, RefreshCw, Send } from "lucide-react";
import {
  askAssistant,
  fetchDailyReviews,
  fetchLlmStatus,
  runDailyReview,
  type DailyReview,
  type LlmStatus,
} from "@/lib/agent-api";
import { timeAgo } from "@/lib/utils";

const SUGGESTIONS = [
  "Why is today's P&L what it is?",
  "Which position is closest to its stop-loss?",
  "How did my closed trades do this week?",
  "What did the last Agent Studio report say?",
];

interface Turn {
  question: string;
  answer?: string;
  error?: string;
}

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
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);

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

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || asking) return;
    setQuestion("");
    setAsking(true);
    setTurns((t) => [...t, { question: text }]);
    try {
      const r = await askAssistant(text);
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, answer: r.answer } : turn)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTurns((t) => t.map((turn, i) => (i === t.length - 1 ? { ...turn, error: msg } : turn)));
    } finally {
      setAsking(false);
    }
  };

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

  return (
    <div className="ai-desk">
      {!readOnly && (
        <div className="panel ai-panel">
          <div className="section-header">
            <h2><Bot size={15} /> Ask the agent</h2>
            {status?.reasoningModel && <span className="ai-model">{status.reasoningModel}</span>}
          </div>
          {status && !enabled ? (
            <NotConfigured />
          ) : (
            <>
              <div className="ai-thread">
                {turns.length === 0 && (
                  <div className="ai-suggestions">
                    <p>Read-only: answers come from the agent&apos;s live books, trades, transfers and logs. It can&apos;t trade.</p>
                    {SUGGESTIONS.map((s) => (
                      <button key={s} className="ai-chip" onClick={() => void ask(s)} disabled={asking}>{s}</button>
                    ))}
                  </div>
                )}
                {turns.map((t, i) => (
                  <div key={i} className="ai-turn">
                    <div className="ai-q">{t.question}</div>
                    {t.answer && <MiniMarkdown text={t.answer} />}
                    {t.error && <div className="ai-error">{t.error}</div>}
                    {!t.answer && !t.error && <div className="ai-wait"><Loader2 size={13} className="spin" /> Thinking…</div>}
                  </div>
                ))}
              </div>
              <form
                className="ai-input"
                onSubmit={(e) => {
                  e.preventDefault();
                  void ask(question);
                }}
              >
                <input
                  value={question}
                  maxLength={500}
                  placeholder="Ask about trades, P&L, positions, rules…"
                  onChange={(e) => setQuestion(e.target.value)}
                  disabled={asking}
                />
                <button type="submit" disabled={asking || !question.trim()} aria-label="Ask">
                  {asking ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                </button>
              </form>
            </>
          )}
        </div>
      )}

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
            <MiniMarkdown text={review.text} />
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
