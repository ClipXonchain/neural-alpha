"use client";

import { useEffect, useRef } from "react";

type ParticleTextProps = {
  text: string;
  particleSize?: number;
  density?: number;
  color?: string;
  highlightColor?: string;
  scatter?: number;
  gatherDuration?: number;
  stagger?: number;
  pointerRepel?: number;
  repelRadius?: number;
  idleDrift?: number;
  trigger?: "mount";
  fontSize?: string;
  fontWeight?: number;
  fontFamily?: string;
  glow?: boolean;
};

type Particle = {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  letter: number;
  highlight: boolean;
  phase: number;
};

export default function ParticleText({
  text,
  particleSize = 3.6,
  density = 4,
  color = "#EAB308",
  highlightColor = "#ffed22",
  scatter = 190,
  gatherDuration = 1200,
  stagger = 330,
  pointerRepel = 42,
  repelRadius = 40,
  idleDrift = 0.7,
  trigger = "mount",
  fontSize = "clamp(3.5rem, 13vw, 9rem)",
  fontWeight = 800,
  fontFamily = "inherit",
  glow = false,
}: ParticleTextProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas || trigger !== "mount") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: -9999, y: -9999, on: false };
    let particles: Particle[] = [];
    let started = performance.now();
    let frame = 0;
    let alive = true;

    const fitSize = (family: string, width: number) => {
      const probe = document.createElement("span");
      probe.textContent = text;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-weight:${fontWeight};font-family:${family};font-size:${fontSize};`;
      wrap.appendChild(probe);
      const wanted = probe.getBoundingClientRect().width || width;
      const wantedSize = parseFloat(getComputedStyle(probe).fontSize) || 64;
      probe.remove();
      const fitted = wanted > width * 0.96 ? wantedSize * ((width * 0.96) / wanted) : wantedSize;
      return Math.max(28, fitted);
    };

    const sample = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, wrap.clientWidth);
      const height = Math.max(1, wrap.clientHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const paint = off.getContext("2d", { willReadFrequently: true });
      if (!paint) return;
      const family = !fontFamily || fontFamily === "inherit" ? getComputedStyle(wrap).fontFamily : fontFamily;
      const size = fitSize(family, width);
      paint.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint.fillStyle = "#fff";
      paint.font = `${fontWeight} ${size}px ${family}`;
      paint.textAlign = "left";
      paint.textBaseline = "middle";
      const textWidth = paint.measureText(text).width;
      const originX = Math.max(0, (width - textWidth) / 2);
      paint.fillText(text, originX, height / 2);
      const pixels = paint.getImageData(0, 0, off.width, off.height).data;
      const step = Math.max(2, density);
      const next: Particle[] = [];
      const letters = Math.max(1, text.length);
      for (let y = 0; y < off.height; y += step) {
        for (let x = 0; x < off.width; x += step) {
          if (pixels[(y * off.width + x) * 4 + 3] < 140) continue;
          const tx = x / dpr;
          const ty = y / dpr;
          const letter = Math.min(letters - 1, Math.max(0, Math.floor(((tx - originX) / Math.max(textWidth, 1)) * letters)));
          const angle = Math.random() * Math.PI * 2;
          const dist = scatter * (0.4 + Math.random() * 0.6);
          next.push({
            sx: reduce ? tx : tx + Math.cos(angle) * dist,
            sy: reduce ? ty : ty + Math.sin(angle) * dist,
            tx,
            ty,
            letter,
            highlight: Math.random() < 0.16,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
      particles = next;
      started = performance.now();
    };

    const ease = (t: number) => 1 - (1 - t) ** 3;

    const draw = (now: number) => {
      if (!alive) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = wrap.clientWidth;
      const height = wrap.clientHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const particle of particles) {
        const delay = reduce ? 0 : particle.letter * stagger;
        const progress = reduce ? 1 : Math.min(1, Math.max(0, (now - started - delay) / gatherDuration));
        const settled = ease(progress);
        let x = particle.sx + (particle.tx - particle.sx) * settled;
        let y = particle.sy + (particle.ty - particle.sy) * settled;
        if (progress >= 1 && !reduce) {
          x = particle.tx + Math.sin(now / 900 + particle.phase) * idleDrift;
          y = particle.ty + Math.cos(now / 1100 + particle.phase) * idleDrift;
        }
        if (pointer.on) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < repelRadius && dist > 0.01) {
            const push = (1 - dist / repelRadius) * pointerRepel;
            x += (dx / dist) * push;
            y += (dy / dist) * push;
          }
        }
        ctx.fillStyle = particle.highlight ? highlightColor : color;
        ctx.shadowColor = particle.highlight ? highlightColor : color;
        ctx.shadowBlur = glow ? 10 : 0;
        ctx.beginPath();
        ctx.arc(x, y, particleSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      frame = requestAnimationFrame(draw);
    };

    const move = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.on = true;
    };
    const leave = () => {
      pointer.on = false;
    };

    sample();
    frame = requestAnimationFrame(draw);
    wrap.addEventListener("pointermove", move);
    wrap.addEventListener("pointerleave", leave);
    const observer = new ResizeObserver(() => sample());
    observer.observe(wrap);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      wrap.removeEventListener("pointermove", move);
      wrap.removeEventListener("pointerleave", leave);
    };
  }, [text, particleSize, density, color, highlightColor, scatter, gatherDuration, stagger, pointerRepel, repelRadius, idleDrift, trigger, fontSize, fontWeight, fontFamily, glow]);

  return (
    <div ref={wrapRef} className="particle-text" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
