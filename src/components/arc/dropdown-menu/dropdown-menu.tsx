"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, ReactNode } from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dropdown-menu.module.css";

// Rich entries compose the same Arc item/highlight; they do not introduce a second menu implementation.
export interface DropdownItem { label: string; onSelect?: () => void; disabled?: boolean; icon?: ReactNode; content?: ReactNode; destructive?: boolean; separatorBefore?: boolean; checked?: boolean; }
export interface DropdownMenuProps { label: string; items: DropdownItem[]; icon?: ReactNode; trigger?: ReactNode; }

type Highlight = { top: number; height: number; danger: boolean; glide: boolean };

/** A new trigger label rises in while the old one leaves, and the trigger width springs to the measured text instead of snapping. */
function TriggerLabel({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const measure = useRef<HTMLSpanElement>(null);
  const measured = useRef<string | null>(null);
  const [size, setSize] = useState<{ width: number | "auto"; animate: boolean }>({ width: "auto", animate: false });
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const current = node.textContent;
      // Only a text change morphs; the first measure and font swaps settle instantly.
      const animate = measured.current !== null && measured.current !== current;
      measured.current = current;
      setSize({ width: Math.ceil(entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth), animate });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.span className={styles.label} initial={false} animate={{ width: size.width }} transition={size.animate && !reduced ? motionTokens.spring.morph : { duration: 0 }}>
    <span ref={measure} className={styles.labelMeasure} aria-hidden="true">{text}</span>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.labelText} initial={reduced ? false : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }} transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{text}</motion.span>
    </AnimatePresence>
  </motion.span>;
}

export function DropdownMenu({ label, items, icon, trigger }: DropdownMenuProps) {
  const reduced = useReducedMotion();
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const pointer = useRef(false);
  const clearTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(clearTimer.current), []);
  // Radix focuses the highlighted item (pointer or keyboard) and the content when the pointer leaves an item.
  function onMenuFocus(event: FocusEvent<HTMLDivElement>) {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role^="menuitem"]') : null;
    window.clearTimeout(clearTimer.current);
    if (!item) {
      // A short grace period keeps the highlight gliding across separators and item gaps.
      clearTimer.current = window.setTimeout(() => setHighlight(null), pointer.current ? 70 : 0);
      return;
    }
    const next = { top: item.offsetTop, height: item.offsetHeight, danger: item.dataset.tone === "danger" };
    const glide = pointer.current;
    setHighlight(current => ({ ...next, glide: glide && current !== null }));
  }
  return <DropdownPrimitive.Root onOpenChange={open => { if (open) { window.clearTimeout(clearTimer.current); setHighlight(null); } }}>
    {trigger ? <DropdownPrimitive.Trigger asChild>{trigger}</DropdownPrimitive.Trigger> : <DropdownPrimitive.Trigger className={styles.trigger} type="button">{icon && <span className={styles.triggerIcon} aria-hidden="true">{icon}</span>}<TriggerLabel text={label}/><ChevronDown className={styles.chevron} size={15} strokeWidth={1.8} aria-hidden="true"/></DropdownPrimitive.Trigger>}
    <DropdownPrimitive.Portal><DropdownPrimitive.Content className={styles.menu} sideOffset={6} align="end" collisionPadding={12} loop onFocus={onMenuFocus} onPointerMoveCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }}>
      {/* One highlight glides between items for the pointer and jumps instantly for the keyboard. */}
      <motion.span className={styles.highlight} data-tone={highlight?.danger ? "danger" : undefined} aria-hidden="true" initial={false} animate={highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }} transition={{ default: highlight?.glide && !reduced ? motionTokens.spring.snappy : { duration: 0 }, opacity: { duration: reduced ? 0 : .08 } }}/>
      <DropdownPrimitive.RadioGroup value={items.find(item => item.checked)?.label} aria-label={label}>
        {items.map((item, index) => {
          const props = { className: [styles.item, item.destructive ? styles.destructive : ''].filter(Boolean).join(' '), 'data-tone': item.destructive ? 'danger' : undefined, style: { '--i': index } as CSSProperties, disabled: item.disabled, onSelect: item.onSelect, textValue: item.label };
          const content = item.content ?? <>{item.icon && <span className={styles.icon} aria-hidden="true">{item.icon}</span>}{item.label}{item.checked !== undefined && <span className={styles.check} aria-hidden="true">{item.checked && <Check size={15} strokeWidth={1.8}/>}</span>}</>;
          return <Fragment key={item.label}>{item.separatorBefore && <DropdownPrimitive.Separator className={styles.separator}/>} {item.checked === undefined ? <DropdownPrimitive.Item {...props}>{content}</DropdownPrimitive.Item> : <DropdownPrimitive.RadioItem {...props} value={item.label}>{content}</DropdownPrimitive.RadioItem>}</Fragment>;
        })}
      </DropdownPrimitive.RadioGroup>
    </DropdownPrimitive.Content></DropdownPrimitive.Portal>
  </DropdownPrimitive.Root>;
}

export default DropdownMenu;
