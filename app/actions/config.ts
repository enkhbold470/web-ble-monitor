"use server";

import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  verifyAdminCredentials,
} from "@/lib/auth-credentials";
import {
  clearSessionCookie,
  isAuthenticatedSession,
  setSessionCookie,
} from "@/lib/auth-session";
import { headers } from "next/headers";

class AdminActionError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "AdminActionError";
  }
}

async function getRequestIp(): Promise<string> {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return (
    headerStore.get("cf-connecting-ip") ||
    headerStore.get("x-real-ip") ||
    "unknown"
  );
}

export async function authenticateAdmin(formData: FormData) {
  const ip = await getRequestIp();
  const rateLimit = checkLoginRateLimit(ip);
  if (!rateLimit.allowed) {
    throw new AdminActionError(
      "Too many login attempts. Try again later.",
      "RATE_LIMITED",
    );
  }

  const username = formData.get("username");
  const password = formData.get("password");

  if (typeof username !== "string" || typeof password !== "string") {
    throw new AdminActionError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  if (!verifyAdminCredentials(username, password)) {
    throw new AdminActionError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  clearLoginRateLimit(ip);
  await setSessionCookie();
  return { success: true };
}

export async function logout() {
  await clearSessionCookie();
  return { success: true };
}

export async function isAuthenticated() {
  return isAuthenticatedSession();
}
