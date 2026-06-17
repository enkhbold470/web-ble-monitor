import { cookies } from "next/headers";

const SESSION_COOKIE = "admin-session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 8;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function getSessionSecret(): string {
  if (process.env.NODE_ENV === "production") {
    return requireEnv("SESSION_SECRET");
  }

  return process.env.SESSION_SECRET?.trim() || "dev-only-change-me-before-deploy";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signPayload(payload: string): Promise<string> {
  const key = await importHmacKey(getSessionSecret());
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifySignature(
  payload: string,
  signature: string,
): Promise<boolean> {
  try {
    const key = await importHmacKey(getSessionSecret());
    return crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

export async function createSessionToken(): Promise<string> {
  const payload = JSON.stringify({
    sub: "admin",
    exp: Date.now() + SESSION_MAX_AGE_SEC * 1000,
    v: 1,
  });
  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(payload));
  const signature = await signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string): Promise<boolean> {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const validSignature = await verifySignature(encodedPayload, signature);
  if (!validSignature) {
    return false;
  }

  try {
    const payloadBytes = base64UrlToBytes(encodedPayload);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as {
      sub?: string;
      exp?: number;
      v?: number;
    };

    if (payload.sub !== "admin" || payload.v !== 1) {
      return false;
    }

    if (!payload.exp || Date.now() > payload.exp) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function setSessionCookie(): Promise<void> {
  const token = await createSessionToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function isAuthenticatedSession(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!session) {
    return false;
  }
  return verifySessionToken(session);
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
