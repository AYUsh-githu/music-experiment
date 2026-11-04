"use client";

/**
 * Promise-based dialog hook (Wave 1, defect 8).
 *
 * Replaces the app's remaining native window.prompt / window.confirm blocking
 * dialogs (Library's create/rename/delete playlist, and the Settings danger
 * zone) with styled Modals. Each call returns a Promise that resolves with the
 * user's decision, exactly like the native APIs it replaces, so existing
 * `await window.prompt(...)` call sites port over with a one-line change.
 *
 * Usage:
 *   const dialog = useDialog();
 *   const name = await dialog.prompt({ title, label, initialValue });
 *   const ok   = await dialog.confirm({ title, message, confirmLabel });
 *   ...
 *   return <>{children}{dialog.host}</>;
 *
 * WHY a promise API (not a controlled `open`/`value` pair): the callers are
 * async handlers that `await` the native prompt/confirm today. Promise-ifying
 * keeps their control flow intact and makes misuse (reading a value before the
 * dialog closes) structurally impossible.
 *
 * PRESENTATION / A11Y fixes:
 *   - The confirm variant renders the same visible `title` heading the prompt
 *     variant does, so a delete confirmation reads as a real dialog instead of a
 *     lone grey sentence.
 *   - The message is wired to the confirm button via aria-describedby, so a
 *     screen reader announces the question with the action.
 *   - Cancel is rendered first, i.e. tab order reaches the safe action before
 *     the destructive one.
 *   - The prompt input's label is tied to a per-instance id (useId) and the
 *     caller's `placeholder` is finally used.
 */

import { useCallback, useId, useRef, useState } from "react";
import Modal from "@/components/ui/Modal";

/** Shared shape every dialog request carries. */
interface DialogRequestBase {
  /** Modal aria-label + visible heading. */
  title: string;
}

/** A text-input ("prompt") request. Resolves to the trimmed value, or null on cancel. */
interface PromptRequest extends DialogRequestBase {
  kind: "prompt";
  label: string;
  initialValue?: string;
  /** Placeholder for the text box, e.g. "My playlist". */
  placeholder?: string;
  /** Non-empty submit button label, e.g. "Create" / "Rename". */
  confirmLabel?: string;
}

/** A yes/no ("confirm") request. Resolves to true on confirm, false on cancel. */
interface ConfirmRequest extends DialogRequestBase {
  kind: "confirm";
  message: string;
  confirmLabel?: string;
  /** Render the confirm button in the danger color (deletions). */
  danger?: boolean;
}

type DialogRequest = PromptRequest | ConfirmRequest;

/** Shared action styling so prompt and confirm buttons cannot drift apart. */
const CANCEL_CLASS =
  "h-11 rounded-lg border border-border px-4 text-sm font-semibold text-text transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent";
const CONFIRM_CLASS =
  "h-11 rounded-lg px-4 text-sm font-semibold text-white transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-accent";

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

export interface DialogApi {
  /** Ask for a text value. Resolves to the trimmed string, or null if cancelled. */
  prompt: (req: Omit<PromptRequest, "kind">) => Promise<string | null>;
  /** Ask a yes/no question. Resolves to true (continue) or false (cancel). */
  confirm: (req: Omit<ConfirmRequest, "kind">) => Promise<boolean>;
  /** Render this inside the calling component (typically the page root). */
  host: React.ReactNode;
}

export function useDialog(): DialogApi {
  // The currently open request (null = none). ONE at a time is enough for our
  // callers; queuing multiple would complicate focus handling for little gain.
  const [request, setRequest] = useState<DialogRequest | null>(null);

  // Live textbox value while a prompt is open. Not in the request object so a
  // re-render of the input doesn't mutate the awaiting closure.
  const [value, setValue] = useState("");

  // Resolver for the pending promise, held in a ref so the Modal's onClose
  // can resolve it without closing over stale state.
  const resolveRef = useRef<((v: string | null | boolean) => void) | null>(null);

  // Per-instance id: a page may mount the host more than once, and a fixed id
  // would then point a label at the wrong input.
  const id = useId();
  const inputId = `${id}-input`;
  const messageId = `${id}-message`;

  const prompt = useCallback(
    (req: Omit<PromptRequest, "kind">): Promise<string | null> =>
      new Promise((resolve) => {
        resolveRef.current = resolve as (v: string | null | boolean) => void;
        setValue(req.initialValue ?? "");
        setRequest({ ...req, kind: "prompt" });
      }),
    []
  );

  const confirm = useCallback(
    (req: Omit<ConfirmRequest, "kind">): Promise<boolean> =>
      new Promise((resolve) => {
        resolveRef.current = resolve as (v: string | null | boolean) => void;
        setRequest({ ...req, kind: "confirm" });
      }),
    []
  );

  /** Close the dialog and settle the pending promise with `result`. */
  const settle = useCallback((result: string | null | boolean) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setRequest(null);
  }, []);

  const inputRef = useRef<HTMLInputElement | null>(null);

  const host = (
    <>
      {request?.kind === "prompt" && (
        <Modal
          open
          onClose={() => settle(null)}
          aria-label={request.title}
          title={request.title}
          initialFocus={inputRef}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = value.trim();
              if (trimmed) settle(trimmed);
            }}
          >
            <label htmlFor={inputId} className="block text-sm font-medium text-text">
              {request.label}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              // Enter submits via the form; Escape is handled by the Modal's
              // focus trap, so no local key handler is needed.
              autoComplete="off"
              placeholder={request.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-required
              className="mt-2 h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => settle(null)} className={CANCEL_CLASS}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!value.trim()}
                className={`${CONFIRM_CLASS} bg-accent hover:bg-accent-2`}
              >
                {request.confirmLabel ?? "OK"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {request?.kind === "confirm" && (
        <Modal open onClose={() => settle(false)} aria-label={request.title} title={request.title}>
          {/* Dangers read as danger; benign questions stay muted body copy. */}
          <p id={messageId} className={request.danger ? "text-sm text-danger" : "text-sm text-muted"}>
            {request.message}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            {/* Cancel is rendered first so the tab order reaches the safe
                action before the destructive one. */}
            <button type="button" onClick={() => settle(false)} className={CANCEL_CLASS}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => settle(true)}
              aria-describedby={messageId}
              className={`${CONFIRM_CLASS} ${
                request.danger ? "bg-danger hover:opacity-90" : "bg-accent hover:bg-accent-2"
              }`}
            >
              {request.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );

  return { prompt, confirm, host };
}
