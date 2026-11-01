import { NextResponse } from "next/server";

export function GET() {
  const configured = process.env.CALARI_PORTAL_URL;
  if (!configured)
    return new Response("Calari portal sign-in is not configured.", {
      status: 503,
    });
  try {
    const url = new URL(configured);
    if (
      (url.protocol !== "https:" &&
        !(process.env.NODE_ENV !== "production" && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid portal URL");
    return NextResponse.redirect(url, 307);
  } catch {
    return new Response("Calari portal sign-in is not configured.", {
      status: 503,
    });
  }
}
