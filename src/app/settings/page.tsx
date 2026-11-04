"use client";

/**
 * Settings page (Phase 4 §4.3).
 *
 * Renders live controls bound to the app-settings store (src/lib/client/settings.ts):
 * playback quality, artwork size, and radio auto-play all write to the store and
 * take effect immediately. The "Danger zone" drives the library-clear
 * operations in src/lib/client/db.ts, each behind an accessible confirm dialog
 * with a brief disabled/pending state so a user can't double-fire a wipe.
 *
 * WHY live (not form-save): settings are trivial scalar values that should apply
 * instantly — there's no "Save" to defer. `useAppSettings()` (a
 * useSyncExternalStore hook) keeps the controls' checked/selected state in sync
 * with what's actually persisted.
 *
 * Wave 1 (defect 12): success/error feedback flows through the world-wide toast
 * system (toast.success / toast.error) instead of alert(); the default
 * confirmation frontier uses the accessible promise-based useDialog (defect 8)
 * rather than window.confirm.
 *
 * §4.3 / polish pass — PRESENTATION ONLY (no setting added, removed or rewired):
 *  - One page rhythm shared with Search and Library: the same h1 scale, a
 *    one-line subtitle, then sections that each own a heading, a card of rows
 *    and a one-line explanation of what the section does.
 *  - Rows are `group`s: a leading 36px icon tile, a two-line label
 *    (name + what it does), the control at the trailing edge. On a hover-capable
 *    pointer the row washes and a faint accent rail lights up — both are
 *    capability-gated with useCanHover (rule 2), so on touch the row is static
 *    and every control stays directly tappable. Nothing is hover-only.
 *  - Destruction is separated: the danger card states the consequence, each
 *    destructive action names exactly what it deletes, and the pending state is
 *    announced (aria-busy) as well as disabled.
 *  - The banner at the top is the ONE place the page explains it saves itself,
 *    so no individual row has to.
 */
import { useId, useState } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useAppSettings } from "@/lib/client/settings";
import {
  clearFavorites,
  clearHistory,
  clearPlaylists,
  clearLibrary,
} from "@/lib/client/db";
import { useDialog, type DialogApi } from "@/lib/client/useDialog";
import { toast } from "@/lib/client/toast";
import { useCanHover } from "@/hooks/useCanHover";
import { cn } from "@/components/track/cn";
// Phase 1.1 icon set — section/row glyphs (read-only consumption).
import {
  Check,
  Clock,
  Library,
  Play,
  Queue,
  X,
} from "@/components/ui/icons";

/* ------------------------------ primitives ------------------------------ */

/** Icon components all come from ui/icons (SVGProps consumers). */
type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

type RowTone = "accent" | "muted" | "danger";

/**
 * Leading icon in a 36px rounded tile. Fragments (Sparkle) carry their own
 * <svg>, so a fragment and an icon component share one rendering path here.
 */
function RowIcon({ Icon, tone }: { Icon: IconComponent; tone: RowTone }) {
  return (
    <span
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
        {
          "bg-accent/15 text-accent": tone === "accent",
          "bg-surface-2 text-muted": tone === "muted",
          "bg-danger/15 text-danger": tone === "danger",
        },
      )}
      aria-hidden
    >
      <Icon className="h-[18px] w-[18px]" />
    </span>
  );
}

/** Two-line label block: the setting name plus its one-line explanation. */
function RowLabel({
  label,
  description,
  htmlFor,
}: {
  label: string;
  description?: string;
  /** Associates the text with the control it labels, for assistive tech. */
  htmlFor?: string;
}) {
  return (
    <span className="min-w-0 flex-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-text">
        {label}
      </label>
      {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
    </span>
  );
}

/**
 * One settings row: icon + two-line label + control on the right. The hover
 * wash and the accent rail are capability-gated with useCanHover (rule 2) — on
 * touch devices the row is static and every control stays directly tappable;
 * nothing here is hover-only.
 */
function SettingsRow({
  icon,
  tone = "muted",
  label,
  description,
  htmlFor,
  control,
}: {
  icon: IconComponent;
  tone?: RowTone;
  label: string;
  description?: string;
  htmlFor?: string;
  control: ReactNode;
}) {
  const canHover = useCanHover();
  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-4 px-4 py-3.5 sm:px-5",
        canHover && "transition-colors duration-[var(--dur-micro)] hover:bg-surface-2",
      )}
    >
      {/* Accent rail: a static 2px bar whose OPACITY animates on row hover. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent",
          "transition-opacity duration-[var(--dur-micro)]",
          { "opacity-0 group-hover/row:opacity-100": canHover, "opacity-0": !canHover },
        )}
      />
      <RowIcon Icon={icon} tone={tone} />
      <RowLabel label={label} description={description} htmlFor={htmlFor} />
      {control}
    </div>
  );
}

/** Section shell: heading + optional blurb + the card holding the rows. */
function SettingsSection({
  title,
  description,
  danger = false,
  children,
}: {
  title: string;
  description: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="mt-8">
      <h2
        className={cn("text-sm font-semibold uppercase tracking-wider", {
          "text-danger": danger,
          "text-muted": !danger,
        })}
      >
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The card every section's rows sit in (matches Library's panel treatment). */
function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {children}
    </div>
  );
}

