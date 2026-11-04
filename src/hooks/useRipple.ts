"use client";

/**
 * Ripples — a material-style press acknowledgement on any surface.
 *
 * WHY a hook returning a spreadable onPointerDown rather than a <Ripple>
 * wrapper component: every surface that wants this effect (grid cards, list
 * rows, round FABs, menu items) already owns its own markup and — more
 * importantly — its own `overflow` / `position` / stacking contract. Wrapping
 * them would mean re-parenting interactive elements, which is exactly the kind
 * of structural change that breaks focus order and hit-testing. A hook that
 * only appends two spans leaves every element where it already was.
 *
 * HOW the ripple is drawn: on press we measure the element's box, compute the
 * radius that would cover it from the contact point, and append one absolutely
 * positioned span centred on that point. It scales from 0 to its full radius
 * while fading out, then removes itself via `onAnimationEnd`. Only `transform`
 * and `opacity` animate, so the whole effect costs the compositor and nothing
 * else.
 *
 * WHY `onAnimationEnd` and not a timer: the animation duration lives in CSS
 * (where reduced-motion collapses it), so a JS timer keyed to a hard-coded
 * duration would drift from it. Letting the browser tell us when the keyframe
 * finished keeps the two in lockstep and makes the cleanup self-healing if the
 * tab is throttled mid-animation.
 *
 * Reduced motion: no span is ever created. The press still works — it simply
 * has no visual flourish, which is the correct reading of the preference
 * (and the CSS guard would otherwise flash a full-size circle).
 *
 * Accessibility: the ripple is purely decorative. Its host element already
 * carries the accessible name and its own pressed/keyboard behaviour; these
 * spans are `aria-hidden` and `pointer-events-none`, so they can never
 * intercept a click, be announced, or appear in the a11y tree.
 */

import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** The span's class list. Kept as one constant so the CSS contract is obvious. */
const RIPPLE_CLASS = "sonic-ripple";

/** Diameter cap (px) so a very large surface cannot allocate a giant layer. */
const MAX_DIAMETER = 520;

export interface RippleHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Returns `{ onPointerDown }` to spread onto the surface that should ripple.
 *
 * WHY the host needs `position: relative` (or any non-static position): the
 * ripple is `position: absolute` against it. Callers that cannot add a class
 * get their computed position checked at press time — if it is still `static`
 * we set it inline once, which is a one-time style write on press rather than
 * a per-frame cost. (Setting it keeps a future caller from silently getting a
 * ripple positioned against an ancestor.)
 *
 * @param color  Optional CSS color for the ripple wash. Defaults to the theme's
 *               `currentColor` at low alpha, which adapts to the surface (white
 *               on an accent FAB, accent on a dark row) with no per-caller color.
 */
export function useRipple(color?: string): RippleHandlers {
  const reducedMotion = usePrefersReducedMotion();

  return {
    onPointerDown: useCallback(
      (e: ReactPointerEvent<HTMLElement>) => {
        // Reduced motion: build nothing. Returning early is cheaper than
        // creating and hiding a span, and guarantees no flash.
        if (reducedMotion) return;

        // Touch/mouse only. A pen-barrel or a secondary click is not a "press"
        // in the affordance sense, and secondary-clicking a card to open a
        // context menu should not paint a ripple underneath it.
        if (e.button !== 0) return;

        const host = e.currentTarget;
        // `getBoundingClientRect` is the only layout read here, and it happens
        // once per press — not per frame.
        const rect = host.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Cover the furthest corner from the contact point.
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const dx = Math.max(x, rect.width - x);
        const dy = Math.max(y, rect.height - y);
        const radius = Math.min(Math.hypot(dx, dy), MAX_DIAMETER / 2);

        // Guarantee the absolute child has a containing block.
        const computedPosition = getComputedStyle(host).position;
        if (computedPosition === "static") {
          host.style.position = "relative";
        }

        const ripple = document.createElement("span");
        ripple.className = RIPPLE_CLASS;
        ripple.setAttribute("aria-hidden", "true");
        ripple.style.width = `${radius * 2}px`;
        ripple.style.height = `${radius * 2}px`;
        ripple.style.left = `${x - radius}px`;
        ripple.style.top = `${y - radius}px`;
        if (color) ripple.style.backgroundColor = color;

        // Self-removing: the keyframe's `forwards` fill leaves the span
        // invisible even for the frame between the end event and removal.
        ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
        // Belt and braces for the case where `animationend` never fires (the
        // element is removed from view mid-press, a bfcache restore, a
        // backgrounded tab). A stuck ripple would sit at opacity 1 over the
        // label forever; this guarantees it cannot outlive a second.
        window.setTimeout(() => ripple.remove(), 1000);

        // Round surfaces (the play FABs, the heart) read as a circle, and a
        // square ripple sliding under them looks wrong. We cannot put
        // `overflow: hidden` on the host — that would also clip the focus ring
        // and the hover-lift shadow that legitimately hang outside the box — so
        // the RIPPLE takes the circular shape instead when the host is one.
        if (/50%|9999px/.test(getComputedStyle(host).borderRadius)) {
          ripple.style.borderRadius = "50%";
        }

        host.appendChild(ripple);
      },
      [reducedMotion, color]
    ),
  };
}
