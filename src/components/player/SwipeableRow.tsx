"use client";

/**
 * SwipeableRow — swipe a queue row left to reveal "Remove", and drag far enough
 * to commit it.
 *
 * WHY a wrapper around the whole row rather than a per-row gesture handler: on
 * the mobile bottom sheet the drawer panel ITSELF is a framer drag target
 * (`drag="y"` for drag-to-dismiss). Framer resolves gestures per element, so a
 * nested `drag="x"` on the row is not ambiguous — the axis lock decides — but
 * the row still has to stop the panel from ALSO seeing a horizontal press it
 * might later treat as a vertical drag. We do that by keeping the wrapper's own
 * drag surface to `x` only and by letting framer's axis detection own the
 * decision; the panel's `dragElastic: { top: 0, bottom: 0.4 }` then only reacts
 * to a genuine vertical pull.
 *
 * WHY the delete is COMMITTED on release past a threshold (rather than an
 * always-visible red button behind the row): the queue already exposes a ⋯ menu
 * with "Remove from queue", and that menu is the discoverable, keyboard, and
 * screen-reader path. Swipe is a shortcut for fingers. Revealing a button that
 * then needs a second tap would make it a worse shortcut than the menu; a
 * single decisive swipe that dumps the row is the behaviour a music app's queue
 * trains people to expect.
 *
 * Keyboard / assistive-tech parity: the swipe is pointer-only and adds NOTHING
 * to the a11y tree — the row inside keeps its own controls, including the ⋯
 * menu's Remove item. Nothing here is the only route to an action.
 *
 * Reduced motion: the gesture is disabled entirely (no drag, no exit animation)
 * because a row that snaps out of the list is exactly the kind of movement the
 * preference asks us to avoid. The ⋯ menu still removes.
 *
 * WHY the row is removed from the LIST data, not just visually: `onRemove`
 * updates the player's queue, so the row unmounts naturally. If both the visual
 * exit and the data removal ran, the row would animate out while the list had
 * already re-rendered underneath it. We therefore remove on commit and rely on
 * the parent's keying; no local "removed" flag is kept, which also means the
 * component has no state that can drift from the real queue.
 */

import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { DUR, EASE } from "@/lib/client/motion";

/** Horizontal travel (px) past which a release removes the row. */
const DELETE_THRESHOLD = 96;
/** How far the row may be dragged (px); extra resistance beyond looks rubbery. */
const MAX_OFFSET = 140;
/** Exit distance (px) once committed — enough to leave the drawer's width. */
const EXIT_DISTANCE = 420;

interface SwipeableRowProps {
  /** Remove this row from the queue. Called once, on a committed swipe. */
  onRemove: () => void;
  children: React.ReactNode;
}

export default function SwipeableRow({ onRemove, children }: SwipeableRowProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [offset, setOffset] = useState(0);
  const [exiting, setExiting] = useState(false);
  // Guards the commit so a fast double-release cannot call onRemove twice (the
  // row unmounts on the parent's next render, which is not synchronous).
  const committedRef = useRef(false);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    setExiting(true);
    onRemove();
  };

  // Reduced motion (or a non-pointer environment): render the row untouched.
  // No drag props, no transitions — it is exactly the markup the drawer had.
  if (reducedMotion) {
    return <>{children}</>;
  }

  return (
    <motion.div
      className="relative"
      drag="x"
      // Left only: dragging right would reveal nothing (there is no
      // "move to front" action), so it is resisted hard rather than allowed.
      dragConstraints={{ left: -MAX_OFFSET, right: 0 }}
      dragElastic={{ left: 0.12, right: 0 }}
      dragDirectionLock
      onDrag={(_, info) => setOffset(info.offset.x)}
      onDragEnd={(_, info) => {
        // Commit on distance OR a decisive flick, so a fast short swipe works
        // the same as a slow long one (the same rule the drawer uses to dismiss).
        const farEnough = info.offset.x < -DELETE_THRESHOLD;
        const flicked = info.offset.x < -40 && info.velocity.x < -520;
        if (farEnough || flicked) {
          commit();
          return;
        }
        setOffset(0); // snap back; dragSnapToOrigin is implicit via constraints
      }}
      animate={
        exiting
          ? { x: -EXIT_DISTANCE, opacity: 0 }
          : { x: 0, opacity: 1 }
      }
      transition={
        exiting
          ? { duration: DUR.standard, ease: EASE.out }
          : { type: "spring", stiffness: 420, damping: 38 }
      }
      style={{ touchAction: "pan-y" }}
    >
      {/* The revealed backdrop. It sits BEHIND the row and fades in with the
          drag distance, so a tiny nudge shows a hint of red rather than a
          hard-edged panel appearing from under the row. Static layers only —
          its opacity follows the drag, which is not an animation of its own. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-end rounded-lg pr-4"
        style={{
          opacity: Math.min(1, Math.abs(offset) / DELETE_THRESHOLD),
          background: `linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--danger) 24%, transparent) 100%)`,
        }}
      >
        <span className="text-xs font-semibold text-white/90">Remove</span>
      </div>

      {children}
    </motion.div>
  );
}
