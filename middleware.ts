import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applySecurityHeaders } from "@/lib/security-headers";

export function middleware(_request: NextRequest) {
  const response = NextResponse.next();
  applySecurityHeaders(response, process.env.NODE_ENV === "production");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
