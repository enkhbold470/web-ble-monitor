# Cloudflare Workers (Wrangler + OpenNext)

This document describes the Cloudflare deployment setup added to this Next.js app.

## What was implemented

- **Wrangler** (`wrangler` dev dependency) — Cloudflare CLI for preview and deploy.
- **`wrangler.jsonc`** — Worker config: name `web-ble-monitor`, entry `.open-next/worker.js`, static assets under `.open-next/assets`, `nodejs_compat`, observability on.
- **`middleware.ts`** — Request interception (**deprecated file name** in Next 16 but needed for **`@opennextjs/cloudflare`**: **`proxy.ts`** trips “Node middleware not supported” until [#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082)). Same logic Cloudflare/OpenNext Builds expect (**`bun run cf:build`** / dashboard).
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

- In **Next.js 16+,** the **`proxy.ts`** convention (with **`export function proxy`**) is the **current naming** for app-side request interception ([**migration guide**](https://nextjs.org/docs/messages/middleware-to-proxy)).
- **`proxy` runs on the Node.js runtime** (not Edge); **`middleware.ts` + `middleware` is deprecated** but still emitted for backward compatibility ([Next.js 16 release notes — Proxy](https://nextjs.org/blog/next-16#proxyts-formerly-middlewarets)).

So **`proxy`** is Express-style overloaded “middleware”? No — intentionally renamed to **`proxy`** to mean “thin network boundary”; **middleware.ts** disappears in future.

## `proxy.ts` rules (CI / `next build`)

If the project has a root **`proxy.ts`** file, Next.js 16 requires **either**:

- a **named** export: `export function proxy(request: NextRequest) { ... }`, or  
- a **default** export that is that function.

Exporting **`middleware`** from **`proxy.ts`** is invalid and fails **`next build`** with:

> The file "./proxy.ts" must export a function … named "proxy" export.

**Never have both **`proxy.ts`** and **`middleware.ts`** at repo root — Next refuses.

---

## Standard `next build` vs OpenNext (`cf:deploy`)

Next.js **recommends `proxy.ts`** from **v16 onward** ([migration guide](https://nextjs.org/docs/messages/middleware-to-proxy), [proxy file convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)): **`proxy.ts`** + **`export function proxy`**. That interception runs on **Node.js** (“Proxy always runs on Node.js runtime”; Next rejects segment `runtime` config in Proxy files.)

| Command | Canonical Next | `@opennextjs/cloudflare build` |
|--------|------------------|--------------------------------|
| `next build` / `bun run build` | **`proxy.ts`** (Next‑16‑canonical) **or `middleware.ts`** (deprecated name, Edge) — this repo **`middleware.ts`** for Cloudflare until [#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082) | N/A |
| **`opennextjs-cloudflare build`** (`cf:*`) | **`middleware.ts`** (Edge middleware in `.next` manifest) | ✅ |
| Next **`proxy.ts` only** | Node interception (`/_middleware` in manifests) | ❌ **`Node.js middleware is not currently supported`** |

Tracking: **[opennextjs-cloudflare#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082)** (proxy / Node middleware).

### This repo (Cloudflare Workers / OpenNext)

- **Ships `middleware.ts`** so **`opennextjs-cloudflare build`** succeeds in CI and the dashboard. You will see Next’s deprecation warning on `next build`; that is intentional until [#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082) lands.

### Prefer pure Next.js 16 naming only

Use **`proxy.ts`** + **`export function proxy`** when you **do not** need **`@opennextjs/cloudflare`**, or once OpenNext supports Node proxy interception.

Codemod: **`npx @next/codemod@canary middleware-to-proxy .`**

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

**Note:** `opennextjs-cloudflare build` runs your **`package.json`** **`build`** script (`next build --webpack`) internally, then generates **`.open-next/`**. This repo uses **`middleware.ts`** so that step passes on Cloudflare; **`proxy.ts`** still trips OpenNext’s Node-middleware guard until [#1082](https://github.com/opennextjs/opennextjs-cloudflare/issues/1082).

---

## Separate Worker: MCP bridge ([`workers-mcp`](https://github.com/cloudflare/workers-mcp))

The repo also includes **`workers-mcp/`**, a **small standalone Worker** (not the OpenNext app) used to expose MCP tools via the official [`workers-mcp`](https://github.com/cloudflare/workers-mcp) proxy pattern. Official guidance now prefers **remote** MCP + [`mcp-remote`](https://developers.cloudflare.com/agents/guides/test-remote-mcp-server/); this layout still matches Cloudflare’s original “stdio proxy + Worker” tooling.

### One-time setup

1. **`cd workers-mcp`**
2. **`bun install`**
3. Create **`.dev.vars`** from `.dev.vars.example` and set a long random **`SHARED_SECRET`** (or run **`bunx workers-mcp secret generate`** if you prefer the bundled helper once you verify it works in your toolchain).
4. Upload the same secret for production:

   **`bunx wrangler secret put SHARED_SECRET --config ./wrangler.toml`**

   (Paste the hex value when prompted.)

5. Deploy:

   **`bun run deploy`**

   The URL will look like **`https://web-ble-monitor-mcp.<your-subdomain>.workers.dev`**. Rename **`name`** in `workers-mcp/wrangler.toml` if that Worker name clashes with another in your Cloudflare account.

**Why `--config ./wrangler.toml`?** Wrangler walks up directories; without an explicit **`--config`**, it could pick the root **`wrangler.jsonc`** (OpenNext) and fail.

### Cursor MCP entry

This repo commits **`.cursor/mcp.json`** (project scope). Cursor expands **`${workspaceFolder}`** and **`${env:CF_WORKERS_MCP_URL}`** in MCP configs on recent Cursor builds.

1. **`cd workers-mcp && bun install`**
2. Complete Worker deploy + **`SHARED_SECRET`** steps above. Copy the **`https://…workers.dev`** URL from **`bun run deploy`** output (or Workers dashboard → your Worker → URL).

3. Set **`CF_WORKERS_MCP_URL`** to that HTTPS URL wherever Cursor inherits environment from (macOS launch environment, shell profile used to launch Cursor, or Cursor **Settings** environment-variable UI for your Cursor version):

   **`CF_WORKERS_MCP_URL=https://web-ble-monitor-mcp.<your-account-subdomain>.workers.dev`**

4. Fully **restart Cursor**.

If **`${workspaceFolder}`** fails to expand inside **`command`**, use **Settings → MCP → Add server** and paste **one** line matching the README form:

```text
<repo>/workers-mcp/node_modules/.bin/workers-mcp run web-ble-monitor-mcp https://web-ble-monitor-mcp.<subdomain>.workers.dev <repo>/workers-mcp
```

Restart Cursor after you change Worker tool names or JSDoc signatures.

### Claude Desktop

From **`workers-mcp/`**: **`bunx workers-mcp setup`** (interactive: docgen wiring, **`SHARED_SECRET`**, deploy, Claude config). **`bunx workers-mcp help`** if something breaks.

### Remote MCP note

Cloudflare recommends **remote** MCP + **`mcp-remote`** for new work ([Agents guide](https://developers.cloudflare.com/agents/guides/test-remote-mcp-server/)); this **`workers-mcp`** layout stays the upstream **stdio proxy + Worker RPC** approach.

Official references:

- [workers-mcp repository](https://github.com/cloudflare/workers-mcp)
- Cloudflare Agents: [**Remote MCP**](https://developers.cloudflare.com/agents/guides/remote-mcp-server/) (recommended path forward)

---

## Cloudflare MCP (Workers Builds + Observability)

For debugging **[Workers Builds](https://github.com/cloudflare/mcp-server-cloudflare)** (dashboard CI logs, failing steps) and **runtime logs/analytics**, this repo commits **`.cursor/mcp.json`** entries that run Cloudflare’s remote MCP URLs through **`mcp-remote`** ([npm](https://www.npmjs.com/package/mcp-remote)), matching [Cloudflare’s docs](https://github.com/cloudflare/mcp-server-cloudflare):

| Cursor server id | Endpoint |
|------------------|----------|
| `cloudflare-workers-builds` | `https://builds.mcp.cloudflare.com/mcp` |
| `cloudflare-workers-observability` | `https://observability.mcp.cloudflare.com/mcp` |

After adding or changing MCP config, **restart Cursor**. First use triggers **OAuth in the browser**; grant access, then tools such as **`workers_builds_list_builds`**, **`workers_builds_get_build_logs`**, and observability queries work against your account.

Tip: combine with **`workers_builds_set_active_worker`** targeting **`web-ble-monitor`** (see `wrangler.jsonc` **`name`**).

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
