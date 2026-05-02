import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Root interceptor for OpenNext (@opennextjs/cloudflare): emits Edge middleware in the Next
 * manifest, which passes OpenNext's build check. **`proxy.ts` + Node proxy** breaks `cf:*`
 * today — see docs/cloudflare-wrangler.md and opennextjs-cloudflare#1082.
 *
 * Next 16 deprecation warning (“use proxy instead”) is expected until upstream supports Proxy.
 */
export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/admin")) {
    const host = request.headers.get("host") || "";
    const isAllowedHost =
      host.startsWith("localhost:3000") || host === "nf-next-ble.vercel.app";

    if (!isAllowedHost) {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico).*)",
  ],
};
