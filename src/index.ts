export interface Env {
  NOTES: KVNamespace
  WRITE_LIMIT: RateLimit
  NOTE_TTL_SECONDS?: string
}

const WRITE_RETRY_AFTER_SECONDS = 60

/** 23 lowercase letters, excluding l, o, i. */
const AUTO_ALPHABET = 'abcdefghjkmnpqrstuvwxyz'
const AUTO_ID_LENGTH = 6
const MAX_ID_LENGTH = 64
const ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 1_048_576 // 1 MiB
const DEFAULT_TTL_SECONDS = 2_592_000 // 30 days
const KV_MIN_TTL = 60

function noteTtl(env: Env): number {
  const parsed = Number(env.NOTE_TTL_SECONDS)
  if (!Number.isFinite(parsed) || parsed < KV_MIN_TTL) {
    return DEFAULT_TTL_SECONDS
  }
  return Math.floor(parsed)
}

function randomAutoId(): string {
  let id = ''
  const n = AUTO_ALPHABET.length // 23
  // 253 = 11 * 23, rejection sampling avoids modulo bias
  while (id.length < AUTO_ID_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    for (const b of bytes) {
      if (b >= 253) continue
      id += AUTO_ALPHABET[b % n]
      if (id.length === AUTO_ID_LENGTH) break
    }
  }
  return id
}

async function allocateAutoId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = randomAutoId()
    const existing = await env.NOTES.get(id)
    if (existing === null) {
      await env.NOTES.put(id, '', { expirationTtl: noteTtl(env) })
      return id
    }
  }
  throw new Error('Could not allocate a unique note id')
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function prefersChinese(request: Request): boolean {
  const accept = request.headers.get('accept-language') ?? ''
  return accept.toLowerCase().includes('zh')
}

