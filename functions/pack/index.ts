// GET /pack?username=foo — form-target dispatcher.
//
// The landing form (public/index.html) submits GET to /pack with a
// `username` query parameter. This handler validates the username shape
// and 303-redirects to /pack/<username> so the visitor lands on a clean,
// shareable URL.

import type { Env } from "../../src/env";
import { isValidUsername } from "../../src/github";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const raw = url.searchParams.get("username");
  if (!raw || !isValidUsername(raw)) {
    // Bounce back to the landing page on missing or malformed input. The
    // form has client-side `pattern=` so this path is unusual; serving
    // the landing is still correct UX.
    return Response.redirect(`${url.origin}/`, 303);
  }
  return Response.redirect(`${url.origin}/pack/${raw}`, 303);
};
