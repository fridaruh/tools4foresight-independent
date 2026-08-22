import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, createSessionCookieValue, isValidAdminPassword } from "@/lib/admin-session";
import { isRateLimited, requestIp } from "@/lib/rate-limit";

function safeRedirectPath(from: FormDataEntryValue | null): string {
  return typeof from === "string" && from.startsWith("/") ? from : "/";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const from = safeRedirectPath(formData.get("from"));

  if (isRateLimited(`login:${requestIp(request)}`)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "rate_limited");
    if (from !== "/") url.searchParams.set("from", from);
    return NextResponse.redirect(url, { status: 303 });
  }

  const password = formData.get("password");
  if (typeof password !== "string" || !isValidAdminPassword(password)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "1");
    if (from !== "/") url.searchParams.set("from", from);
    return NextResponse.redirect(url, { status: 303 });
  }

  const response = NextResponse.redirect(new URL(from, request.url), { status: 303 });
  response.cookies.set(ADMIN_SESSION_COOKIE, createSessionCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return response;
}
