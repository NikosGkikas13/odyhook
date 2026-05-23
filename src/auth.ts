import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";

import authConfig from "./auth.config";
import { prisma } from "./lib/prisma";

// `@auth/prisma-adapter@2.11.x` declares Prisma client peer-compat through
// v6 only; we're on @prisma/client v7. The runtime API is compatible — only
// the generated types diverged — so the `as any` is purely a typing bridge.
// Drop the cast once @auth/prisma-adapter publishes a v7-aware release.
export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: PrismaAdapter(prisma as any),
  providers: [
    GitHub,
    Nodemailer({
      // When no SMTP credentials are set (e.g. local MailHog) use a plain URL string.
      // A string value is not deep-merged by @auth/core, so the provider default
      // auth: { user: "", pass: "" } doesn't survive and nodemailer skips PLAIN auth.
      server: process.env.EMAIL_SERVER_USER
        ? {
            host: process.env.EMAIL_SERVER_HOST,
            port: Number(process.env.EMAIL_SERVER_PORT ?? 1025),
            // Port 465 requires implicit TLS; 587/1025 use STARTTLS.
            secure: Number(process.env.EMAIL_SERVER_PORT) === 465,
            auth: {
              user: process.env.EMAIL_SERVER_USER,
              pass: process.env.EMAIL_SERVER_PASSWORD,
            },
          }
        : `smtp://${process.env.EMAIL_SERVER_HOST}:${process.env.EMAIL_SERVER_PORT ?? 1025}`,
      from: process.env.EMAIL_FROM,
    }),
  ],
});
