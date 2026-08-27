"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

export interface BorderGlowProps {
  children?: ReactNode;
  className?: string;
  /** How close the pointer must be to the edge for the glow (0–100). */
  edgeSensitivity?: number;
  /** HSL channels as `"H S L"`, e.g. `"154 82 58"`. */
  glowColor?: string;
  backgroundColor?: string;
  borderRadius?: number;
  glowRadius?: number;
  glowIntensity?: number;
  /** Width of the directional cone mask (5–45). */
  coneSpread?: number;
  /** Play an intro sweep on mount. */
  animated?: boolean;
  /** Delay the intro sweep (ms). */
  animationDelay?: number;
  /** Three hex colors for the mesh gradient border. */
  colors?: string[];
  fillOpacity?: number;
}

type GlowStyle = CSSProperties & {
  "--cursor-angle": string;
  "--border-opacity": string;
  "--glow-opacity": string;
  "--fill-opacity": string;
};

function parseHSL(hslStr: string): { h: number; s: number; l: number } {
  const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
  if (!match) return { h: 154, s: 82, l: 58 };
  return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
}

function buildBoxShadow(glowColor: string, intensity: number): string {
  const { h, s, l } = parseHSL(glowColor);
  const base = `${h}deg ${s}% ${l}%`;
  const layers: [number, number, number, number, number, boolean][] = [
    [0, 0, 0, 1, 100, true],
    [0, 0, 1, 0, 60, true],
    [0, 0, 3, 0, 50, true],
    [0, 0, 6, 0, 40, true],
    [0, 0, 15, 0, 30, true],
    [0, 0, 25, 2, 20, true],
    [0, 0, 50, 2, 10, true],
    [0, 0, 1, 0, 60, false],
    [0, 0, 3, 0, 50, false],
    [0, 0, 6, 0, 40, false],
    [0, 0, 15, 0, 30, false],
    [0, 0, 25, 2, 20, false],
    [0, 0, 50, 2, 10, false],
  ];
  return layers
    .map(([x, y, blur, spread, alpha, inset]) => {
      const a = Math.min(alpha * intensity, 100);
      return `${inset ? "inset " : ""}${x}px ${y}px ${blur}px ${spread}px hsl(${base} / ${a}%)`;
    })
    .join(", ");
}

function easeOutCubic(x: number) {
  return 1 - Math.pow(1 - x, 3);
}
function easeInCubic(x: number) {
  return x * x * x;
}

interface AnimateOpts {
  start?: number;
  end?: number;
  duration?: number;
  delay?: number;
  ease?: (t: number) => number;
  onUpdate: (v: number) => void;
  onEnd?: () => void;
}

function animateValue({
  start = 0,
  end = 100,
  duration = 1000,
  delay = 0,
  ease = easeOutCubic,
  onUpdate,
  onEnd,
}: AnimateOpts) {
  let raf = 0;
  let timeout = 0;
  let cancelled = false;

  const tick = (t0: number) => {
    if (cancelled) return;
    const t = Math.min((performance.now() - t0) / duration, 1);
    onUpdate(start + (end - start) * ease(t));
    if (t < 1) raf = requestAnimationFrame(() => tick(t0));
    else onEnd?.();
  };

  timeout = window.setTimeout(() => {
    raf = requestAnimationFrame(() => tick(performance.now()));
  }, delay);

  return () => {
    cancelled = true;
    clearTimeout(timeout);
    cancelAnimationFrame(raf);
  };
}

const GRADIENT_POSITIONS = [
  "80% 55%",
  "69% 34%",
  "8% 6%",
  "41% 38%",
  "86% 85%",
  "82% 18%",
  "51% 4%",
];
const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

function buildMeshGradients(colors: string[]): string[] {
  const gradients: string[] = [];
  for (let i = 0; i < 7; i++) {
    const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
    gradients.push(`radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`);
  }
  gradients.push(`linear-gradient(${colors[0]} 0 100%)`);
  return gradients;
}

function getEdgeProximity(width: number, height: number, x: number, y: number) {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  let kx = Infinity;
  let ky = Infinity;
  if (dx !== 0) kx = cx / Math.abs(dx);
  if (dy !== 0) ky = cy / Math.abs(dy);
  return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
}

