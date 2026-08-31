import { defineConfig } from "astro/config";
import react from "@astrojs/react";

/**
 * Static output, deployed to Cloudflare Pages.
 *
 * The playground needs a server, but not a rendered one: it posts a snippet to
 * `functions/api/scan.js`, which Cloudflare Pages compiles into a Worker on its
 * own, separately from this build. So the pages stay static and cached at the
 * edge, and exactly one endpoint runs code.
 *
 * That endpoint imports the same files `bin/bouncer.mjs` imports. There is no
 * browser reimplementation of the rules to drift out of sync with the real ones,
 * which was the main risk in putting a demo on the site at all.
 */
export default defineConfig({
  site: "https://bouncer.pages.dev",
  integrations: [react()],
  build: { inlineStylesheets: "auto" },
  vite: {
    css: {
      preprocessorOptions: {
        scss: { api: "modern-compiler" },
      },
    },
  },
});
