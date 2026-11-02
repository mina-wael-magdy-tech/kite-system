// Shared HTTP helpers for Edge Functions: strict CORS, uniform JSON, safe errors.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Comma-separated list of exact origins allowed to call the functions, e.g.
//   supabase secrets set ALLOWED_ORIGINS="https://studio.example.com"
// If unset, no browser origin is allowed (fail closed).
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function readJson(req: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body too large");
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

// Wraps a handler: CORS preflight, POST-only, and error mapping.
// HttpError messages are returned to the client; anything else is logged
// server-side and replaced by a generic message (no internals leak).
export function serveJson(handler: (req: Request) => Promise<Response>) {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return json(req, { error: err.message }, err.status);
      console.error("Unhandled error:", err);
      return json(req, { error: "Internal server error" }, 500);
    }
  });
}
