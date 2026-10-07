"use client";

import type { CSSProperties } from "react";

type ShinyTextProps = {
  text: string;
  speed?: number;
  delay?: number;
  color?: string;
  shineColor?: string;
  spread?: number;
  direction?: "left" | "right";
  yoyo?: boolean;
  pauseOnHover?: boolean;
  disabled?: boolean;
  className?: string;
};

export default function ShinyText({
  text,
  speed = 3.1,
  delay = 0,
  color = "#ff7b0b",
  shineColor = "#00ff37",
  spread = 65,
  direction = "left",
  yoyo = false,
  pauseOnHover = false,
  disabled = false,
  className,
}: ShinyTextProps) {
  const style = {
    "--shiny-speed": `${speed}s`,
    "--shiny-delay": `${delay}s`,
    "--shiny-color": color,
    "--shiny-shine": shineColor,
    "--shiny-spread": `${spread}%`,
    animationDirection: yoyo ? "alternate" : direction === "left" ? "normal" : "reverse",
  } as CSSProperties;

  return (
    <span
      className={["shiny-text", pauseOnHover ? "shiny-pause" : "", disabled ? "is-disabled" : "", className].filter(Boolean).join(" ")}
      style={style}
    >
      {text}
    </span>
  );
}
