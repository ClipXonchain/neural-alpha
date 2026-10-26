"use client";

import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";
import styles from "./rainbow-button.module.css";

/** Dark button with a slow green border. */
export function RainbowButton({ className, children, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cn(styles.button, className)} {...props}>
      <span className={styles.label}>{children}</span>
    </button>
  );
}
