# ⚡ PageAgent — the AI agent that lives inside your webpage

> **Open-sourced by Alibaba.** A JavaScript AI agent users control your entire interface with — natural language.
> No browser extensions, no screenshots, no multi-modal LLMs, no headless browser, no backend rewrite.
> Just **one line of code.**

**What took 20 clicks now takes one sentence.**

```
"Click login, fill in my credentials, submit the form."  →  Done.
```

---

## 🚀 Install (one line)

```html
<script src="https://cdn.jsdelivr.net/gh/rifaterdemsahin/pageagent/pageagent.js" crossorigin="true"></script>
```

That's it. Your app now has an AI agent — a floating copilot orb appears in the corner.

### Run locally

```bash
git clone https://github.com/rifaterdemsahin/pageagent.git
cd pageagent
python3 -m http.server 8000   # then open http://localhost:8000
```

Open `index.html` for a live, interactive demo (a mock CRM the agent drives in real time).

---

## ✨ Features

| | |
|---|---|
| 🎯 **Precise on-page actions** | Clicks, types, selects & scrolls real DOM elements by meaning — no vision model. |
| 🧠 **Bring your own LLM** | Built-in zero-config planner, or connect **Qwen, GPT, Claude, OpenRouter** or any OpenAI-compatible endpoint. |
| 📝 **Smart form filling** | One sentence fills entire ERP / CRM / admin forms, field by field. |
| 🎙️ **Voice & a11y** | Speech-to-text input + screen-reader announcements via ARIA live regions. |
| 🔌 **MCP-ready & extensible** | Event-driven API (`on`/`emit`) so Chrome extensions or MCP servers can drive it. |
| 🪶 **Zero deps, one file** | No build step, no framework lock-in. Drop it in and ship. |

---

## 🧩 How it works

```
User command ─▶ Planner ─▶ [action, action, …] ─▶ Element finder ─▶ Execute + highlight
                 ▲                                                  │
                 └────────── local NLU  or  your LLM (function-calling) ─┘
```

1. **Planner** turns a sentence into an ordered list of actions. With no API key it uses a built-in
   on-device NLU; with a key it asks your LLM (sending only a compact snapshot of interactive
   elements — never raw HTML or screenshots).
2. **Element finder** scores every visible interactive element (`a`, `button`, `input`, `[role]`,
   `data-pa` hints…) against the target phrase and picks the best match.
3. **Runner** executes each action with a smooth highlight + scroll, dispatching native DOM events
   so React/Vue/Svelte inputs update correctly.

---

## 🗣️ Commands (examples)

The built-in planner understands natural phrasing — quotes optional:

```
click login
press the save button
go to settings / open settings / navigate to dashboard
create a customer named Ada Lovelace with email ada@acme.io
fill the email field with ada@acme.io
type "Ada" into the name field
select Enterprise from the plan dropdown
set the plan to Pro
turn on two-factor / check the notifications box
scroll to bottom
scroll to the settings section
wait 2 seconds then click submit
```

Compound commands are split on `then`, `,`, `and`, `next`, newlines.

---

## 🔌 Bring your own LLM

Click the ⚙️ in the panel, or configure in code:

```js
PageAgent.config({
  llm: {
    provider: 'dashscope',        // openai | dashscope (Qwen) | anthropic | openrouter | custom
    apiKey:   'sk-…',
    model:    'qwen-plus',        // optional
    baseURL:  'https://…'         // optional (custom)
  }
});
```

When an LLM is connected, PageAgent sends `{ command, elements[] }` and expects a JSON array of
steps back (function-calling style). On any failure it transparently falls back to the local planner.

---

## 🛠️ Programmatic API

```js
PageAgent.run('click login');              // run any command
PageAgent.open();  PageAgent.close();      // toggle the panel
PageAgent.find('save');                    // resolve an element
PageAgent.stop();                          // abort a running plan

PageAgent.on('command', e => console.log('user said:', e.command));
PageAgent.on('step',    e => console.log('did:', e.step, '→', e.result.msg));
PageAgent.on('done',    e => console.log('finished', e.results));

PageAgent.config({ accent: '#6366f1', voice: true, speak: true });
```

### Give the agent explicit hints (optional)

Add a `data-pa` attribute to make any element trivially targetable:

```html
<button data-pa="create invoice">New invoice</button>
<input  data-pa="customer email" placeholder="Email">
```

---

## 🧱 Use cases

- **AI copilot for any SaaS** — turn a 12-step workflow into one sentence.
- **Smart form filling** for ERP, CRM, admin panels, internal tools.
- **Accessibility & voice control** — drive the whole UI hands-free.
- **Automated demos / QA** — script realistic flows from natural language.
- **External control** via MCP server or a Chrome extension (multi-page tasks).

---

## 📦 What's in this repo

```
index.html      ← interactive demo (mock CRM) + landing page
pageagent.js    ← the agent library (the "one line")
README.md
LICENSE
```

---

## ⚠️ Status

This repository is a **proof of concept** celebrating the open-sourced PageAgent concept.
The included `pageagent.js` is a self-contained, working implementation of the on-page agent
pattern (element finding, action execution, local NLU, optional LLM, voice, a11y). It is not the
official Alibaba binary. Use it to prototype, learn, and build on.

## License

MIT © Rifat Erdem Sahin
