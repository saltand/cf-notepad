# cf-notepad

Minimalist self-hostable notepad on [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [KV](https://developers.cloudflare.com/kv/). Inspired by [minimalist-web-notepad](https://github.com/pereorga/minimalist-web-notepad).

The path **is** the note. Anyone with the URL can read and write. There is no login, list, search, history, or Markdown.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/saltand/cf-notepad)

## Behaviour

| Request | Result |
| --- | --- |
| `GET /` | `302` to a new random note id |
| `GET /:id` | Full-page textarea (blank notes are fine) |
| `GET /:id?raw=1` | `text/plain; charset=utf-8` (empty string if missing) |
| `PUT` / `POST /:id` | Save raw body, `204` |
| Body larger than ~1 MiB | `413` |
| Id not matching `[a-z0-9_-]{1,64}` | `404` |

Random ids are **exactly 6 lowercase letters** from a 23-letter alphabet that **excludes `l`, `o`, and `i`**. Collisions retry. Custom paths such as `/meeting-notes` are allowed if they match the pattern above.

Each save writes to KV with `expirationTtl` from `NOTE_TTL_SECONDS` (default **2592000** = 30 days). Saving again renews the TTL.

The editor debounce-autosaves on input. There is almost no chrome: white page, one textarea.

## Local development

Requires Node.js 18+ and npm.

```bash
npm install
npx wrangler dev
```

Open http://127.0.0.1:8787 — you should be redirected to `/` plus a 6-letter id. Local KV is simulated; data lives under `.wrangler/` and is not your production namespace.

Optional smoke checks (with `wrangler dev` running):

```bash
npm run check
```

## Create KV and deploy

1. Log in: `npx wrangler login`
2. Create a namespace:

   ```bash
   npx wrangler kv namespace create NOTES
   ```

3. Copy the printed id into `wrangler.toml`:

   ```toml
   [[kv_namespaces]]
   binding = "NOTES"
   id = "<NAMESPACE_ID>"
   ```

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

The Worker name is `cf-notepad` (see `wrangler.toml`). After deploy, notes are at `https://cf-notepad.<your-subdomain>.workers.dev/<id>`.

## Environment variables

Set in `wrangler.toml` under `[vars]`, or override in the Cloudflare dashboard.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTE_TTL_SECONDS` | `2592000` | KV expiration TTL in seconds, applied on every write. Must be ≥ 60 (KV minimum). |

## curl examples

Assume the Worker is at `$HOST` (local: `http://127.0.0.1:8787`).

```bash
# New note (follow redirect; print the id)
curl -sI "$HOST/" | grep -i ^location

# Save with POST (curl -d defaults to POST)
curl -s -o /dev/null -w "%{http_code}\n" -d 'hello from curl' "$HOST/scratch"

# Save with PUT and keep exact bytes (newlines, etc.)
curl -s -o /dev/null -w "%{http_code}\n" -X PUT --data-binary $'line 1\nline 2\n' "$HOST/scratch"

# Read plain text
curl -s "$HOST/scratch?raw=1"

# Open the editor HTML
curl -s "$HOST/scratch" | head
```

Expected: `GET /` → `302` and `Location: /` + six letters from `abcdefghjkmnpqrstuvwxyz`. `PUT`/`POST` → `204`. Invalid ids such as `/Nope` or `/a.b` → `404`.

## Stack

One TypeScript Worker (`src/index.ts`) serves the HTML/CSS/JS editor and talks to the `NOTES` KV binding. No framework, no build step beyond Wrangler.

## Notes

- URLs are shareable read/write. Treat ids as secrets if the content is private.
- Workers KV is eventually consistent; two tabs saving at once can race.
- This is not a backup system. Expired keys are gone.