/**
 * Segmented two-option selector (radio group semantics, not aria-pressed):
 * a segmented control is a single choice out of N, so assistive tech should
 * hear "1 of 2 selected", which only role=radio + aria-checked conveys.
 */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  id,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (next: T) => void;
  /** id of the row's <label>, so the group is named by its visible text. */
  id?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={id}
      aria-label={id ? undefined : label}
      className="flex shrink-0 overflow-hidden rounded-lg border border-border"
    >
      {options.map(([opt, text]) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt)}
            className={cn(
              "h-11 px-4 text-sm font-semibold transition-colors duration-[var(--dur-micro)]",
              "focus-visible:outline-none",
              {
                "bg-accent text-white": active,
                "bg-surface text-muted hover:text-text": !active,
              },
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Boolean toggle (checkbox) for the radio / auto-play setting.
 *
 * WHY a visually-hidden native checkbox instead of `accent-[var(--accent)]`:
 * a styled switch needs a 44px target (rule 3) and a track/thumb that reads on
 * the dark surface, neither of which a UA checkbox offers. The real input keeps
 * its label — keyboard and screen-reader behavior are unchanged — while the
 * visible track animates ONLY the thumb's transform.
 */
function BooleanToggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        // `peer` must be the track's PRECEDING sibling for peer-focus-visible to
        // resolve; the input is visually hidden but still in flow-adjacent DOM
        // order, which is exactly what the peer variant needs.
        className="peer sr-only"
      />
      {/* Track: color transition only, no size change. The focus ring comes from
          the input via peer-focus-visible (the input itself is sr-only, so its
          own outline would be invisible). */}
      <span
        aria-hidden
        className={cn(
          "flex h-6 w-11 items-center rounded-full border transition-colors duration-[var(--dur-standard)]",
          "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent-2",
          {
            "border-accent bg-accent": checked,
            "border-border bg-surface-2": !checked,
          },
        )}
      >
        {/* Thumb: transform-only slide (x-axis), 18px inside a 24px track. */}
        <span
          className={cn(
            "mx-0.5 h-[18px] w-[18px] rounded-full bg-white shadow",
            "transition-transform duration-[var(--dur-standard)] ease-out",
            { "translate-x-[20px]": checked, "translate-x-0": !checked },
          )}
        />
      </span>
      {/* 44px hit area around the 24px track — the label wrapper owns the click,
          so this only has to widen the target, never receive it. */}
      <span aria-hidden className="absolute -inset-y-2.5 -left-2 -right-2" />
    </span>
  );
}

/**
 * A single danger-zone action: an accessible confirm dialog gates the action
 * (never window.confirm, §4), wraps the db call in try/catch, and shows a
 * short disabled/pending state while running. Feedback is delivered via toasts
 * (defect 12).
 *
 * WHY the request guard as well as `disabled`: a pointer that fires two clicks
 * inside one frame reaches `handle` twice before React re-renders the disabled
 * attribute, which would open two confirm dialogs. The ref closes that window
 * synchronously.
 */
