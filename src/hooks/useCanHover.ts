"use client";

import { useEffect, useState } from "react";

/**
 * Whether the device supports true hover (`(hover: hover) and (pointer: fine)`).
 *
 * Use it to gate hover-only affordances (play-on-hover, reveal-on-hover, ⋯
 * menus) so they are never the ONLY way to reach a control on touch devices.
 * A control that is discoverable only by hover breaks touch parity (finding
 * F3) — this hook lets you fade an affordance in only for capable pointers.
 *
 * WHY the media query, not a width breakpoint: large touch screens (landscape
 * tablets >768px) support hover but that does not mean a finger-tap reveals a
 * hover-only button. Capability, not size, is what matters.
 */
export function useCanHover(): boolean {
  // Start false (safe server/SSR default); resolved on mount via matchMedia.
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setCanHover(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return canHover;
}
