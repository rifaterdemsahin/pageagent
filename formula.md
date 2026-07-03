# PageAgent — `formula.md`

> How this project was built, **why** each decision was made, and how to reproduce it end-to-end.
> Companion to the code; for open gaps see [`TODO.md`](./TODO.md).

---

## 0. The brief

Turn the "open-sourced PageAgent" pitch into a **working proof of concept** and ship it:

1. A drop-in JS agent that controls a webpage with natural language (one `<script>` line).
2. A convincing live demo.
3. A real deployment that uses an **LLM (DeepSeek)** — with the **key kept safe**.
4. Publish to GitHub (`rifaterdemsahin/pageagent`) and host it on **fly.io**, with the
   GitHub Pages URL redirecting to fly.

---

## 1. The agent, in one loop

```
user command
   │
   ▼
Planner ──► [action, action, …]          (local NLU regex  OR  LLM via function-calling)
   │
   ▼
for each action:
   Element finder (score every visible interactive node) ──► best match
   highlight + scrollIntoView
   execute: click / type / select / scroll / wait   (dispatch native DOM events)
   announce (aria-live) + optional TTS
```

Two execution modes for the planner:

- **Browser-direct** (`config.llm.{provider,apiKey}`) — dev only.
- **Server-proxy** (`config.llm.proxy = '/api/plan'`) — prod. The browser POSTs
  `{ command, elements }`, the server adds the key and calls DeepSeek. **This is what fly runs.**

---

## 2. Design decisions & the reasoning behind each

| Decision | Why |
|---|---|
| **One file, zero deps** (`pageagent.js`) | Honours the "one line of code" promise; no build step, no framework lock-in, trivial to audit. |
| **Local NLU first, LLM second** | Works offline & for free; the LLM is an upgrade, not a requirement. When the LLM is used it receives only a **compact snapshot of interactive elements** — never raw HTML, never screenshots. Cheaper *and* more private than vision agents. |
| **Scoring-based element finder** (not CSS selectors) | Robust to layout/text drift. It combines `aria-label`, text, placeholder, `name`, `id`, and an explicit `data-pa` developer hint, then ranks by substring/word overlap. The `data-pa` attribute is the deterministic escape hatch. |
| **Native event dispatch** (`input`/`change` + React value setter) | Fills actually update React/Vue/Svelte controlled inputs, not just the DOM attribute. |
| **Event-driven public API** (`on`/`emit`: `command`, `step`, `done`, `open`, `close`) | Lets external drivers — Chrome extension, MCP server, QA scripts — observe and steer the agent. |
| **Server-side key (proxy mode)** | `TODO.md` 🔴 flagged "never ship an LLM key in the browser". The proxy is the fix; the live deploy uses it. |
| **Compact JSON plan contract** `{action,target,value}` | Model-agnostic, trivially validated, and the server can re-`JSON.parse` whatever DeepSeek returns (even with stray prose) by regex-extracting the first `[ … ]`. |

---

## 3. The parser — where the thinking got interesting

The local planner is a **regex cascade** (most-specific pattern first) preceded by a sentence
splitter. Two bugs found while testing shaped the final design:

1. **Comma splitting broke values.** Splitting naively on `,`/`and` shattered
   `fill the name with "Smith, John"`. **Fix:** mask quoted segments *before* splitting, then
   restore them per chunk.
2. **Greedy values ate the next action.** `…then fill the name with Ada Lovelace and select …`
   captured `"Ada Lovelace and select …"` as the value. **Fix:** after splitting on connectives,
   **merge a chunk back into the previous step unless it starts with an action verb**
   (`STEP_VERB`). So `Ada Lovelace and Grace` stays one value, but `… and select plan` splits.

I also added the headline demo command directly to the local planner so it works **without** an
LLM: `create a customer named Ada Lovelace with email ada@acme.io` →
`[navigate "new customer", type name="Ada Lovelace", type email="ada@acme.io"]`.

All 30+ parser cases were validated in an isolated Node harness (no DOM needed) before wiring UI.

---

## 4. The secrets flow (and why each hop)

```
Azure Key Vault  ──►  fly secret  ──►  process.env (server)  ──►  DeepSeek API
   (RBAC)            (not in image,      (server.js)             (never in browser)
                      not in git)
```

Two secrets were used, both read from vault **`dp-kv-deliverypilot`**:

- **`FLYIOTOKEN`** — authorises `flyctl` (`flyctl auth login --access-token …`).
- **`deepseek-api-key`** — set as fly secret `DEEPSEEK_API_KEY`; read by `server.js` to call DeepSeek.