function getCursorAngle(width: number, height: number, x: number, y: number) {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return 0;
  let degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
  if (degrees < 0) degrees += 360;
  return degrees;
}

export function BorderGlow({
  children,
  className = "",
  edgeSensitivity = 30,
  glowColor = "154 82 58",
  backgroundColor = "#0e1013",
  borderRadius = 12,
  glowRadius = 32,
  glowIntensity = 1,
  coneSpread = 22,
  animated = false,
  animationDelay = 0,
  colors = ["#0ecb81", "#1e9ff2", "#f0b90b"],
  fillOpacity = 0.5,
}: BorderGlowProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const pointerRef = useRef({ clientX: 0, clientY: 0 });
  const pointerRafRef = useRef<number | null>(null);
  const hoveredRef = useRef(false);
  const sweepRef = useRef(false);

  const colorSensitivity = edgeSensitivity + 20;

  const writeAngle = useCallback((angle: number) => {
    cardRef.current?.style.setProperty("--cursor-angle", `${angle.toFixed(3)}deg`);
  }, []);

  const writeProximity = useCallback(
    (edge: number) => {
      const card = cardRef.current;
      if (!card) return;
      const edgePct = edge * 100;
      const borderOpacity = Math.max(
        0,
        (edgePct - colorSensitivity) / (100 - colorSensitivity)
      );
      const glowOpacity = Math.max(
        0,
        (edgePct - edgeSensitivity) / (100 - edgeSensitivity)
      );
      card.style.setProperty("--border-opacity", borderOpacity.toFixed(3));
      card.style.setProperty("--glow-opacity", glowOpacity.toFixed(3));
    },
    [colorSensitivity, edgeSensitivity]
  );

  const writeGlow = useCallback(
    (edge: number, angle: number) => {
      writeAngle(angle);
      writeProximity(edge);
    },
    [writeAngle, writeProximity]
  );

  const cacheRect = useCallback(() => {
    if (!cardRef.current) return;
    rectRef.current = cardRef.current.getBoundingClientRect();
  }, []);

  const updatePointerGlow = useCallback(() => {
    pointerRafRef.current = null;
    const card = cardRef.current;
    const rect = rectRef.current;
    if (!card || !rect) return;
    const x = pointerRef.current.clientX - rect.left;
    const y = pointerRef.current.clientY - rect.top;
    writeGlow(getEdgeProximity(rect.width, rect.height, x, y), getCursorAngle(rect.width, rect.height, x, y));
  }, [writeGlow]);

  const handlePointerEnter = useCallback(() => {
    hoveredRef.current = true;
    cacheRect();
  }, [cacheRect]);

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!rectRef.current) cacheRect();
      pointerRef.current.clientX = e.clientX;
      pointerRef.current.clientY = e.clientY;
      if (pointerRafRef.current === null) {
        pointerRafRef.current = requestAnimationFrame(updatePointerGlow);
      }
    },
    [cacheRect, updatePointerGlow]
  );

  const handlePointerLeave = useCallback(() => {
    hoveredRef.current = false;
    rectRef.current = null;
    if (pointerRafRef.current !== null) {
      cancelAnimationFrame(pointerRafRef.current);
      pointerRafRef.current = null;
    }
    if (!sweepRef.current) writeGlow(0, 45);
  }, [writeGlow]);

  useEffect(() => {
    const onResize = () => {
      if (hoveredRef.current) cacheRect();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [cacheRect]);

  useEffect(() => {
    return () => {
      if (pointerRafRef.current !== null) cancelAnimationFrame(pointerRafRef.current);
    };
  }, []);

  useEffect(() => {
    if (!animated) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const angleStart = 110;
    const angleEnd = 465;
    sweepRef.current = true;
    writeGlow(0, angleStart);

    const cancels = [
      animateValue({
        delay: animationDelay,
        duration: 500,
        onUpdate: (v) => writeProximity(v / 100),
      }),
      animateValue({
        ease: easeInCubic,
        delay: animationDelay,
        duration: 1500,
        end: 50,
        onUpdate: (v) => writeAngle((angleEnd - angleStart) * (v / 100) + angleStart),
      }),
      animateValue({
        ease: easeOutCubic,
        delay: animationDelay + 1500,
        duration: 2250,
        start: 50,
        end: 100,
        onUpdate: (v) => writeAngle((angleEnd - angleStart) * (v / 100) + angleStart),
      }),
      animateValue({
        ease: easeInCubic,
        delay: animationDelay + 2500,
        duration: 1500,
        start: 100,
        end: 0,
        onUpdate: (v) => {
          if (hoveredRef.current) return;
          writeProximity(v / 100);
        },
        onEnd: () => {
          sweepRef.current = false;
          if (!hoveredRef.current) writeGlow(0, 45);
        },
      }),
    ];

    return () => {
      sweepRef.current = false;
      cancels.forEach((c) => c());
    };
  }, [animated, animationDelay, writeAngle, writeGlow, writeProximity]);

  const meshGradients = useMemo(() => buildMeshGradients(colors), [colors]);
  const borderBg = useMemo(
    () => meshGradients.map((g) => `${g} border-box`).join(", "),
    [meshGradients]
  );
  const fillBg = useMemo(
    () => meshGradients.map((g) => `${g} padding-box`).join(", "),
    [meshGradients]
  );
  const glowShadow = useMemo(
    () => buildBoxShadow(glowColor, glowIntensity),
    [glowColor, glowIntensity]
  );

  const coneFade = coneSpread + 15;
  const coneEnd = 100 - coneSpread;
  const coneFadeEnd = 100 - coneSpread - 15;

  const borderMask = `conic-gradient(from var(--cursor-angle) at 50% 50%, #000 ${coneSpread}%, transparent ${coneFade}%, transparent ${coneFadeEnd}%, #000 ${coneEnd}%)`;
  const fillMask = [
    "linear-gradient(to bottom, #000, #000)",
    "radial-gradient(ellipse at 50% 50%, #000 40%, transparent 65%)",
    "radial-gradient(ellipse at 0% 0%, #000 18%, transparent 52%)",
    "radial-gradient(ellipse at 100% 0%, #000 18%, transparent 52%)",
    "radial-gradient(ellipse at 100% 100%, #000 18%, transparent 52%)",
    "radial-gradient(ellipse at 0% 100%, #000 18%, transparent 52%)",
    "conic-gradient(from var(--cursor-angle) at 50% 50%, transparent 5%, #000 15%, #000 85%, transparent 95%)",
  ].join(", ");
  const glowMask = `conic-gradient(from var(--cursor-angle) at 50% 50%, #000 ${coneSpread}%, transparent ${coneSpread + 20}%, transparent ${80 - coneSpread}%, #000 ${100 - coneSpread}%)`;

  return (
    <div
      ref={cardRef}
      onPointerEnter={handlePointerEnter}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={cn(
        "relative isolate overflow-hidden border border-border-dim hover:z-20",
        className
      )}
      style={
        {
          background: backgroundColor,
          borderRadius: `${borderRadius}px`,
          transform: "translate3d(0, 0, 0.01px)",
          "--cursor-angle": "45deg",
          "--border-opacity": "0",
          "--glow-opacity": "0",
          "--fill-opacity": String(fillOpacity),
        } as GlowStyle
      }
    >
      {/* Mesh gradient border — cone follows the pointer, clipped to this card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit]"
        style={{
          border: "1.5px solid transparent",
          background: `linear-gradient(${backgroundColor} 0 100%) padding-box, ${borderBg}`,
          opacity: "var(--border-opacity)",
          WebkitMaskImage: borderMask,
          maskImage: borderMask,
        }}
      />

      {/* Soft edge fill, also clipped inside the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] rounded-[inherit]"
        style={{
          background: fillBg,
          opacity: "calc(var(--border-opacity) * var(--fill-opacity))",
          mixBlendMode: "soft-light",
          WebkitMaskImage: fillMask,
          maskImage: fillMask,
          WebkitMaskComposite: "source-out, source-over, source-over, source-over, source-over, source-over",
          maskComposite: "subtract, add, add, add, add, add",
        }}
      />

      {glowRadius > 0 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
        >
          <div
            style={{
              position: "absolute",
              inset: `-${Math.min(glowRadius, 8)}px`,
              borderRadius: `calc(${borderRadius}px + ${Math.min(glowRadius, 8)}px)`,
              boxShadow: glowShadow,
              opacity: "var(--glow-opacity)",
              WebkitMaskImage: glowMask,
              maskImage: glowMask,
            }}
          />
        </div>
      )}

      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}
