import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Edge middleware (legacy file name). @opennextjs/cloudflare does not support
 * Next.js 16 `proxy.ts` yet; see https://github.com/opennextjs/opennextjs-cloudflare/issues/1082
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