**Why this chain:**
- **Key Vault** — the existing single source of truth; access gated by Azure RBAC (note: the other
  vault `convex-poc-kv` was correctly denied — least-privilege working as intended).
- **Fly secret, not a Dockerfile `ENV`** — the key is never baked into the image and never touches
  git/Docker layers. Secrets are encrypted at rest and injected at machine start.
- **Never in the browser** — a compromised page or XSS cannot exfiltrate it; the client only ever
  calls same-origin `/api/plan`.

Secrets were retrieved with `az keyvault secret show --query value -o tsv` and piped straight into
`flyctl` — **the values were never printed** to logs.

---

## 5. Why fly.io for hosting

- Serves **both** the static demo **and** the tiny Node proxy from one Docker image.
- Native, first-class **secrets**.
- Global anycast + autoscale-to-zero (cheap for a demo).
- `Dockerfile` deploy = nothing Fly-specific to learn.

Alternatives weighed: Cloudflare Pages (great for static, but the server-side key needs a Worker —
extra moving parts on the free tier), Render/Railway (no autoscale-to-zero on free).

---

## 6. Why GitHub Pages → fly.io (a redirect, not a second host)

The public link people already have is `…github.io/pageagent/`. The **real** app — with the
server-side DeepSeek proxy — lives on fly. Rather than maintain two running copies, Pages just
**redirects** to the canonical fly URL.

The redirect is a 4-line snippet at the top of `<head>`:

```html
<script>
  if (location.hostname.indexOf('github.io') !== -1)
    location.replace('https://pageagent-demo.fly.dev/' + location.hash);
</script>
```

- **Host detection** → fires only on `*.github.io`; it is a **no-op on fly.dev and localhost**.
- **`location.hash` is preserved**, so `…/pageagent/#dashboard` → `…/#dashboard` (the app's router
  reads the hash to pick the view).
- `<meta http-equiv="refresh">` + `<link rel="canonical">` cover the no-JS / SEO cases.

---

## 7. Reproduction (exact steps)

```bash
# 0. prerequisites: az, flyctl, gh  (all homebrew-installable)

# 1. Azure
az login
KV=dp-kv-deliverypilot
FLYTOKEN=$(az keyvault secret show --vault-name $KV --name FLYIOTOKEN    --query value -o tsv)
DSKEY=$(  az keyvault secret show --vault-name $KV --name deepseek-api-key --query value -o tsv)

# 2. fly.io auth + app + secret + deploy
flyctl auth login --access-token "$FLYTOKEN"
flyctl apps create --name pageagent-demo --org personal
flyctl secrets set --app pageagent-demo DEEPSEEK_API_KEY="$DSKEY"
flyctl deploy --app pageagent-demo

# 3. GitHub
git init -b main && git remote add origin git@github.com:rifaterdemsahin/pageagent.git
git add -A && git commit -m "PageAgent POC + fly deploy" && git push -u origin main
#   .github/workflows/static.yml publishes Pages on push automatically
```

---

## 8. Verification performed

| Check | Result |
|---|---|
| `node --check` on `server.js` + `pageagent.js` | ✅ |
| Local smoke test: `GET /`, `/pageagent.js`, `/api/health`, `/api/plan` (no-key → 500) | ✅ |
| Parser unit tests (30+ cases) in Node | ✅ all pass |
| `GET https://pageagent-demo.fly.dev/api/health` | `{"ok":true,"deepseek":true,"model":"deepseek-chat"}` ✅ |
| `POST /api/plan` with real DeepSeek | returned a valid `{"steps":[…]}` ✅ |
| GitHub Pages HTML contains the hash-preserving `location.replace(…)` | ✅ |
| Git tree clean; 4 commits on `main` | ✅ |

---

## 9. Honest trade-offs

- The local NLU is regex-based — it handles the curated demos well but won't parse arbitrary
  free-form English. That gap is exactly what the DeepSeek proxy fills in production.
- The element finder doesn't yet traverse **shadow DOM** or **iframes**, and `snapshot()` mutates
  the DOM with `data-pa-id` (cosmetic, not cleaned up). See `TODO.md`.
- DeepSeek was chosen because the brief named it; the proxy is provider-agnostic, so swapping to
  Qwen/GPT/Claude is a one-line server change.

---

*Built as a proof of concept. Not affiliated with Alibaba. MIT licensed.*
