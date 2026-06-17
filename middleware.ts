import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applySecurityHeaders } from "@/lib/security-headers";

const ALLOWED_ADMIN_HOSTS = new Set(
  (process.env.ADMIN_ALLOWED_HOSTS || "localhost:3000,127.0.0.1:3000")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
);

function isAllowedAdminHost(host: string): boolean {
  if (ALLOWED_ADMIN_HOSTS.has(host)) {
    return true;
  }

  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) {
    return true;
  }

  return false;
}

function withSecurityHeaders(response: NextResponse): NextResponse {
  applySecurityHeaders(response, process.env.NODE_ENV === "production");
  return response;
}

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/admin")) {
    const host = request.headers.get("host") || "";
    if (!isAllowedAdminHost(host)) {
      return withSecurityHeaders(
        NextResponse.redirect(new URL("/", request.url)),
      );
    }
  }

  return withSecurityHeaders(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
