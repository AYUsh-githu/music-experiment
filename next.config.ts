import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Anchor Turbopack's root at THIS package so Next stops warning that it is
    // resolving package-lock.json from an ancestor outside the Git root (bug #19);
    // Next transpiles this config in a CJS context where __dirname is defined.
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
