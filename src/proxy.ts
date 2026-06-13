import NextAuth from "next-auth";
import authConfig from "./auth.config";

const { auth } = NextAuth(authConfig);

// Next.js 16 renamed `middleware.ts` → `proxy.ts`. NextAuth's edge-safe
// `auth` export doubles as the proxy handler: it reads the session cookie,
// runs the `authorized` callback from auth.config, and redirects to /signin.
export default auth;

// Match the dashboard and the user-authed API surface. /api/ingest/* is
// deliberately excluded — it's a public webhook receiver authenticated by
// HMAC, not session cookie. /api/auth/* is NextAuth's own handler and must
// be excluded for the same reason. Any new authed API namespace should be
// added here.
export const config = {
  matcher: [
    "/overview/:path*",
    "/overview",
    "/sources/:path*",
    "/events/:path*",
    "/destinations/:path*",
    "/routes/:path*",
    "/settings/:path*",
    "/api/events/:path*",
    "/api/account/:path*",
  ],
};
