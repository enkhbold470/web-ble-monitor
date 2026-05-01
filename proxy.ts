import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Next.js 16 request proxy (same role as deprecated middleware.ts).
 * Export must be named `proxy` when using this file name.
 */
export function proxy(request: NextRequest) {
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
