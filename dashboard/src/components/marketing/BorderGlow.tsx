"use client";

import { useCallback, useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useReducedMotion } from "framer-motion";
import "./BorderGlow.css";

export type BorderGlowProps = {
  children?: ReactNode;
  className?: string;
  edgeSensitivity?: number;
  glowColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  coneSpread?: number;
  animated?: boolean;
  colors?: string[];
  fillOpacity?: number;
};

type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 40, s: 80, l: 80 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildGlowVars(glowColor: string, intensity: number): Record<string, string> {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const opacities = [100, 60, 50, 40, 30, 20, 10];
  const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
  const vars: Record<string, string> = {};
  for (let i = 0; i < opacities.length; i++) {
    vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
  }
  return vars;
}

const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
const GRADIENT_KEYS = ["--gradient-one", "--gradient-two", "--gradient-three", "--gradient-four", "--gradient-five", "--gradient-six", "--gradient-seven"];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildGradientVars(colors: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`;
  }
  vars["--gradient-base"] = `linear-gradient(${colors[0]} 0 100%)`;
  return vars;
}

const ORBIT_MS = 7000;

export default function BorderGlow({
  children,
  className = "",
  edgeSensitivity = 30,
  glowColor = "40 80 80",
  backgroundColor = "#120F17",
  borderRadius = 28,
  glowRadius = 40,
  glowIntensity = 1,
  coneSpread = 25,
  animated = false,
  colors = ["#c084fc", "#f472b6", "#38bdf8"],
  fillOpacity = 0.5,
}: BorderGlowProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const steerUntil = useRef(0);
  const reduce = useReducedMotion() === true;

  const writeFromPoint = useCallback((clientX: number, clientY: number) => {
    const card = cardRef.current;
    if (!card || reduce) return;
    const rect = card.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let kx = Infinity;
    let ky = Infinity;
    if (dx !== 0) kx = cx / Math.abs(dx);
    if (dy !== 0) ky = cy / Math.abs(dy);
    const edge = Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    let angle = 0;
    if (dx !== 0 || dy !== 0) {
      angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
      if (angle < 0) angle += 360;
    }
    card.style.setProperty("--edge-proximity", (edge * 100).toFixed(3));
    card.style.setProperty("--cursor-angle", `${angle.toFixed(3)}deg`);
    steerUntil.current = performance.now() + 180;
  }, [reduce]);

  const handlePointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    writeFromPoint(event.clientX, event.clientY);
  }, [writeFromPoint]);

  const handlePointerLeave = useCallback(() => {
    if (reduce) return;
    steerUntil.current = 0;
    cardRef.current?.style.setProperty("--edge-proximity", animated ? "100" : "0");
  }, [animated, reduce]);

  useEffect(() => {
    if (!animated || reduce) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const card = cardRef.current;
    if (!card) return;
    card.classList.add("border-glow-orbit");
    card.style.setProperty("--edge-proximity", "100");

    let frame = 0;
    const tick = (now: number) => {
      if (now >= steerUntil.current) {
        const angle = ((now % ORBIT_MS) / ORBIT_MS) * 360;
        card.style.setProperty("--cursor-angle", `${angle.toFixed(3)}deg`);
        card.style.setProperty("--edge-proximity", "100");
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      card.classList.remove("border-glow-orbit");
    };
  }, [animated, reduce]);

  const classes = ["border-glow-card", reduce ? "border-glow-static" : "", className].filter(Boolean).join(" ");
  const style: CssVarStyle = {
    "--card-bg": backgroundColor,
    "--edge-sensitivity": edgeSensitivity,
    "--border-radius": `${borderRadius}px`,
    "--glow-padding": `${glowRadius}px`,
    "--cone-spread": coneSpread,
    "--fill-opacity": fillOpacity,
    ...buildGlowVars(glowColor, glowIntensity),
    ...buildGradientVars(colors),
  };

  return (
    <div
      ref={cardRef}
      onPointerEnter={handlePointer}
      onPointerMove={handlePointer}
      onPointerDown={handlePointer}
      onPointerLeave={handlePointerLeave}
      className={classes}
      style={style}
    >
      <span className="edge-light" aria-hidden="true" />
      <span className="edge-cone" aria-hidden="true">
        <span className="edge-ring" />
      </span>
      <div className="border-glow-inner">{children}</div>
    </div>
  );
}
