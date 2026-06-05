import type { NextAuthConfig } from "next-auth";

// Edge-safe config shared between full auth.ts (with Prisma adapter)
// and middleware.ts (no adapter, cookie-only check).
export default {
  providers: [],
  pages: {
    signIn: "/signin",
    verifyRequest: "/signin/verify",
  },
  // JWT sessions can't be revoked server-side (only AUTH_SECRET rotation
  // invalidates them), so cap the lifetime well below NextAuth's 30-day default
  // to bound a stolen token's usefulness. A jti/token-version deny-list for
  // forced logout remains a possible follow-up.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 },
  callbacks: {
    authorized({ auth }) {
      return !!auth?.user;
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
