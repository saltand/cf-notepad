export interface Env {
  NOTES: KVNamespace;
  WRITE_LIMIT: RateLimit;
  NOTE_TTL_SECONDS?: string;
}

const WRITE_RETRY_AFTER_SECONDS = 60;

/** 23 lowercase letters, excluding l, o, i. */
const AUTO_ALPHABET = "abcdefghjkmnpqrstuvwxyz";
const AUTO_ID_LENGTH = 6;
const MAX_ID_LENGTH = 64;
const ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 1_048_576; // 1 MiB
const DEFAULT_TTL_SECONDS = 2_592_000; // 30 days
const KV_MIN_TTL = 60;

function noteTtl(env: Env): number {
  const parsed = Number(env.NOTE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < KV_MIN_TTL) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.floor(parsed);
}

function randomAutoId(): string {
  let id = "";
  const n = AUTO_ALPHABET.length; // 23
  // 253 = 11 * 23, rejection sampling avoids modulo bias
  while (id.length < AUTO_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const b of bytes) {
      if (b >= 253) continue;
      id += AUTO_ALPHABET[b % n];
      if (id.length === AUTO_ID_LENGTH) break;
    }
  }
  return id;
}

async function allocateAutoId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = randomAutoId();
    const existing = await env.NOTES.get(id);
    if (existing === null) {
      await env.NOTES.put(id, "", { expirationTtl: noteTtl(env) });
      return id;
    }
  }
  throw new Error("Could not allocate a unique note id");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function editorPage(id: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(id)}</title>
<style>
  html,body{margin:0;height:100%;background:#fff}
  textarea{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;border:1px solid #e5e5e5;outline:none;resize:none;padding:1.35rem;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111;background:#fff}
</style>
</head>
<body>
<textarea id="n" spellcheck="false" autofocus>${escapeHtml(content)}</textarea>
<script>
(() => {
  const el = document.getElementById("n");
  let timer = 0, inflight = false, queued = false;
  const save = () => {
    if (inflight) { queued = true; return; }
    inflight = true;
    fetch(location.pathname, {
      method: "PUT",
      body: el.value,
      headers: { "content-type": "text/plain;charset=utf-8" },
      keepalive: true,
    }).finally(() => {
      inflight = false;
      if (queued) { queued = false; save(); }
    });
  };
  el.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });
})();
</script>
</body>
</html>`;
}

function clientIp(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const fromCf = request.cf && typeof request.cf === "object" && "clientIp" in request.cf
    ? String((request.cf as { clientIp?: unknown }).clientIp ?? "")
    : "";
  return fromCf || "local";
}

function tooManyRequests(): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(WRITE_RETRY_AFTER_SECONDS),
      "cache-control": "no-store",
    },
  });
}

function parseNoteId(pathname: string): string | null {
  if (pathname.length < 2 || pathname.includes("/", 1)) return null;
  const id = pathname.slice(1);
  if (id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) return null;
  return id;
}

function noStore(contentType: string, extra?: HeadersInit): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    ...extra,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (pathname === "/") {
      if (method !== "GET" && method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      const id = await allocateAutoId(env);
      return new Response(null, {
        status: 302,
        headers: { Location: `/${id}`, "cache-control": "no-store" },
      });
    }

    const id = parseNoteId(pathname);
    if (!id) {
      return new Response("Not Found", { status: 404 });
    }

    if (method === "GET" || method === "HEAD") {
      const text = (await env.NOTES.get(id)) ?? "";
      if (url.searchParams.get("raw") === "1") {
        return new Response(method === "HEAD" ? null : text, {
          status: 200,
          headers: noStore("text/plain; charset=utf-8"),
        });
      }
      const html = editorPage(id, text);
      return new Response(method === "HEAD" ? null : html, {
        status: 200,
        headers: noStore("text/html; charset=utf-8"),
      });
    }

    if (method === "PUT" || method === "POST") {
      const { success } = await env.WRITE_LIMIT.limit({ key: clientIp(request) });
      if (!success) {
        return tooManyRequests();
      }
      const buf = await request.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) {
        return new Response("Payload Too Large", { status: 413 });
      }
      const body = new TextDecoder().decode(buf);
      await env.NOTES.put(id, body, { expirationTtl: noteTtl(env) });
      return new Response(null, { status: 204 });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, PUT, POST" },
    });
  },
};
