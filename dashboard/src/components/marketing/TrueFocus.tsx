"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";

type TrueFocusProps = {
  sentence: string;
  manualMode?: boolean;
  blurAmount?: number;
  borderColor?: string;
  animationDuration?: number;
  pauseBetweenAnimations?: number;
};

export default function TrueFocus({
  sentence,
  manualMode = false,
  blurAmount = 2,
  borderColor = "#ea4eff",
  animationDuration = 0.5,
  pauseBetweenAnimations = 1,
}: TrueFocusProps) {
  const words = sentence.split(" ").filter(Boolean);
  const reduce = useReducedMotion();
  const containerRef = useRef<HTMLSpanElement>(null);
  const wordRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const measure = useCallback(() => {
    const parent = containerRef.current;
    const word = wordRefs.current[index];
    if (!parent || !word) return;
    const parentBox = parent.getBoundingClientRect();
    const wordBox = word.getBoundingClientRect();
    setRect({
      x: wordBox.left - parentBox.left,
      y: wordBox.top - parentBox.top,
      width: wordBox.width,
      height: wordBox.height,
    });
  }, [index]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (reduce || manualMode || words.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % words.length);
    }, (animationDuration + pauseBetweenAnimations) * 1000);
    return () => window.clearInterval(timer);
  }, [reduce, manualMode, words.length, animationDuration, pauseBetweenAnimations]);

  return (
    <span className="true-focus" ref={containerRef} style={{ "--focus-border": borderColor } as CSSProperties}>
      {words.map((word, wordIndex) => {
        const active = Boolean(reduce) || wordIndex === index;
        return (
          <span
            key={`${word}-${wordIndex}`}
            ref={(node) => { wordRefs.current[wordIndex] = node; }}
            className="true-focus-word"
            style={{
              filter: active ? "none" : `blur(${blurAmount}px)`,
              opacity: active ? 1 : 0.55,
              transition: `filter ${animationDuration}s ease, opacity ${animationDuration}s ease`,
            }}
            onMouseEnter={() => { if (manualMode) setIndex(wordIndex); }}
          >
            {word}
          </span>
        );
      })}
      {!reduce && (
        <motion.span
          className="true-focus-frame"
          animate={{ x: rect.x, y: rect.y, width: rect.width, height: rect.height, opacity: rect.width ? 1 : 0 }}
          transition={{ duration: animationDuration, ease: [0.22, 0.7, 0.3, 1] }}
        >
          <span className="true-focus-corner tl" />
          <span className="true-focus-corner tr" />
          <span className="true-focus-corner bl" />
          <span className="true-focus-corner br" />
        </motion.span>
      )}
    </span>
  );
}
