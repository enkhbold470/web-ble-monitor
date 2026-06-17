const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

type RateLimitRecord = { count: number; resetAt: number };

const loginAttempts = new Map<string, RateLimitRecord>();

function getClientKey(ip: string): string {
  return `login:${ip}`;
}

export function checkLoginRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  const key = getClientKey(ip);
  const now = Date.now();
  const record = loginAttempts.get(key);

  if (!record || now > record.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((record.resetAt - now) / 1000),
    };
  }

  record.count += 1;
  return { allowed: true };
}

export function clearLoginRateLimit(ip: string): void {
  loginAttempts.delete(getClientKey(ip));
}

function timingSafeEqual(a: string, b: string): boolean {
  const aLen = a.length;
  const bLen = b.length;
  const maxLen = Math.max(aLen, bLen);
  let mismatch = aLen ^ bLen;

  for (let i = 0; i < maxLen; i += 1) {
    const aCode = i < aLen ? a.charCodeAt(i) : 0;
    const bCode = i < bLen ? b.charCodeAt(i) : 0;
    mismatch |= aCode ^ bCode;
  }

  return mismatch === 0;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function getAdminPassword(): string {
  if (process.env.NODE_ENV === "production") {
    return requireEnv("ADMIN_PASSWORD");
  }

  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error("ADMIN_PASSWORD must be set");
  }
  return password;
}

export function verifyAdminCredentials(
  username: string,
  password: string,
): boolean {
  if (username !== "admin") {
    return false;
  }

  try {
    return timingSafeEqual(password, getAdminPassword());
  } catch {
    return false;
  }
}
