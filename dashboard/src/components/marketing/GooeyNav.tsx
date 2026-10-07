"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { motion } from "framer-motion";
import "./GooeyNav.css";

export type GooeyNavItem = {
  label: string;
  href: string;
};

export type GooeyNavProps = {
  items: GooeyNavItem[];
  particleCount?: number;
  particleDistances?: [number, number];
  particleR?: number;
  initialActiveIndex?: number;
  animationTime?: number;
  timeVariance?: number;
  colors?: number[];
  ariaLabel?: string;
};

const PALETTE = ["#3ddc97", "#12b264", "#61b0ff", "#ea4eff"] as const;

type Rect = { left: number; top: number; width: number; height: number };

type BlobState = {
  left: number | number[];
  top: number | number[];
  width: number | number[];
  height: number | number[];
  duration: number;
};

type Particle = {
  id: number;
  cx: number;
  cy: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  time: number;
  scale: number;
  color: string;
  rotate: number;
};

type CssVarStyle = CSSProperties & Record<`--${string}`, string | number>;

function noise(amount = 1) {
  return amount / 2 - Math.random() * amount;
}

function colorFor(index: number) {
  const slot = Math.trunc(index) - 1;
  if (!Number.isFinite(slot) || slot < 0 || slot >= PALETTE.length) return PALETTE[0];
  return PALETTE[slot];
}

function pointOnRing(distance: number, pointIndex: number, totalPoints: number) {
  const angle = ((360 + noise(8)) / totalPoints) * pointIndex * (Math.PI / 180);
  return [distance * Math.cos(angle), distance * Math.sin(angle)] as const;
}

function createParticle(
  index: number,
  time: number,
  distances: [number, number],
  radius: number,
  colors: number[],
  total: number,
) {
  const rotate = noise(radius / 10);
  const start = pointOnRing(distances[0], total - index, total);
  const end = pointOnRing(distances[1] + noise(7), total - index, total);
  const colorIndex = colors[Math.floor(Math.random() * colors.length)] ?? 1;
  return {
    startX: start[0],
    startY: start[1],
    endX: end[0],
    endY: end[1],
    time,
    scale: 1 + noise(0.2),
    color: colorFor(colorIndex),
    rotate: rotate > 0 ? (rotate + radius / 20) * 10 : (rotate - radius / 20) * 10,
  };
}

function snapBlob(rect: Rect): BlobState {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, duration: 0 };
}

function stretchBlob(from: Rect, to: Rect, animationTime: number): BlobState {
  const left = Math.min(from.left, to.left);
  const top = Math.min(from.top, to.top);
  return {
    left: [from.left, left, to.left],
    top: [from.top, top, to.top],
    width: [from.width, Math.max(from.left + from.width, to.left + to.width) - left, to.width],
    height: [from.height, Math.max(from.top + from.height, to.top + to.height) - top, to.height],
    duration: animationTime / 1000,
  };
}

export default function GooeyNav({
  items,
  particleCount = 15,
  particleDistances = [90, 10],
  particleR = 100,
  initialActiveIndex = 0,
  animationTime = 600,
  timeVariance = 300,
  colors = [1, 2, 3, 1, 2, 3, 1, 4],
  ariaLabel = "Hero",
}: GooeyNavProps) {
  const rawId = useId();
  const filterId = `gooey-nav-${rawId.replace(/:/g, "")}`;
  const rootRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);
  const activeRef = useRef(initialActiveIndex);
  const animatingRef = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const particleTimers = useRef<number[]>([]);
  const particleIds = useRef(0);
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const [blob, setBlob] = useState<BlobState | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);

  const measure = (index: number): Rect | null => {
    const root = rootRef.current;
    const item = itemRefs.current[index];
    if (!root || !item) return null;
    const rootBox = root.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    return {
      left: box.left - rootBox.left,
      top: box.top - rootBox.top,
      width: box.width,
      height: box.height,
    };
  };

  const clearParticleTimers = () => {
    particleTimers.current.forEach((id) => window.clearTimeout(id));
    particleTimers.current = [];
  };

  const prefersReducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const snap = () => {
      if (animatingRef.current) return;
      const next = measure(activeRef.current);
      if (next) setBlob(snapBlob(next));
    };

    snap();
    const observer = new ResizeObserver(snap);
    observer.observe(root);
    return () => observer.disconnect();
  }, [items]);

  useEffect(() => {
    return () => {
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
      particleTimers.current.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const spawnParticles = (from: Rect) => {
    clearParticleTimers();
    const total = Math.max(particleCount, 1);
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    const created: Particle[] = [];
    for (let index = 0; index < particleCount; index += 1) {
      const time = Math.max(180, animationTime * 2 + noise(timeVariance * 2));
      created.push({
        id: particleIds.current++,
        cx,
        cy,
        ...createParticle(index, time, particleDistances, particleR, colors, total),
      });
    }
    const show = window.setTimeout(() => setParticles(created), 30);
    const maxTime = created.reduce((longest, particle) => Math.max(longest, particle.time), 0);
    const hide = window.setTimeout(() => setParticles([]), 30 + maxTime + 40);
    particleTimers.current.push(show, hide);
  };

  const onSelect = (event: MouseEvent<HTMLAnchorElement>, index: number) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (index === activeRef.current) return;

    const from = measure(activeRef.current);
    activeRef.current = index;
    setActiveIndex(index);
    const to = measure(index);
    if (!to) return;

    if (prefersReducedMotion() || !from) {
      animatingRef.current = false;
      clearParticleTimers();
      setParticles([]);
      setBlob(snapBlob(to));
      return;
    }

    animatingRef.current = true;
    setBlob(stretchBlob(from, to, animationTime));
    spawnParticles(from);
    if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      animatingRef.current = false;
      const settled = measure(activeRef.current);
      if (settled) setBlob(snapBlob(settled));
    }, animationTime + 70);
  };

  const stretched = (blob?.duration ?? 0) > 0;

  return (
    <nav className="gooey-nav" aria-label={ariaLabel} ref={rootRef}>
      <svg className="gooey-nav-svg" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId} x="-120%" y="-450%" width="340%" height="1000%" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" />
          </filter>
        </defs>
      </svg>
      <div className="gooey-nav-goo" style={{ filter: `url(#${filterId})` }} aria-hidden="true">
        {blob && (
          <motion.span
            className="gooey-nav-blob"
            initial={false}
            animate={{ left: blob.left, top: blob.top, width: blob.width, height: blob.height }}
            transition={
              stretched
                ? { duration: blob.duration, times: [0, 0.45, 1], ease: [0.22, 0.8, 0.28, 1] }
                : { duration: 0 }
            }
          />
        )}
        {particles.map((particle) => {
          const style: CssVarStyle = {
            left: particle.cx,
            top: particle.cy,
            "--start-x": `${particle.startX}px`,
            "--start-y": `${particle.startY}px`,
            "--end-x": `${particle.endX}px`,
            "--end-y": `${particle.endY}px`,
            "--time": `${particle.time}ms`,
            "--scale": String(particle.scale),
            "--color": particle.color,
            "--rotate": `${particle.rotate}deg`,
          };
          return (
            <span key={particle.id} className="gooey-particle" style={style}>
              <span className="gooey-particle-point" />
            </span>
          );
        })}
      </div>
      <ul className="gooey-nav-list">
        {items.map((item, index) => (
          <li
            key={`${item.href}-${item.label}`}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            className={index === activeIndex ? "is-active" : undefined}
          >
            <a
              href={item.href}
              aria-current={index === activeIndex ? "true" : undefined}
              onClick={(event) => onSelect(event, index)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
