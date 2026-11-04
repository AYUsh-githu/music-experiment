/**
 * Tiny conditional-className helper (WS2).
 *
 * WHY this exists rather than template-string assembly: §4 forbids building a
 * className by string concatenation, because a stray `undefined`/`false` leaks
 * a literal "undefined"/"false" token into the class list and the result is
 * impossible to grep. This joins only truthy string fragments.
 *
 * The repo has no shared `cn()` (verified: no clsx/classnames imports anywhere
 * under src/), and this agent may not edit src/components/ui/**, so the helper
 * lives in the track/ area this workstream owns and is imported by the home/
 * surfaces too.
 *
 * Accepts strings, falsy values (dropped), and records of class -> condition.
 */
export type ClassValue = string | false | null | undefined | Record<string, boolean>;

export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue; // drops "", false, null, undefined
    if (typeof value === "string") {
      if (value.length > 0) out.push(value);
      continue;
    }
    // Record form: { "text-accent": isCurrent }
    for (const key of Object.keys(value)) {
      if (value[key]) out.push(key);
    }
  }
  return out.join(" ");
}
