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

const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 5_000;

export function validateJsonStructure(val: unknown, depth = 1, counter = { count: 0 }): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new HttpError(400, "JSON nesting depth exceeded (max 20)");
  }
  counter.count++;
  if (counter.count > MAX_JSON_NODES) {
    throw new HttpError(400, "JSON node count exceeded (max 5000)");
  }
  if (val !== null && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        validateJsonStructure(val[i], depth + 1, counter);
      }
    } else {
      const keys = Object.keys(val as Record<string, unknown>);
      for (let i = 0; i < keys.length; i++) {
        validateJsonStructure((val as Record<string, unknown>)[keys[i]], depth + 1, counter);
      }
    }
  }
}

export async function readJson(req: Request, maxBytes = 32_768): Promise<Record<string, unknown>> {
  const clHeader = req.headers.get("content-length");
  if (clHeader !== null) {
    const cl = parseInt(clHeader, 10);
    if (!Number.isNaN(cl) && cl > maxBytes) {
      throw new HttpError(413, "Request body too large");
    }
  }

  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore cancel errors */ }
          throw new HttpError(413, "Request body too large");
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
    } catch {
      throw new HttpError(400, "Body must be valid UTF-8 JSON");
    }
  } else {
    text = await req.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new HttpError(413, "Request body too large");
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Body must be a JSON object");
  }

  validateJsonStructure(parsed);
  return parsed as Record<string, unknown>;
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
