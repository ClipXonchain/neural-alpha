"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";

type SplitOffset = { opacity?: number; y?: number | string; x?: number | string };
type SplitKind = "chars" | "words" | "lines";

export type SplitTextProps = {
  text: string;
  className?: string;
  delay?: number;
  duration?: number;
  ease?: string;
  splitType?: SplitKind;
  from?: SplitOffset;
  to?: SplitOffset;
  threshold?: number;
  rootMargin?: string;
  textAlign?: CSSProperties["textAlign"];
  onLetterAnimationComplete?: () => void;
  tag?: "p" | "span" | "h1" | "h2" | "h3" | "div";
  /** Phrase that keeps its own element, so an existing emphasis class still applies. */
  emphasis?: { text: string; className: string };
};

function resolveEase(ease: string): [number, number, number, number] {
  if (ease === "power3.out") return [0.22, 1, 0.36, 1];
  const match = ease.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  if (!match) return [0.22, 1, 0.36, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function wordsOf(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function findSequence(words: string[], target: string[]) {
  if (!target.length || target.length > words.length) return -1;
  for (let index = 0; index <= words.length - target.length; index += 1) {
    if (target.every((word, offset) => words[index + offset] === word)) return index;
  }
  return -1;
}

type Unit = { key: string; text: string; index: number; gap: boolean };
type Group = { className?: string; units: Unit[] };

function buildGroups(text: string, splitType: SplitKind, emphasis?: { text: string; className: string }): Group[] {
  if (splitType === "lines") {
    const lines = text.split(/\n/);
    return [{
      units: lines.map((line, index) => ({ key: `line-${index}`, text: line, index, gap: false })),
    }];
  }

  const words = wordsOf(text);
  const target = emphasis ? wordsOf(emphasis.text) : [];
  const start = findSequence(words, target);
  const slices: { words: string[]; className?: string }[] = [];
  if (start < 0) slices.push({ words });
  else {
    if (start > 0) slices.push({ words: words.slice(0, start) });
    slices.push({ words: words.slice(start, start + target.length), className: emphasis?.className });
    if (start + target.length < words.length) slices.push({ words: words.slice(start + target.length) });
  }

  let index = 0;
  return slices.map((slice) => {
    const units: Unit[] = [];
    slice.words.forEach((word, wordIndex) => {
      const parts = splitType === "chars" ? Array.from(word) : [word];
      parts.forEach((part, partIndex) => {
        const lastInWord = partIndex === parts.length - 1;
        const lastWord = wordIndex === slice.words.length - 1;
        units.push({
          key: `${index}-${part}`,
          text: part,
          index,
          gap: lastInWord && !lastWord,
        });
        index += 1;
      });
    });
    return { className: slice.className, units };
  });
}

const srOnly: CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

export default function SplitText({
  text,
  className,
  delay = 50,
  duration = 1.25,
  ease = "power3.out",
  splitType = "chars",
  from = { opacity: 0, y: 40 },
  to = { opacity: 1, y: 0 },
  threshold = 0.1,
  rootMargin = "-100px",
  textAlign = "center",
  onLetterAnimationComplete,
  tag = "p",
  emphasis,
}: SplitTextProps) {
  const reduce = useReducedMotion() === true;
  const rootRef = useRef<HTMLElement | null>(null);
  const setRoot = useCallback((node: HTMLElement | null) => {
    rootRef.current = node;
  }, []);
  const emphasisRef = useRef<HTMLElement | null>(null);
  const finished = useRef(false);
  const [inView, setInView] = useState(false);
  const groups = buildGroups(text, splitType, emphasis);
  const lastIndex = groups.reduce((count, group) => count + group.units.length, 0) - 1;
  const show = reduce || inView;

  useEffect(() => {
    if (reduce) return;
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, reduce]);

  useEffect(() => {
    if (!reduce || !onLetterAnimationComplete || finished.current) return;
    finished.current = true;
    onLetterAnimationComplete();
  }, [reduce, onLetterAnimationComplete]);

  useLayoutEffect(() => {
    const root = emphasisRef.current;
    if (!root) return;
    const apply = () => {
      const parent = root.getBoundingClientRect();
      root.querySelectorAll<HTMLElement>(".split-word").forEach((word) => {
        const inner = word.querySelector<HTMLElement>(".split-word-inner");
        if (!inner) return;
        const box = word.getBoundingClientRect();
        inner.style.setProperty("--split-line", `${parent.width}px`);
        inner.style.setProperty("--split-x", `${-(box.left - parent.left)}px`);
      });
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    return () => observer.disconnect();
  }, [text, splitType, emphasis?.text, emphasis?.className]);

  const finish = (index: number) => {
    if (index !== lastIndex || finished.current || !onLetterAnimationComplete) return;
    finished.current = true;
    onLetterAnimationComplete();
  };

  const visual = groups.map((group) => {
    const words = group.units.map((unit) => (
      <span
        key={unit.key}
        className="split-word"
        style={{
          display: "inline-block",
          overflow: "hidden",
          verticalAlign: "bottom",
          marginRight: unit.gap ? "0.28em" : 0,
        }}
      >
        <motion.span
          className="split-word-inner"
          style={{ display: "inline-block" }}
          initial={reduce ? to : from}
          animate={show ? to : from}
          transition={reduce ? { duration: 0 } : { duration, delay: (unit.index * delay) / 1000, ease: resolveEase(ease) }}
          onAnimationComplete={() => finish(unit.index)}
        >
          {unit.text}
        </motion.span>
      </span>
    ));
    if (group.className) {
      return (
        <em key={group.className} className={group.className} aria-hidden="true" ref={emphasisRef}>
          {words}
        </em>
      );
    }
    return (
      <span key={group.units[0]?.key ?? "run"} aria-hidden="true">
        {words}
      </span>
    );
  });

  const body = (
    <>
      <span style={srOnly}>{text}</span>
      {visual}
    </>
  );
  const style: CSSProperties = { textAlign, position: "relative" };
  if (tag === "span") return <span ref={setRoot} className={className} style={style}>{body}</span>;
  if (tag === "h1") return <h1 ref={setRoot} className={className} style={style}>{body}</h1>;
  if (tag === "h2") return <h2 ref={setRoot} className={className} style={style}>{body}</h2>;
  if (tag === "h3") return <h3 ref={setRoot} className={className} style={style}>{body}</h3>;
  if (tag === "div") return <div ref={setRoot} className={className} style={style}>{body}</div>;
  return <p ref={setRoot} className={className} style={style}>{body}</p>;
}
