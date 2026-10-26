"use client";

import { cn } from "@/lib/utils";
import { motion, useMotionValueEvent, useSpring, useTransform, type SpringOptions } from "framer-motion";
import { useEffect, useState } from "react";

type AnimatedNumberProps = {
  value: number;
  className?: string;
  springOptions?: SpringOptions;
};

/** Spring counter adapted from the 21st.dev Animated Number component. */
export function AnimatedNumber({ value, className, springOptions }: AnimatedNumberProps) {
  const spring = useSpring(value, { bounce: 0, duration: 900, ...springOptions });
  const display = useTransform(spring, (current) => Math.round(current).toLocaleString("en-US"));
  const [text, setText] = useState(() => Math.round(value).toLocaleString("en-US"));

  useMotionValueEvent(display, "change", (latest) => setText(String(latest)));

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  return <motion.span className={cn("tabular-nums", className)}>{text}</motion.span>;
}
