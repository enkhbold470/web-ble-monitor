# Cloudflare Workers (Wrangler + OpenNext)

This document describes the Cloudflare deployment setup added to this Next.js app.

## What was implemented

- **Wrangler** (`wrangler` dev dependency) — Cloudflare CLI for preview and deploy.
- **`wrangler.jsonc`** — Worker config: name `web-ble-monitor`, entry `.open-next/worker.js`, static assets under `.open-next/assets`, `nodejs_compat`, observability on.
- **`@opennextjs/cloudflare`** — Adapter that builds a Workers-compatible bundle from Next.js.
- **`open-next.config.ts`** — OpenNext config (`defineCloudflareConfig()` default).
- **`next.config.mjs`** — `initOpenNextCloudflareForDev()` for local dev with bindings; `output: "standalone"` for the adapter’s trace/copy step.
- **`.dev.vars`** — Local-only vars for Wrangler (e.g. `NEXTJS_ENV`); see [Cloudflare: `.dev.vars`](https://developers.cloudflare.com/workers/testing/local-development/#local-only-environment-variables).
- **`public/_headers`** — Cache-Control for `/_next/static/*` as recommended for OpenNext static assets.
- **`.gitignore`** — `.open-next/` (build output).

**Scripts** in `package.json`:

| Script        | Purpose |
|---------------|---------|
| `cf:build`    | Run **only** `opennextjs-cloudflare build` (use as Workers **Build command**). |
| `cf:preview`  | Build with OpenNext and run in the Workers runtime locally. |
| `cf:deploy`   | Build and deploy to Cloudflare. |
| `cf:typegen`  | Generate `cloudflare-env.d.ts` from `wrangler.jsonc`. |

**Production build:** `build` is `next build --webpack` because OpenNext expects a webpack-based standalone layout; Next.js 16 defaults to Turbopack for `next build`, which does not match what the adapter copies today. **`dev` still uses Turbopack** (`next dev --turbopack`).

---

## `proxy.ts` vs `middleware.ts` (Next.js 16)

**They are the same feature with a rename.**

- In **Next.js 16**, the supported file name is **`proxy.ts`** (or `.js`). You export a function named **`proxy`** (or a default function). It runs at the network edge of your app, before routes resolve: redirects, rewrites, header tweaks, matcher config — same model as before.
- The old convention **`middleware.ts`** with **`export function middleware`** is **deprecated** but still works. Next shows a warning telling you to migrate to `proxy.ts`.

So: **`proxy.ts` is not a different product** — it is **middleware under a clearer name** (plus runtime defaults that differ in plain Next; the request/response API is the same style).

---

## `proxy.ts` rules (CI / `next build`)

If the project has a root **`proxy.ts`** file, Next.js 16 requires **either**:

- a **named** export: `export function proxy(request: NextRequest) { ... }`, or  
- a **default** export that is that function.

Exporting **`middleware`** from **`proxy.ts`** is invalid and fails **`next build`** with:

> The file "./proxy.ts" must export a function … named "proxy" export.

**`proxy.ts` and `middleware.ts` cannot both exist**; Next.js errors if both are present.

---

## Standard `next build` vs OpenNext (`cf:deploy`)

| Command | Root file | Export |
|--------|-----------|--------|
| `next build` (Vercel, Cloudflare Workers Builds using `pnpm run build`, etc.) | `proxy.ts` | `export function proxy` |
| `opennextjs-cloudflare build` (`cf:preview` / `cf:deploy`) | **`middleware.ts` only** (no `proxy.ts` in repo) | `export function middleware` |

**`@opennextjs/cloudflare` still treats Next 16 `proxy.ts` as Node middleware** and fails with “Node.js middleware is not currently supported”. You **cannot** satisfy **both** pipelines with one root file until the adapter supports `proxy` ([opennextjs-cloudflare#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082)).

**Practical options:**

1. **Default (CI):** Keep **`proxy.ts`** + **`export function proxy`** so **`pnpm run build` succeeds.  
2. **When you need `cf:deploy`:** Use **`middleware.ts`** only (same logic, **`export function middleware`**), **remove `proxy.ts`**, run OpenNext; or wait for adapter support for `proxy.ts`.

---

## Workers Builds: "Could not find compiled Open Next config"

Cloudflare detected an OpenNext project and ran **`opennextjs-cloudflare deploy`** in the deploy step. That command **does not** run `next build` for you; it expects the **OpenNext build** to have **already** run and written **`.open-next/`** (worker bundle, assets, compiled config).

What often goes wrong:

1. **Build command** in the dashboard is still **`pnpm run build`** / **`npm run build`**, which only runs **`next build`**. That produces **`.next/`**, not the **`.open-next/`** tree OpenNext needs.
2. The **deploy** step then calls **`opennextjs-cloudflare deploy`**, finds no compiled OpenNext output, and exits with **"Could not find compiled Open Next config, did you run the build command?"**

**Fix (Cloudflare dashboard → Workers → your Worker → Settings → Builds):**

- Set **Build command** to one of:
  - `pnpm exec opennextjs-cloudflare build`
  - `pnpm run cf:build` (if you use `pnpm` and this repo’s scripts)
  - `bunx opennextjs-cloudflare build` / `bun run cf:build` when using Bun locally; on Workers Builds use the same package manager the project uses (`pnpm exec …`, `npx …`, etc.).
- Keep **Deploy** as automatic (or **`opennextjs-cloudflare deploy`** / **`wrangler deploy`**) **after** that build succeeds.

**Do not** rely on **`pnpm run build`** alone for Cloudflare OpenNext deploy. Either:

- use **`cf:build`** (OpenNext) as the **Build command**, or  
- use a **single** custom command that does both, e.g. `pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare deploy`, and align the dashboard so it doesn’t run a redundant `next-only` build before deploy.

**Note:** `opennextjs-cloudflare build` runs your **`package.json`** **`build`** script (`next build --webpack`) internally, then generates **`.open-next/`**. You still hit the **`proxy.ts` vs `middleware.ts`** limitation for OpenNext until the adapter supports Node proxy ([#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082)).

---

## Quick start

1. Install deps: `bun install`
2. Log in: `bunx wrangler login`
3. Preview on Workers locally: `bun run cf:preview`
4. Deploy: `bun run cf:deploy`

Official references:

- [Next.js on Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [OpenNext Cloudflare](https://opennext.js.org/cloudflare/get-started)
- [Migration: middleware → proxy](https://nextjs.org/docs/messages/middleware-to-proxy)
