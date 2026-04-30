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

## Why this repo still uses `middleware.ts`

**`@opennextjs/cloudflare` does not support Next.js 16’s Node-based `proxy.ts` bundle path yet** and fails the OpenNext build if only `proxy.ts` is used. It still expects the **legacy Edge `middleware.ts`** export for that layer.

- You **cannot** have both `middleware.ts` and `proxy.ts` in the same project; Next.js errors.
- Until the adapter supports `proxy` end-to-end, this project keeps **`middleware.ts`** so **`bun run cf:preview` / `cf:deploy`** keep working.

Upstream context: [opennextjs-cloudflare#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082).

When support lands, the intended end state is: **one root file `proxy.ts`** exporting **`proxy`**, with the same logic you have today in `middleware.ts`.

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
