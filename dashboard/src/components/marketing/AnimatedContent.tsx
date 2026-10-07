"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";

export type AnimatedContentProps = {
  children: ReactNode;
  className?: string;
  distance?: number;
  direction?: "vertical" | "horizontal";
  reverse?: boolean;
  duration?: number;
  ease?: string;
  initialOpacity?: number;
  animateOpacity?: boolean;
  scale?: number;
  threshold?: number;
  delay?: number;
};

const layoutStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  maxWidth: "100%",
};

function resolveEase(ease: string): [number, number, number, number] {
  if (ease === "power3.out") return [0.22, 1, 0.36, 1];
  const match = ease.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
  if (!match) return [0.22, 1, 0.36, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

export default function AnimatedContent({
  children,
  className,
  distance = 100,
  direction = "vertical",
  reverse = false,
  duration = 0.8,
  ease = "power3.out",
  initialOpacity = 0,
  animateOpacity = true,
  scale = 1,
  threshold = 0.1,
  delay = 0,
}: AnimatedContentProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion() === true;
  const inView = useInView(ref, { once: true, amount: threshold });
  const [sharp, setSharp] = useState(false);
  const done = reduce || sharp;
  const classes = ["animated-content", done ? "paint-sharp" : "", className].filter(Boolean).join(" ");

  if (reduce) {
    return (
      <div ref={ref} className={classes} style={layoutStyle}>
        {children}
      </div>
    );
  }

  const offset = reverse ? -distance : distance;
  const hidden: { opacity: number; x?: number; y?: number; scale?: number } = {
    opacity: animateOpacity ? initialOpacity : 1,
  };
  if (direction === "horizontal") hidden.x = offset;
  else hidden.y = offset;
  if (scale !== 1) hidden.scale = scale;
  const shown = done ? { opacity: 1 } : { x: 0, y: 0, opacity: 1, ...(scale !== 1 ? { scale: 1 } : {}) };

  return (
    <motion.div
      ref={ref}
      className={classes}
      style={layoutStyle}
      initial={done ? false : hidden}
      animate={inView ? shown : hidden}
      transition={{ duration: done ? 0 : duration, delay: done ? 0 : delay, ease: resolveEase(ease) }}
      onAnimationComplete={() => {
        const node = ref.current;
        if (!inView) return;
        if (node && Number(getComputedStyle(node).opacity) < 0.99) return;
        setSharp(true);
      }}
    >
      {children}
    </motion.div>
  );
}
