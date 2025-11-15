import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Check if user is accessing /admin route
  if (request.nextUrl.pathname.startsWith('/admin')) {
    // Get the host from the request
    const host = request.headers.get('host') || ''
    
    // Allow access if on localhost:3000 or nf-next-ble.vercel.app
    const isAllowedHost = host.startsWith('localhost:3000') || host === 'nf-next-ble.vercel.app'
    
    if (!isAllowedHost) {
      // Block access to admin routes for non-allowed hosts
      return NextResponse.redirect(new URL('/', request.url))
    }
  }

  // Allow all other routes
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}