function editorPage(id: string, content: string, chinese: boolean): string {
  const lang = chinese ? 'zh' : 'en'
  const placeholder = chinese ? '写点什么...' : 'Write something...'
  const helpLabel = chinese ? '如何使用' : 'How to use'
  const syncLabels = chinese
    ? { unsynced: '未同步', syncing: '同步中', synced: '已同步' }
    : { unsynced: 'Unsynced', syncing: 'Syncing', synced: 'Synced' }
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(id)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background-color:#fff;background-image:linear-gradient(to bottom in oklab,color-mix(in oklab,#bedbff 5%,transparent),color-mix(in oklab,#eff6ff 10%,transparent))}
  .bg{pointer-events:none;position:fixed;inset:0;width:100%;height:100%;fill:#3080ff80;stroke:#3080ff80;opacity:.2;-webkit-mask-image:linear-gradient(to bottom,#ffffffad,transparent);mask-image:linear-gradient(to bottom,#ffffffad,transparent)}
  textarea{position:absolute;inset:1.6rem 1.6rem 3.2rem;box-sizing:border-box;border:1px solid color-mix(in oklab,#bedbff 80%,transparent);border-radius:2px;outline:none;resize:none;padding:1.65rem 2rem 1.35rem 1.35rem;overflow:auto;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#111;background:#fff}
  .sync{position:absolute;top:calc(1.6rem + .5rem);right:calc(1.6rem + .5rem);width:14px;height:14px;color:#c4c4c4;z-index:1;pointer-events:none}
  .sync svg{display:block;width:100%;height:100%}
  .sync .i{display:none}
  .sync[data-state="unsynced"] .unsynced,.sync[data-state="syncing"] .syncing,.sync[data-state="synced"] .synced{display:block}
  .sync[data-state="syncing"]{color:#8aa4c8}
  .sync[data-state="syncing"] svg{animation:spin .8s linear infinite;transform-origin:center}
  .sync[data-state="synced"]{color:#9aaa9a}
  .help{position:absolute;left:0;right:0;bottom:0;height:3.2rem;display:flex;align-items:center;justify-content:center;box-sizing:border-box;font:12px/1 system-ui,-apple-system,sans-serif}
  .help a{color:#bbb;text-decoration:none}
  .help a:hover{color:#666}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<svg class="bg" aria-hidden="true"><defs><pattern id="g" width="6" height="6" patternUnits="userSpaceOnUse" x="-1" y="-1"><path d="M.5 6V.5H6" fill="none"></path></pattern></defs><rect width="100%" height="100%" stroke-width="0" fill="url(#g)"></rect></svg>
<span id="s" class="sync" data-state="synced" role="status" aria-live="polite" title="${syncLabels.synced}" aria-label="${syncLabels.synced}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle class="i unsynced" cx="8" cy="8" r="5"/><path class="i syncing" d="M13 8a5 5 0 1 1-5-5"/><path class="i synced" stroke-linejoin="round" d="M4 8.5 6.5 11 12 4.5"/></svg></span>
<textarea id="n" spellcheck="false" autofocus placeholder="${placeholder}">${escapeHtml(content)}</textarea>
<nav class="help"><a href="/help">${helpLabel}</a></nav>
<script>
(() => {
  const el = document.getElementById("n");
  const icon = document.getElementById("s");
  const labels = ${JSON.stringify(syncLabels)};
  let timer = 0, inflight = false, queued = false, dirty = false;
  const setState = (state) => {
    icon.dataset.state = state;
    icon.setAttribute("title", labels[state]);
    icon.setAttribute("aria-label", labels[state]);
  };
  const save = () => {
    if (inflight) { queued = true; return; }
    inflight = true;
    setState("syncing");
    const sent = el.value;
    fetch(location.pathname, {
      method: "PUT",
      body: sent,
      headers: { "content-type": "text/plain;charset=utf-8" },
      keepalive: true,
    }).then((res) => {
      if (!res.ok) throw new Error("save failed");
      if (el.value === sent) dirty = false;
    }).catch(() => {
      dirty = true;
    }).finally(() => {
      inflight = false;
      if (queued) { queued = false; save(); return; }
      setState(dirty ? "unsynced" : "synced");
    });
  };
  el.addEventListener("input", () => {
    dirty = true;
    if (!inflight) setState("unsynced");
    clearTimeout(timer);
    timer = setTimeout(save, 800);
  });
})();
</script>
</body>
</html>`
}

function clientIp(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  const fromCf = request.cf && typeof request.cf === 'object' && 'clientIp' in request.cf ? String((request.cf as { clientIp?: unknown }).clientIp ?? '') : ''
  return fromCf || 'local'
}

function tooManyRequests(): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(WRITE_RETRY_AFTER_SECONDS),
      'cache-control': 'no-store',
    },
  })
}

function parseNoteId(pathname: string): string | null {
  if (pathname.length < 2 || pathname.includes('/', 1)) return null
  const id = pathname.slice(1)
  if (id === 'help') return null
  if (id.length > MAX_ID_LENGTH || !ID_PATTERN.test(id)) return null
  return id
}

function helpPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How to use / 如何使用</title>
<style>
  html,body{margin:0;background:#fff;color:#111}
  main{max-width:40rem;margin:0 auto;padding:2rem 1.25rem 3rem;font:16px/1.55 system-ui,-apple-system,sans-serif}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .75rem}
  h2{font-size:1rem;font-weight:600;margin:2rem 0 .7rem}
  li{margin:.4rem 0}
  ul{padding-left:1.2rem}
  code,pre{font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  code{background:#f5f5f5;padding:.1em .35em;border-radius:4px}
  pre{background:#f5f5f5;padding:.85rem 1rem;border-radius:6px;overflow:auto}
</style>
</head>
<body>
<main>
<section lang="zh">
<h1>如何使用</h1>
<ul>
<li>打开 <code>/</code> 会新建一条随机笔记并跳转过去。</li>
<li>自定义路径即笔记 id，须匹配 <code>[a-z0-9_-]{1,64}</code>，例如 <code>/meeting-notes</code>。</li>
<li>编辑器会在输入后自动保存（约 800ms 防抖）。</li>
<li><code>GET /:id?raw=1</code> 返回纯文本。</li>
<li>也可用 curl 写入：<code>PUT</code> 或 <code>POST</code>。</li>
<li>约 30 天 TTL，每次保存刷新（<code>NOTE_TTL_SECONDS</code>）。</li>
<li>单次写入上限约 1MiB。</li>
<li>无密码、无目录、无列表。知道 URL 即可读写。</li>
</ul>
</section>
<section lang="en">
<h2>How to use</h2>
<ul>
<li>Opening <code>/</code> creates a random new note and redirects to it.</li>
<li>A custom path is the note id: <code>[a-z0-9_-]{1,64}</code>, e.g. <code>/meeting-notes</code>.</li>
<li>The editor autosaves as you type (about 800ms debounce).</li>
<li><code>GET /:id?raw=1</code> returns plain text.</li>
<li>Write with curl via <code>PUT</code> or <code>POST</code>.</li>
<li>~30 day TTL, refreshed on last save (<code>NOTE_TTL_SECONDS</code>).</li>
<li>~1MiB write limit.</li>
<li>No password, no list. Anyone with the URL can read and write.</li>
</ul>
</section>
<pre>curl -sI "$HOST/" | grep -i ^location
curl -s -o /dev/null -w "%{http_code}\\n" -X PUT --data-binary 'hello' "$HOST/scratch"
curl -s "$HOST/scratch?raw=1"</pre>
</main>
</body>
</html>`
}

function noStore(contentType: string, extra?: HeadersInit): Headers {
  return new Headers({
    'content-type': contentType,
    'cache-control': 'no-store',
    ...extra,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method.toUpperCase()

    if (pathname === '/') {
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        })
      }
      const id = await allocateAutoId(env)
      return new Response(null, {
        status: 302,
        headers: { Location: `/${id}`, 'cache-control': 'no-store' },
      })
    }

    if (pathname === '/help') {
      if (method !== 'GET' && method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        })
      }
      const html = helpPage()
      return new Response(method === 'HEAD' ? null : html, {
        status: 200,
        headers: noStore('text/html; charset=utf-8'),
      })
    }

    const id = parseNoteId(pathname)
    if (!id) {
      return new Response('Not Found', { status: 404 })
    }

    if (method === 'GET' || method === 'HEAD') {
      const text = (await env.NOTES.get(id)) ?? ''
      if (url.searchParams.get('raw') === '1') {
        return new Response(method === 'HEAD' ? null : text, {
          status: 200,
          headers: noStore('text/plain; charset=utf-8'),
        })
      }
      const html = editorPage(id, text, prefersChinese(request))
      return new Response(method === 'HEAD' ? null : html, {
        status: 200,
        headers: noStore('text/html; charset=utf-8'),
      })
    }

    if (method === 'PUT' || method === 'POST') {
      const { success } = await env.WRITE_LIMIT.limit({ key: clientIp(request) })
      if (!success) {
        return tooManyRequests()
      }
      const buf = await request.arrayBuffer()
      if (buf.byteLength > MAX_BODY_BYTES) {
        return new Response('Payload Too Large', { status: 413 })
      }
      const body = new TextDecoder().decode(buf)
      await env.NOTES.put(id, body, { expirationTtl: noteTtl(env) })
      return new Response(null, { status: 204 })
    }

    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD, PUT, POST' },
    })
  },
}
