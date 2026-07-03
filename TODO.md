# PageAgent — what's missing (TODO / roadmap)

This repo is a **working proof of concept**. The agent parses commands, finds real DOM
elements, and executes actions live in `index.html`. To turn it into the
"production-ready" library the pitch promises, the items below are still on your side.

Priority key: 🔴 ship-blocker · 🟠 do soon · 🟢 nice-to-have

---

## 1. Things we never actually verified here ⚠️

> We unit-tested the command **parser** in Node, but the full app was **not** opened in a
> real browser in this session (no headless browser was available).

- 🔴 **Open `index.html` in Chrome/Safari** and click through every demo button:
  `Create Ada Lovelace`, `Open settings then turn on two-factor`, `Set plan to Enterprise`,
  `Scroll to bottom`. Confirm each step highlights + executes.
- 🔴 **Test voice** (🎙️ mic button) — Web Speech API only works over `https://` or `localhost`,
  so serve via `python3 -m http.server` and load `http://localhost:8000`.
- 🔴 **Test an LLM connection** — open ⚙️, paste a real DashScope/OpenAI key, run a free-form
  command the local planner can't handle (e.g. *"find my highest-value customer and email them"*).

---

## 2. Claims in the pitch that the POC does **not** yet implement

The marketing copy you pasted lists several capabilities. Check which are stubbed vs. real:

| Pitch claim | Status in this POC | What's missing |
|---|---|---|
| "Multi-page agent tasks via Chrome extension" | ❌ none | Build a MV3 extension that injects the agent + persists a plan/credential store across navigations & origins. |
| "MCP server support for external control" | ⚠️ only "MCP-ready" (an `on/emit` event bus) | Ship an actual **MCP server** (stdio/HTTP) adapter that translates MCP tool calls into `PageAgent.run(...)` over a postMessage/websocket bridge. |
| "Production-ready" | ⚠️ demo-grade | Needs the security, tests & packaging in §3–§5 below. |
| "Bring your own LLM (Qwen, GPT, Claude)" | ✅ implemented | Only OpenAI-style + Anthropic shapes; verify each provider's current request schema. |
| "Voice commands and accessibility built in" | ✅ implemented (STT + aria-live) | Add keyboard shortcut, focus trap, i18n — see §4. |

---

## 3. Security & safety 🔴

- 🔴 **Never ship the LLM API key in the browser.** Today it's stored in `localStorage` and sent
  from the client — any visitor can steal it. Provide a **backend proxy endpoint** (your own or a
  serverless function) and have `pageagent.js` call *that* instead of the provider directly.
- 🔴 **PII / consent:** the snapshot sent to the LLM may include form values. Add redaction +
  a GDPR consent prompt before any external call.
- 🔴 **Allow/deny-list of actions** so the agent can't click destructive buttons (Delete, Pay,
  Reset) without an explicit confirmation modal.
- 🟠 **Confirmation step** for high-risk actions (`type` into payment fields, `click` on
  submit/delete).
- 🟠 **Subresource Integrity (SRI) hash** on the CDN `<script>` tag.

---

## 4. Robustness of the agent core 🟠

- 🔴 **Shadow DOM & iframes** are not traversed by `findElement()`. Real apps (web components,
  embedded widgets) will silently fail.
- 🟠 **Disambiguation:** when two elements score similarly, ask "did you mean A or B?" instead of
  guessing.
- 🟠 **Custom widgets:** react-select, date pickers, rich-text editors, file `<input>`,
  multi-select, radio groups — none handled specifically today.
- 🟠 **React controlled inputs:** value injection is best-effort. Validate with a real React demo.
- 🟠 **Self-correction loop:** if an action fails, re-snapshot and let the LLM retry (observe →
  act → observe), instead of stopping.
- 🟠 **Conversation memory** — each command is stateless; "do it again", "yes", "the other one"
  don't work yet.
- 🟢 **Undo** of performed actions.

---

## 5. Distribution, packaging & quality 🟠

- 🔴 **Publish the one-line CDN URL properly.** The README points at
  `cdn.jsdelivr.net/gh/.../pageagent.js` (works once pushed to GitHub) — for production add a
  **pinned version** + SRI, and/or publish to **npm** and use `cdn.jsdelivr.net/npm/pageagent`.
- 🟠 **Build pipeline:** minify, ESM + UMD, `.d.ts` TypeScript types, version stamp.
- 🟠 **Tests:** the parser has a throwaway Node test; add **Vitest** unit tests for the planner
  and **Playwright** e2e tests that drive `index.html` headlessly.
- 🟠 **CI** (GitHub Actions): lint, test, build, auto-publish on tag.
- 🟢 **Debug overlay** showing element match scores; **analytics hooks**.

---

## 6. UX & accessibility 🟢

- 🟠 **Keyboard shortcut** to open the panel (e.g. <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd>).
- 🟠 **Command history** (↑/↓ recall) and **focus trap** inside the settings modal.
- 🟢 **i18n** of the UI strings; mobile bottom-sheet layout.

---

## 7. Docs & examples 🟢

- 🟠 **Integration examples** folder: React, Vue, Svelte, Next.js.
- 🟢 **Hosted demo** (GitHub Pages) so people can try without cloning.
- 🟢 **API reference** generated from JSDoc.

---

## 8. Publish to GitHub → `rifaterdemsahin/pageagent` 🔴

The repo is **not yet pushed**. From this directory:

```bash
# 1. make this folder its own git repo (it currently sits inside a bigger one)
git init -b main
git add .
git commit -m "feat: PageAgent POC — on-page AI agent (one-line drop-in)"

# 2. create the empty repo first on github.com/rifaterdemsahin/pageagent, then:
git remote add origin https://github.com/rifaterdemsahin/pageagent.git
git push -u origin main
```

Optional, enable the hosted demo:

```bash
# GitHub Pages → serve index.html from the repo root
# Settings → Pages → Build from branch → main / (root)
```

---

## TL;DR — minimum to call it shippable

1. 🔴 Open it in a browser, click every demo command, fix what breaks.
2. 🔴 Add the **backend LLM proxy** so API keys aren't exposed in the client.
3. 🔴 `git init` + push to **github.com/rifaterdemsahin/pageagent**.
4. 🟠 Add **Playwright** e2e tests + a **minified CDN build** with version + SRI.
5. 🟠 Build the **Chrome extension** and **MCP server** the pitch advertises (or soften those
   claims in the README).
