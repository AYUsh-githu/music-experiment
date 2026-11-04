/**
 * Sonic Motion Language — the SINGLE source of motion truth (WS0).
 *
 * Read-only for every workstream after WS0. If a feature needs a duration,
 * spring, or ease that is not here, STOP and report it to the orchestrator —
 * do NOT fork tokens into a component. Only the values below are allowed for
 * state-change motion (§4): 120/200/320/400 ms durations, the two eased curves,
 * and the three spring presets (stiffness 300–400, damping 28–34).
 *
 * Anything animated on a gesture (drag release, sheet dismiss, morph) uses a
 * SPRING; timed transitions use DUR + EASE.
 */

/** The only allowed state-change durations (seconds). */
export const DUR = { instant: 0.12, quick: 0.2, standard: 0.32, deliberate: 0.4 } as const;

/** The only allowed eased motion curves. `out` for entrances, `inOut` for
 *  reversible/opening-closing surfaces. */
export const EASE = { out: [0.22, 1, 0.36, 1], inOut: [0.4, 0, 0.2, 1] } as const;

/** The only allowed springs — gesture-driven motion only. */
export const SPRING = {
  snappy: { type: "spring", stiffness: 400, damping: 34 },
  soft: { type: "spring", stiffness: 300, damping: 30 },
  release: { type: "spring", stiffness: 380, damping: 28 },
} as const;

/** Entrance stagger: 25 ms between items, capped at 8 so the total stay in
 *  budget — last delay 7×0.025 = 0.175 s + duration 0.2 s = 0.375 s ≤ 0.4 s. */
export const STAGGER = { step: 0.025, maxItems: 8 } as const;

/**
 * Transition for reveal-once entrances (lists, sections).
 * @param i item index within the staggered batch
 */
export const revealTransition = (i = 0) => ({
  duration: DUR.quick,
  ease: EASE.out,
  delay: Math.min(i, STAGGER.maxItems - 1) * STAGGER.step,
});
