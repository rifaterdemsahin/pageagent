/*!
 * PageAgent — an AI agent that lives inside your webpage.
 *
 * Drop-in usage:
 *   <script src="pageagent.js" crossorigin="true"></script>
 *
 * Bring-your-own LLM:
 *   PageAgent.config({ llm: { provider: 'openai', apiKey: 'sk-...' } })
 *
 * Production-ready, dependency-free, ~no backend required.
 * (c) PageAgent POC. MIT licensed.
 */
(function (root) {
  'use strict';

  // ───────────────────────────────────────────────────────────────────────────
  // 0. Constants & state
  // ───────────────────────────────────────────────────────────────────────────
  const VERSION = '1.0.0';
  const LS_KEY = 'pageagent:config';

  const defaultConfig = {
    autoOpen: false,
    position: 'bottom-right', // 'bottom-right' | 'bottom-left'
    accent: '#6366f1',
    title: 'PageAgent',
    placeholder: 'Tell me what to do…  e.g. "Create a customer named Ada"',
    voice: true,
    speak: true,
    lang: 'en-US',
    highlightMs: 1600,
    stepDelayMs: 450,
    // Bring your own LLM. When absent, a built-in local planner is used.
    llm: null, // { provider, apiKey, model, baseURL, systemPrompt }
  };

  let config = deepMerge(defaultConfig, loadPersisted());
  let rootEl = null;       // the floating panel
  let logEl = null;        // transcript
  let inputEl = null;      // command textarea
  let micBtn = null;
  let fabEl = null;        // floating action button
  let liveEl = null;       // aria-live announcer
  let recognition = null;
  let isRunning = false;
  let abortFlag = false;
  const listeners = {};

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Utilities
  // ───────────────────────────────────────────────────────────────────────────
  function deepMerge(a, b) {
    const out = Array.isArray(a) ? a.slice() : Object.assign({}, a);
    if (!b) return out;
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        out[k] = deepMerge(a[k] || {}, b[k]);
      } else {
        out[k] = b[k];
      }
    }
    return out;
  }

  function loadPersisted() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
  }
  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ llm: config.llm })); } catch { /* ignore */ }
  }

  function on(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  function emit(type, payload) { (listeners[type] || []).forEach((fn) => { try { fn(payload); } catch (e) {} }); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function norm(s) { return String(s || '').toLowerCase().replace(/[-_\/]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'style') node.setAttribute('style', attrs[k]);
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      node.append(kind(kid));
    }
    return node;
    function kind(k) { return typeof k === 'string' || typeof k === 'number' ? document.createTextNode(k) : k; }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Element finder — the "eyes" of the agent
  // ───────────────────────────────────────────────────────────────────────────
  const INTERACTIVE = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable], [tabindex]';

  function candidates() {
    return Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible);
  }

  function visible(node) {
    if (!node || !node.isConnected) return false;
    const rs = getComputedStyle(node);
    if (rs.display === 'none' || rs.visibility === 'hidden' || Number(rs.opacity) === 0) return false;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describe(node) {
    const bits = [];
    const aria = node.getAttribute('aria-label');
    if (aria) bits.push(norm(aria));
    if (node.id) bits.push(norm(node.id.replace(/[-_]/g, ' ')));
    const ph = node.getAttribute('placeholder');
    if (ph) bits.push(norm(ph));
    const name = node.getAttribute('name');
    if (name) bits.push(norm(name.replace(/[-_]/g, ' ')));
    const txt = norm(node.textContent || '');
    if (txt) bits.push(txt);
    const val = node.getAttribute('value');
    if (val && node.tagName === 'INPUT' && node.type === 'submit') bits.push(norm(val));
    const dataPa = node.getAttribute('data-pa');
    if (dataPa) bits.unshift(norm(dataPa)); // explicit hints win
    return bits.join(' ');
  }

  function score(query, node) {
    const hay = describe(node);
    if (!hay) return -1;
    const q = norm(query);
    if (q.includes(' ' + hay) ) {}
    let s = 0;
    if (hay === q) s += 100;
    if (hay.startsWith(q)) s += 60;
    if (hay.includes(' ' + q + ' ')) s += 55;
    if (hay.includes(q)) s += 35;
    // word overlap
    const qw = new Set(q.split(' ').filter(Boolean));
    const hw = new Set(hay.split(' ').filter(Boolean));
    let overlap = 0; qw.forEach((w) => { if (w.length > 2 && hw.has(w)) overlap++; });
    s += overlap * 8;
    // boost explicit developer hints and primary actions
    if (node.getAttribute('data-pa')) s += 5;
    if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') s += 3;
    return s;
  }

  function findElement(query, opts) {
    opts = opts || {};
    const ranked = candidates()
      .map((node) => ({ node, s: score(query, node) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (!ranked.length) {
      // last resort: any visible element whose text contains the query
      const all = Array.from(document.body.querySelectorAll('*')).filter(visible);
      for (const node of all) {
        if (node.children.length === 0 && norm(node.textContent) === norm(query)) {
          ranked.push({ node, s: 1 });
          break;
        }
      }
    }
    if (!ranked.length) return null;
    return ranked[0].node;
  }

  // Build a compact DOM snapshot to send to an LLM for planning.
  function snapshot() {
    return candidates().slice(0, 200).map((node, i) => {
      node.setAttribute('data-pa-id', i);
      let label = describe(node) || node.tagName.toLowerCase();
      label = label.slice(0, 80);
      return { id: i, tag: node.tagName.toLowerCase(), type: node.type || null, label };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Actions — the "hands" of the agent
  // ───────────────────────────────────────────────────────────────────────────
  function highlight(node) {
    if (!node) return;
    try { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
    const r = node.getBoundingClientRect();
    const box = el('div', { class: 'pa-highlight' });
    box.style.cssText = `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;`;
    document.body.appendChild(box);
    setTimeout(() => box.remove(), config.highlightMs);
  }

  async function actClick(target) {
    const node = typeof target === 'string' ? findElement(target) : target;
    if (!node) return fail(`I couldn't find “${target}”.`);
    highlight(node);
    await wait(config.stepDelayMs);
    node.focus?.();
    node.click?.();
    return ok(`Clicked ${labelOf(node)}.`);
  }

  async function actType(target, value) {
    const node = typeof target === 'string' ? findElement(target) : target;
    if (!node) return fail(`I couldn't find a field for “${target}”.`);
    highlight(node);
    await wait(config.stepDelayMs);
    node.focus?.();
    setNativeValue(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(`Typed “${value}” into ${labelOf(node)}.`);
  }

  async function actSelect(target, value) {
    const node = typeof target === 'string' ? findElement(target) : target;
    if (!node || node.tagName !== 'SELECT') {
      // maybe the user named the option; search a select containing it
      const sel = Array.from(document.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => norm(o.textContent) === norm(value) || norm(o.value) === norm(value)));
      if (sel) return actSelect(sel, value);
      return fail(`I couldn't find a dropdown for “${target}”.`);
    }
    highlight(node);
    await wait(config.stepDelayMs);
    const opt = Array.from(node.options).find((o) => norm(o.textContent) === norm(value) || norm(o.value) === norm(value));
    if (!opt) return fail(`“${value}” isn't an option in ${labelOf(node)}.`);
    node.value = opt.value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(`Selected “${value}”.`);
  }

  async function actScroll(target) {
    let node;
    if (!target || /top|up/.test(target)) { window.scrollTo({ top: 0, behavior: 'smooth' }); return ok('Scrolled to top.'); }
    if (/bottom|down/.test(target)) { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return ok('Scrolled to bottom.'); }
    node = findElement(target);
    if (!node) return fail(`I couldn't find “${target}” to scroll to.`);
    highlight(node);
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return ok(`Scrolled to ${target}.`);
  }

  async function actNavigate(target) {
    const node = findElement(target) || findLinkByText(target);
    if (node) return actClick(node);
    return fail(`I couldn't find a way to “${target}”.`);
  }

  function findLinkByText(text) {
    return Array.from(document.querySelectorAll('a, [role="link"]')).filter(visible)
      .find((a) => norm(a.textContent).includes(norm(text)));
  }

  function setNativeValue(node, value) {
    const { tagName, type } = node;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') node.value = value;
    else if (tagName === 'SELECT') node.value = value;
    else if (node.isContentEditable) node.textContent = value;
    else node.value = value;
    // React-friendly native setter
    try {
      const proto = tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : (tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter && type !== 'file') setter.call(node, value);
    } catch {}
  }

  function labelOf(node) {
    return node.getAttribute('aria-label') || node.getAttribute('placeholder') ||
      norm(node.textContent).slice(0, 40) || node.getAttribute('data-pa') || node.tagName.toLowerCase();
  }
  function ok(msg) { return { ok: true, msg }; }
  function fail(msg) { return { ok: false, msg }; }
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Planner — local NLU (no API key needed) with optional LLM upgrade
  // ───────────────────────────────────────────────────────────────────────────
  // Verbs that begin a new, independent action step.
  const STEP_VERB = /^(click|press|tap|open|go to|goto|navigate to|visit|show|scroll|focus|fill(?:\s+(?:in|out|up))?|type|enter|input|select|choose|pick|set|put|turn\s+on|turn\s+off|toggle|check|tick|uncheck|clear|submit|send|wait|create|add|sign\s+in|log\s+in|login|logout|sign\s+up)\b/i;

  function splitSteps(cmd) {
    // protect quoted segments so internal commas/words survive splitting
    const quotes = [];
    const masked = cmd.replace(/"[^"]*"|'[^']*'/g, (m) => { quotes.push(m); return ` §Q${quotes.length - 1}§ `; });
    const marked = masked
      .replace(/\bthen\b/gi, ' § ')
      .replace(/\bafter that\b/gi, ' § ')
      .replace(/\bnext\b/gi, ' § ')
      .replace(/;/g, ' § ')
      .replace(/\n/g, ' § ')
      .replace(/,/g, ' § ')
      .replace(/\band\b/gi, ' § ');
    const restore = (s) => s.replace(/§Q(\d+)§/g, (mm, i) => quotes[+i]);
    const raw = marked.split('§').map((s) => restore(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
    // merge a chunk back into the previous step unless it starts with an action verb
    const out = [];
    for (const chunk of raw) {
      if (!out.length || STEP_VERB.test(chunk)) out.push(chunk);
      else out[out.length - 1] += ' and ' + chunk;
    }
    return out.length ? out : [cmd.trim()];
  }

  function planLocal(step) {
    const s = step.trim();
    let m;

    // ── create/add entity with optional name + email (headline demo command) ──
    if ((m = s.match(/^create\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(customer|user|account|contact|invoice|order|lead|deal|task)\s+(?:named|called)\s+(.+?)(?:\s+with\s+(?:the\s+)?(?:email|e-?mail)\s+(.+))?$/i))) {
      const steps = [{ action: 'navigate', target: 'new ' + m[1] }];
      if (m[2]) steps.push({ action: 'type', target: 'name', value: stripQuotes(m[2]) });
      if (m[3]) steps.push({ action: 'type', target: 'email', value: stripQuotes(m[3]) });
      return steps;
    }

    // ── toggles ──
    if ((m = s.match(/^turn\s+(?:on|off)\s+(?:the\s+)?(.+)$/i))) return { action: 'click', target: stripQuotes(m[1]) };
    if ((m = s.match(/^toggle\s+(?:the\s+)?(.+)$/i))) return { action: 'click', target: stripQuotes(m[1]) };
    if (/^(?:sign in|log in|login)\b/i.test(s)) return { action: 'navigate', target: 'login' };
    if (/^(?:sign out|log out|logout)\b/i.test(s)) return { action: 'navigate', target: 'logout' };

    // quoted value: type "Ada" into name
    if ((m = s.match(/^(?:type|enter|input)\s+"([^"]+)"\s+(?:in(?:to)?|on|under)\s+(?:the\s+)?(.+)$/i))) {
      return { action: 'type', target: m[2], value: m[1] };
    }
    if ((m = s.match(/^(?:type|enter|input)\s+(.+?)\s+(?:in(?:to)?|on|under)\s+(?:the\s+)?(.+)$/i)) && !/^(click|press)/i.test(s)) {
      return { action: 'type', target: m[2], value: m[1] };
    }
    if ((m = s.match(/^(?:fill(?:\s+(?:in|out|up))?)\s+(?:the\s+)?(.+?)\s+(?:with|as)\s+(.+)$/i))) {
      return { action: 'type', target: m[1], value: stripQuotes(m[2]) };
    }
    if ((m = s.match(/^(?:set|put)\s+(?:the\s+)?(.+?)\s+(?:to|as)\s+(.+)$/i))) {
      return { action: 'type', target: m[1], value: stripQuotes(m[2]) };
    }
    if ((m = s.match(/^(?:select|choose|pick)\s+(.+?)\s+(?:from|in|on)\s+(?:the\s+)?(.+)$/i))) {
      return { action: 'select', target: m[2], value: stripQuotes(m[1]) };
    }
    if ((m = s.match(/^(?:check|tick)\s+(?:the\s+)?(.+)$/i))) { return { action: 'click', target: m[1] }; }
    if ((m = s.match(/^(?:uncheck|clear)\s+(?:the\s+)?(.+)$/i))) { return { action: 'click', target: m[1] }; }
    if ((m = s.match(/^(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?(.+)$/i))) { return { action: 'click', target: m[1] }; }
    if ((m = s.match(/^(?:open|go to|navigate to|visit|show)\s+(?:the\s+)?(.+)$/i))) { return { action: 'navigate', target: m[1] }; }
    if ((m = s.match(/^scroll\s+(?:to\s+)?(?:the\s+)?(.+)?$/i))) { return { action: 'scroll', target: (m[1] || '').trim() }; }
    if ((m = s.match(/^focus\s+(?:on\s+)?(?:the\s+)?(.+)$/i))) {
      const node = findElement(m[1]); if (node) { highlight(node); node.focus?.(); } return ok('Focused.');
    }
    if (/^(submit|send)\b/i.test(s)) { return { action: 'click', target: 'submit' }; }
    if ((m = s.match(/^wait\s+(\d+)\s*(s|sec|seconds?|ms|milliseconds?)?$/i))) {
      const ms = /m/i.test(m[2] || '') ? +m[1] : +m[1] * 1000; return { action: 'wait', ms };
    }
    // bare target → treat as click
    return { action: 'click', target: s };
  }
  function stripQuotes(x) { return x.replace(/^["'“”]|["'“”]$/g, '').trim(); }

  async function planWithLLM(cmd) {
    if (!config.llm) return null;
    try {
      const snap = snapshot();
      // Proxy mode (recommended for production): a backend holds the API key
      // and the browser only POSTs { command, elements } to it. See server.js.
      if (config.llm.proxy) {
        const r = await fetch(config.llm.proxy, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd, elements: snap }),
        });
        if (!r.ok) throw new Error('proxy HTTP ' + r.status);
        const data = await r.json();
        const steps = data.steps || data;
        if (!Array.isArray(steps) || !steps.length) return null;
        return steps.map((st) => ({ ...st, target: resolveLLMTarget(st, snap) }));
      }
      if (!config.llm.apiKey) return null;
      const sys = (config.llm.systemPrompt ||
        'You are PageAgent, an on-page AI agent. Given a user command and a JSON list of interactive elements ({id,label,tag}), ' +
        'return a JSON array of steps. Each step is one of: ' +
        '{"action":"click","target":"label"}, {"action":"type","target":"label","value":"..."}, ' +
        '{"action":"select","target":"label","value":"..."}, {"action":"scroll","target":"label|top|bottom"}, {"action":"wait","ms":500}. ' +
        'Use the exact element labels. Respond with JSON only, no prose.');
      const body = buildLLMRequest(sys, cmd, snap);
      const res = await fetch(config.llm.baseURL || providerURL(config.llm.provider), {
        method: 'POST',
        headers: llmHeaders(config.llm),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('LLM HTTP ' + res.status);
      const data = await res.json();
      const text = extractLLMText(data);
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return null;
      const steps = JSON.parse(match[0]);
      return steps.map((st) => ({ ...st, target: resolveLLMTarget(st, snap) }));
    } catch (e) {
      console.warn('[PageAgent] LLM planning failed, falling back to local planner:', e.message);
      return null;
    }
  }

  function resolveLLMTarget(step, snap) {
    if (typeof step.target === 'number') {
      const found = snap.find((x) => x.id === step.target);
      const node = found ? document.querySelector(`[data-pa-id="${found.id}"]`) : null;
      return node || step.target;
    }
    return step.target;
  }

  function providerURL(provider) {
    const p = norm(provider);
    if (p.includes('openai')) return 'https://api.openai.com/v1/chat/completions';
    if (p.includes('dashscope') || p.includes('qwen') || p.includes('alibaba'))
      return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    if (p.includes('anthropic') || p.includes('claude')) return 'https://api.anthropic.com/v1/messages';
    if (p.includes('openrouter')) return 'https://openrouter.ai/api/v1/chat/completions';
    return provider; // treat as full URL
  }
  function llmHeaders(llm) {
    const h = { 'Content-Type': 'application/json' };
    if (llm.provider && llm.provider.includes('anthropic')) {
      h['x-api-key'] = llm.apiKey; h['anthropic-version'] = '2023-06-01';
    } else { h['Authorization'] = `Bearer ${llm.apiKey}`; }
    return h;
  }
  function buildLLMRequest(sys, cmd, snap) {
    const model = config.llm.model || defaultModel(config.llm.provider);
    const user = `Command: "${cmd}"\nElements: ${JSON.stringify(snap)}`;
    if (config.llm.provider && config.llm.provider.includes('anthropic')) {
      return { model, max_tokens: 800, system: sys, messages: [{ role: 'user', content: user }] };
    }
    return { model, temperature: 0, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] };
  }
  function defaultModel(provider) {
    const p = norm(provider || '');
    if (p.includes('anthropic')) return 'claude-3-5-sonnet-latest';
    if (p.includes('qwen')) return 'qwen-plus';
    if (p.includes('openrouter')) return 'openai/gpt-4o-mini';
    return 'gpt-4o-mini';
  }
  function extractLLMText(data) {
    if (Array.isArray(data.choices)) return data.choices[0].message.content;
    if (data.content) return data.content.map((c) => c.text).join('');
    return JSON.stringify(data);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Runner — executes a plan step by step
  // ───────────────────────────────────────────────────────────────────────────
  async function run(command) {
    if (isRunning) return;
    const cmd = (command || '').trim();
    if (!cmd) return;
    isRunning = true; abortFlag = false;
    setUserEnabled(false);
    pushLog('user', cmd);
    emit('command', { command: cmd });
    think('Planning…');

    let steps = await planWithLLM(cmd);
    if (!steps || !steps.length) {
      steps = splitSteps(cmd).flatMap((s) => { const r = planLocal(s); return Array.isArray(r) ? r : [r]; });
    }
    // expand local navigate into click lookups etc. handled inside actions
    const results = [];
    for (const step of steps) {
      if (abortFlag) { results.push(fail('Stopped.')); break; }
      if (step.ok !== undefined) { results.push(step); continue; }
      let res;
      switch (step.action) {
        case 'click': res = await actClick(step.target); break;
        case 'type': res = await actType(step.target, step.value); break;
        case 'select': res = await actSelect(step.target, step.value); break;
        case 'scroll': res = await actScroll(step.target); break;
        case 'navigate': res = await actNavigate(step.target); break;
        case 'wait': await wait(step.ms || 500); res = ok(`Waited ${(step.ms || 500)}ms.`); break;
        default: res = fail(`Unknown action “${step.action}”.`);
      }
      results.push(res);
      emit('step', { step, result: res });
      if (!res.ok) break;
      announce(res.msg);
    }
    const summary = results.map((r) => r.msg).join(' ');
    pushLog('agent', summary || 'Done.');
    speak(summary);
    emit('done', { command: cmd, results });
    think(null);
    isRunning = false;
    setUserEnabled(true);
    return results;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. UI — the floating copilot panel
  // ───────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('pa-styles')) return;
    const css = `
    .pa-fab{position:fixed;${config.position === 'bottom-left' ? 'left' : 'right'}:20px;bottom:20px;width:58px;height:58px;border-radius:50%;
      background:linear-gradient(135deg,${config.accent},#8b5cf6);box-shadow:0 10px 30px rgba(79,70,229,.45);border:none;cursor:pointer;z-index:2147483000;
      display:flex;align-items:center;justify-content:center;transition:transform .2s}
    .pa-fab:hover{transform:translateY(-3px) scale(1.05)}
    .pa-fab svg{width:28px;height:28px;color:#fff}
    .pa-panel{position:fixed;${config.position === 'bottom-left' ? 'left' : 'right'}:20px;bottom:90px;width:min(380px,calc(100vw - 40px));
      max-height:560px;background:#0f1117;color:#e7e9ee;border:1px solid #23262f;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.5);
      z-index:2147483001;display:flex;flex-direction:column;overflow:hidden;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      transform:translateY(20px) scale(.96);opacity:0;pointer-events:none;transition:all .22s cubic-bezier(.2,.8,.2,1)}
    .pa-panel.open{transform:none;opacity:1;pointer-events:auto}
    .pa-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,${config.accent}22,transparent);border-bottom:1px solid #23262f}
    .pa-head .dot{width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}
    .pa-head h3{margin:0;font-size:15px;font-weight:600;flex:1;letter-spacing:.2px}
    .pa-head .cfg,.pa-head .cls{background:transparent;border:none;color:#9aa0ac;cursor:pointer;padding:4px;border-radius:8px}
    .pa-head .cfg:hover,.pa-head .cls:hover{background:#1b1e27;color:#fff}
    .pa-log{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin}
    .pa-log::-webkit-scrollbar{width:6px}.pa-log::-webkit-scrollbar-thumb{background:#2c313c;border-radius:3px}
    .pa-msg{max-width:88%;padding:9px 12px;border-radius:12px;font-size:13.5px;animation:pa-pop .18s ease}
    @keyframes pa-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1}}
    .pa-msg.agent{align-self:flex-start;background:#1b1e27;border:1px solid #262a35}
    .pa-msg.user{align-self:flex-end;background:linear-gradient(135deg,${config.accent},#8b5cf6);color:#fff}
    .pa-msg.sys{align-self:center;background:transparent;color:#7a808c;font-size:12px;border:1px dashed #2c313c}
    .pa-msg b{color:${config.accent}}
    .pa-sugg{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
    .pa-sugg button{background:#161922;border:1px solid #262a35;color:#c7ccd6;border-radius:20px;padding:5px 11px;font-size:12px;cursor:pointer}
    .pa-sugg button:hover{border-color:${config.accent};color:#fff}
    .pa-input{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;border-top:1px solid #23262f;background:#0c0e14}
    .pa-input textarea{flex:1;background:#161922;border:1px solid #262a35;color:#e7e9ee;border-radius:12px;padding:10px 12px;font:inherit;font-size:13.5px;resize:none;max-height:120px;outline:none}
    .pa-input textarea:focus{border-color:${config.accent}}
    .pa-input button{background:${config.accent};border:none;color:#fff;width:40px;height:40px;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:none}
    .pa-input button:disabled{opacity:.5;cursor:not-allowed}
    .pa-input .mic{background:#161922;border:1px solid #262a35;color:#e7e9ee}
    .pa-input .mic.listening{background:#ef4444;border-color:#ef4444;animation:pa-pulse 1.2s infinite}
    @keyframes pa-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}
    .pa-highlight{position:fixed;border-radius:8px;pointer-events:none;z-index:2147482999;
      box-shadow:0 0 0 3px ${config.accent},0 0 0 6px rgba(99,102,241,.35),0 8px 30px rgba(99,102,241,.4);
      animation:pa-hl .4s ease}
    @keyframes pa-hl{from{transform:scale(1.06);opacity:0}to{transform:scale(1);opacity:1}}
    .pa-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:2147483002}
    .pa-modal .box{background:#0f1117;color:#e7e9ee;border:1px solid #23262f;border-radius:16px;padding:22px;width:min(440px,92vw)}
    .pa-modal h3{margin:0 0 6px}.pa-modal p{color:#9aa0ac;margin:0 0 14px;font-size:13px}
    .pa-modal label{display:block;font-size:12px;color:#9aa0ac;margin:10px 0 4px}
    .pa-modal select,.pa-modal input{width:100%;box-sizing:border-box;background:#161922;border:1px solid #262a35;color:#e7e9ee;border-radius:10px;padding:9px 11px;font:inherit}
    .pa-modal .row{display:flex;gap:8px;margin-top:18px;justify-content:flex-end}
    .pa-modal button{border:none;border-radius:10px;padding:9px 16px;cursor:pointer;font:inherit}
    .pa-modal .save{background:${config.accent};color:#fff}.pa-modal .cancel{background:#1b1e27;color:#c7ccd6;border:1px solid #262a35}
    @media(max-width:520px){.pa-panel{bottom:84px}}
    `;
    document.head.appendChild(el('style', { id: 'pa-styles', html: css }));
  }

  function buildWidget() {
    injectStyles();

    fabEl = el('button', {
      class: 'pa-fab', 'aria-label': 'Open PageAgent', title: 'PageAgent',
      onclick: toggle,
    }, iconRobot());
    document.body.appendChild(fabEl);

    rootEl = el('div', { class: 'pa-panel', role: 'dialog', 'aria-label': 'PageAgent copilot' });

    const head = el('div', { class: 'pa-head' },
      el('span', { class: 'dot', title: 'online' }),
      el('h3', {}, config.title),
      el('button', { class: 'cfg', 'aria-label': 'Settings', title: 'Connect your LLM', onclick: openSettings }, iconGear()),
      el('button', { class: 'cls', 'aria-label': 'Close', onclick: close }, iconX()),
    );

    logEl = el('div', { class: 'pa-log', 'aria-live': 'polite' });

    const sugg = el('div', { class: 'pa-sugg' });
    const examples = config.suggestions || ['Click login', 'Fill the form', 'Scroll to bottom', 'Open settings'];
    examples.slice(0, 4).forEach((ex) => sugg.appendChild(el('button', { onclick: () => { inputEl.value = ex; submit(); } }, ex)));

    const form = el('form', { class: 'pa-input', onsubmit: (e) => { e.preventDefault(); submit(); } });
    inputEl = el('textarea', { rows: 1, placeholder: config.placeholder, 'aria-label': 'Command' });
    inputEl.addEventListener('input', debounce(autoGrow, 60));
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    micBtn = el('button', { type: 'button', class: 'mic', 'aria-label': 'Voice command', title: 'Voice command', tabindex: '-1' }, iconMic());
    if (!config.voice || !hasSpeech()) micBtn.style.display = 'none';
    else micBtn.addEventListener('click', toggleVoice);
    const sendBtn = el('button', { type: 'submit', 'aria-label': 'Run' }, iconSend());
    form.append(inputEl, micBtn, sendBtn);

    liveEl = el('div', { 'aria-live': 'assertive', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)' });

    rootEl.append(head, logEl, sugg, form, liveEl);
    document.body.appendChild(rootEl);

    pushLog('sys', '👋 Hi! I\'m <b>PageAgent</b>. Tell me what to do in plain English and I\'ll do it. Try “<i>create a customer named Ada</i>”.');
  }

  function autoGrow() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px'; }

  function open() { if (!rootEl) buildWidget(); rootEl.classList.add('open'); fabEl.style.display = 'none'; setTimeout(() => inputEl.focus(), 250); emit('open', {}); }
  function close() { rootEl.classList.remove('open'); fabEl.style.display = 'flex'; emit('close', {}); }
  function toggle() { rootEl && rootEl.classList.contains('open') ? close() : open(); }

  function setUserEnabled(on) { inputEl.disabled = !on; rootEl.querySelectorAll('.pa-input button').forEach((b) => b.disabled = !on); }

  function think(msg) {
    const existing = logEl.querySelector('.pa-thinking');
    if (!msg) { existing && existing.remove(); return; }
    if (existing) existing.textContent = msg;
    else pushLog('agent', '… ' + msg, 'pa-thinking');
  }

  function pushLog(role, html, cls) {
    const msg = el('div', { class: 'pa-msg ' + role + (cls ? ' ' + cls : ''), html });
    logEl.appendChild(msg);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function announce(text) { if (liveEl) liveEl.textContent = text.replace(/<[^>]+>/g, ''); }

  function submit() {
    const v = inputEl.value.trim();
    if (!v) return;
    inputEl.value = ''; autoGrow();
    run(v);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Voice (Web Speech API)
  // ───────────────────────────────────────────────────────────────────────────
  function hasSpeech() { return !!(root.SpeechRecognition || root.webkitSpeechRecognition); }
  function toggleVoice() {
    if (recognition) { recognition.stop(); return; }
    const R = root.SpeechRecognition || root.webkitSpeechRecognition;
    recognition = new R();
    recognition.lang = config.lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += tr; else interim += tr;
      }
      inputEl.value = (finalText + interim).trim(); autoGrow();
    };
    recognition.onend = () => { recognition = null; micBtn.classList.remove('listening'); if (finalText.trim()) submit(); };
    recognition.onerror = () => { recognition = null; micBtn.classList.remove('listening'); };
    micBtn.classList.add('listening');
    finalText = '';
    recognition.start();
  }

  function speak(text) {
    if (!config.speak) return;
    const clean = text.replace(/<[^>]+>/g, '');
    if (!('speechSynthesis' in root) || !clean) return;
    try { const u = new SpeechSynthesisUtterance(clean.slice(0, 200)); u.lang = config.lang; root.speechSynthesis.cancel(); root.speechSynthesis.speak(u); } catch {}
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Settings modal (connect your own LLM)
  // ───────────────────────────────────────────────────────────────────────────
  function openSettings() {
    const cur = config.llm || {};
    const box = el('div', { class: 'box' });
    box.innerHTML = `
      <h3>🔌 Bring your own LLM</h3>
      <p>Optional. Without a key, PageAgent uses its built-in on-device planner. Add a key for full natural-language understanding.</p>
      <label for="pa-prov">Provider</label>
      <select id="pa-prov">
        <option value="">Built-in (no key)</option>
        <option value="openai">OpenAI (GPT)</option>
        <option value="dashscope">Alibaba Qwen (DashScope)</option>
        <option value="anthropic">Anthropic (Claude)</option>
        <option value="openrouter">OpenRouter</option>
        <option value="custom">Custom URL</option>
      </select>
      <label for="pa-key">API key</label>
      <input id="pa-key" type="password" placeholder="sk-…" autocomplete="off" />
      <label for="pa-model">Model <span style="color:#5b616e">(optional)</span></label>
      <input id="pa-model" type="text" placeholder="auto" autocomplete="off" />
      <label for="pa-url">Base URL <span style="color:#5b616e">(custom only)</span></label>
      <input id="pa-url" type="text" placeholder="https://…/v1/chat/completions" autocomplete="off" />
      <div class="row">
        <button class="cancel">Cancel</button>
        <button class="save">Save</button>
      </div>`;
    const modal = el('div', { class: 'pa-modal', role: 'dialog', 'aria-label': 'PageAgent settings' }, box);
    const prov = $('#pa-prov', box); prov.value = cur.provider || '';
    $('#pa-key', box).value = cur.apiKey || '';
    $('#pa-model', box).value = cur.model || '';
    $('#pa-url', box).value = cur.baseURL || '';
    $('.cancel', box).onclick = () => modal.remove();
    $('.save', box).onclick = () => {
      config.llm = prov.value ? {
        provider: prov.value,
        apiKey: $('#pa-key', box).value || undefined,
        model: $('#pa-model', box).value || undefined,
        baseURL: prov.value === 'custom' ? ($('#pa-url', box).value || undefined) : undefined,
      } : null;
      persist();
      pushLog('sys', config.llm ? `✅ Connected to <b>${config.llm.provider}</b>. Full NL planning is on.` : '🔁 Switched back to the built-in planner.');
      modal.remove();
    };
    document.body.appendChild(modal);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Icons (inline svg, no deps)
  // ───────────────────────────────────────────────────────────────────────────
  function iconRobot() { return svg('<path d="M12 2a2 2 0 0 1 2 2v1h1a3 3 0 0 1 3 3v1h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1V8a3 3 0 0 1 3-3h1V4a2 2 0 0 1 2-2Zm-2.5 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>'); }
  function iconGear() { return svg('<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/><path d="M19.4 13a7.9 7.9 0 0 0 0-2l2-1.5-2-3.4-2.3 1a8 8 0 0 0-1.7-1l-.3-2.5h-4l-.3 2.5a8 8 0 0 0-1.7 1l-2.3-1-2 3.4L4.6 11a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 1.7 1l.3 2.5h4l.3-2.5a8 8 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5Z"/>'); }
  function iconX() { return svg('<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6 6.4 5Z"/>'); }
  function iconSend() { return svg('<path d="M4 12 20 4l-5 16-3.5-5.5L4 12Z"/>'); }
  function iconMic() { return svg('<path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z"/>'); }
  function svg(inner) { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); n.setAttribute('viewBox', '0 0 24 24'); n.setAttribute('fill', 'currentColor'); n.innerHTML = inner; return n; }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Boot & public API
  // ───────────────────────────────────────────────────────────────────────────
  function boot() {
    buildWidget();
    if (config.autoOpen) open();
    // expose quick global handler for data-pa-trigger buttons etc.
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-pa-trigger]');
      if (t) { e.preventDefault(); run(t.getAttribute('data-pa-trigger')); }
    });
  }

  const api = {
    VERSION,
    config(opts) { config = deepMerge(config, opts || {}); persist(); return config; },
    open, close, toggle,
    run,            // programmatic: PageAgent.run('click save')
    find: findElement,
    on,             // events: command|step|done|open|close
    stop() { abortFlag = true; },
    get llm() { return config.llm; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  root.PageAgent = api;
})(typeof window !== 'undefined' ? window : this);
