/**
 * Home page — landing surface with a trending shelf, recently-played shelf and
 * "jump back in" hero.
 *
 * Phase 1 shipped a trivial placeholder. Phase 5 fills it out: the actual
 * composition and client playback live in components/home/HomeView (use client)
 * because it reads IndexedDB history and routes clicks through the playerBridge.
 * This file stays a thin server component that just mounts that view.
 */
import HomeView from "@/components/home/HomeView";

export default function HomePage() {
  return (
    <section className="mx-auto max-w-5xl">
      <HomeView />
    </section>
  );
}
