const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-DNS-Prefetch-Control": "off",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
};

export const PRODUCTION_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

export function applySecurityHeaders(
  response: Response,
  isProduction = process.env.NODE_ENV === "production",
): void {
  const headers = isProduction ? PRODUCTION_SECURITY_HEADERS : SECURITY_HEADERS;
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
}