function DangerButton({
  label,
  hint,
  successText,
  confirmText,
  onRun,
  dialog,
  busy,
  onBusyChange,
}: {
  label: string;
  /** One line naming exactly what disappears. */
  hint: string;
  /** Message shown on a successful clear, e.g. "Library data cleared". */
  successText: string;
  confirmText: string;
  onRun: () => Promise<void>;
  dialog: DialogApi;
  /** Shared busy flag so the grid can announce "working" once, not four times. */
  busy: boolean;
  onBusyChange: (next: boolean) => void;
}) {
  const [requested, setRequested] = useState(false);
  const pending = requested || busy;

  const handle = async () => {
    if (pending) return;
    setRequested(true);
    try {
      const ok = await dialog.confirm({
        title: "Confirm",
        message: confirmText,
        confirmLabel: "Clear",
        danger: true,
      });
      if (!ok) return;
      onBusyChange(true);
      try {
        await onRun();
        toast.success(successText);
      } catch (err) {
        // The db layer never throws by contract, but guard anyway so a surprise
        // failure surfaces as a user-facing toast rather than an unhandled reject.
        console.warn("[settings] clear failed:", err);
        toast.error("Couldn't clear. Please try again.");
      } finally {
        onBusyChange(false);
      }
    } finally {
      setRequested(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handle}
      disabled={pending}
      aria-busy={pending}
      className={cn(
        "group/danger flex min-h-11 items-center gap-3 rounded-xl border border-danger/30 bg-surface px-4 py-3 text-left",
        "transition-colors duration-[var(--dur-micro)] hover:border-danger/60 hover:bg-danger/[0.06]",
        "active:scale-[0.99] disabled:opacity-40 disabled:hover:border-danger/30 disabled:hover:bg-surface",
        "focus-visible:outline-none",
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-danger/15 text-danger" aria-hidden>
        <X className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-danger">
          {pending ? "Clearing…" : label}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}

/** Small "saved automatically" reassurance — presentation, no behavior. */
function AutoSaveNote() {
  return (
    <p className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent" aria-hidden>
        <Check className="h-3.5 w-3.5" />
      </span>
      Changes apply and save instantly — there is nothing to submit.
    </p>
  );
}

/* -------------------------------- page -------------------------------- */

export default function SettingsPage() {
  const [settings, setSettings] = useAppSettings();
  const dialog = useDialog();
  // The explanatory row in the danger card uses a Clock-ish glyph; the grid
  // below shares one "something is running" flag with aria-busy.
  const [clearing, setClearing] = useState(false);

  // One id prefix per mount, so the label/control pairs stay unique even if the
  // route is mounted more than once in a test harness.
  const uid = useId();
  const qualityId = `${uid}-quality`;
  const artworkId = `${uid}-artwork`;
  const radioId = `${uid}-radio`;

  return (
    <section className="mx-auto max-w-5xl">
      {/* Shared page header scale with Search and Library (and Home). */}
      <h1 className="text-3xl font-bold tracking-tight text-text sm:text-4xl">Settings</h1>
      <p className="mt-1 text-sm text-muted">
        Tune playback and artwork, and manage what Sonic has stored.
      </p>
      <AutoSaveNote />

      {/* ---------- Playback & interface ---------- */}
      <SettingsSection
        title="Playback & interface"
        description="How streams are fetched and how the app draws artwork."
      >
        <SettingsCard>
          <SettingsRow
            icon={Play}
            tone="accent"
            label="Playback quality"
            description="Best streams at the highest available bitrate."
            htmlFor={qualityId}
            control={
              <Segmented
                id={qualityId}
                label="Playback quality"
                value={settings.quality}
                options={[
                  ["best", "Best"],
                  ["low", "Low"],
                ]}
                onChange={(quality) => setSettings({ quality })}
              />
            }
          />
          <SettingsRow
            icon={Library}
            tone="accent"
            label="Artwork size"
            description="Small loads lighter thumbnails throughout the app."
            htmlFor={artworkId}
            control={
              <Segmented
                id={artworkId}
                label="Artwork size"
                value={settings.artworkSize}
                options={[
                  ["large", "Large"],
                  ["small", "Small"],
                ]}
                onChange={(artworkSize) => setSettings({ artworkSize })}
              />
            }
          />
          <SettingsRow
            icon={Queue}
            tone="accent"
            label="Radio / Auto-play"
            description="Automatically play the next track when the current one ends."
            htmlFor={radioId}
            control={
              <BooleanToggle
                id={radioId}
                checked={settings.radio}
                onChange={(radio) => setSettings({ radio })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* ---------- Danger zone ---------- */}
      <SettingsSection
        title="Danger zone"
        description="These actions permanently delete data from your library. They cannot be undone."
        danger
      >
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          aria-busy={clearing}
          aria-label="Clear library data"
          role="group"
        >
          <DangerButton
            label="Clear favorites"
            hint="Deletes every song you have hearted."
            successText="Favorites cleared"
            confirmText="Clear all favorites? This cannot be undone."
            onRun={clearFavorites}
            dialog={dialog}
            busy={clearing}
            onBusyChange={setClearing}
          />
          <DangerButton
            label="Clear history"
            hint="Deletes the record of songs you have played."
            successText="Play history cleared"
            confirmText="Clear your entire play history? This cannot be undone."
            onRun={clearHistory}
            dialog={dialog}
            busy={clearing}
            onBusyChange={setClearing}
          />
          <DangerButton
            label="Clear playlists"
            hint="Deletes every playlist, but keeps its tracks in your library."
            successText="Playlists cleared"
            confirmText="Delete all playlists? This cannot be undone."
            onRun={clearPlaylists}
            dialog={dialog}
            busy={clearing}
            onBusyChange={setClearing}
          />
          <DangerButton
            label="Clear all library data"
            hint="Deletes favorites, history and playlists."
            successText="Library data cleared"
            confirmText="Delete ALL library data (favorites, history, and playlists)? This cannot be undone."
            onRun={clearLibrary}
            dialog={dialog}
            busy={clearing}
            onBusyChange={setClearing}
          />
        </div>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Clearing runs on this device only; nothing is restored when you reload.
        </p>
      </SettingsSection>

      {/* Accessible confirm host (defect 8). */}
      {dialog.host}
    </section>
  );
}
