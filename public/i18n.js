// Interface language (per user). Thai is the source language: the code writes
// Thai, and in English mode this file swaps visible Thai text for English as it
// reaches the page — static HTML, everything app.js/admin.js render, error
// messages from the server, confirm/prompt dialogs and chart labels.
// Only text found in the dictionary (i18n-en.js) changes, so client data from
// FMH (product, supplier, branch names) is shown exactly as it is.
(function () {
  const TH = /[฀-๿]/;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  let lang = 'th';
  try { lang = localStorage.getItem('kss_lang') === 'en' ? 'en' : 'th'; } catch (e) { /* default th */ }

  const src = window.I18N_EN || { exact: {}, patterns: [] };
  const exact = new Map(Object.entries(src.exact).map(([k, v]) => [norm(k), v]));
  // Longest patterns first so the most specific one wins.
  const patterns = src.patterns
    .map(([th, en]) => {
      const names = [];
      const body = norm(th)
        .split(/(\{\d+\})/)
        .map((part) => {
          const m = part.match(/^\{(\d+)\}$/);
          if (m) { names.push(m[1]); return '([\\s\\S]*?)'; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      return { re: new RegExp(`^${body}$`), names, en, len: th.length };
    })
    .sort((a, b) => b.len - a.len);

  function translate(text) {
    if (lang !== 'en' || !text || !TH.test(text)) return text;
    const key = norm(text);
    if (exact.has(key)) return exact.get(key);
    for (const p of patterns) {
      const m = key.match(p.re);
      if (!m) continue;
      let out = p.en;
      p.names.forEach((n, i) => { out = out.replace(`{${n}}`, translate(m[i + 1])); });
      return out;
    }
    // "A · B · C" lines and "label: value" tooltips are often built from
    // separately translatable parts.
    for (const sep of [' · ', ': ']) {
      if (!key.includes(sep)) continue;
      const parts = key.split(sep);
      const tr = parts.map((p) => translate(p));
      if (tr.some((t, i) => t !== parts[i])) return tr.join(sep);
    }
    return text;
  }

  // Keep the surrounding whitespace of a text node; only its words change.
  function translateTextNode(node) {
    const v = node.nodeValue;
    if (!v || !TH.test(v)) return;
    const out = translate(v);
    if (out === v) return;
    const lead = v.match(/^\s*/)[0];
    const trail = v.match(/\s*$/)[0];
    node.nodeValue = lead + out + trail;
  }

  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

  // Only write when the text actually changes: setting an attribute to its
  // own value still fires the observer, which would loop forever.
  function translateAttrs(node) {
    ATTRS.forEach((a) => {
      const v = node.getAttribute(a);
      if (!v || !TH.test(v)) return;
      const out = translate(v);
      if (out !== v) node.setAttribute(a, out);
    });
  }

  function translateTree(root) {
    if (lang !== 'en' || !root) return;
    if (root.nodeType === 3) return translateTextNode(root);
    if (root.nodeType !== 1 || SKIP.has(root.nodeName) || root.closest('[data-no-i18n]')) return;
    translateAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.nodeName) || n.hasAttribute('data-no-i18n')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) translateTextNode(n);
      else translateAttrs(n);
    }
  }

  function start() {
    document.documentElement.lang = lang;
    if (lang !== 'en') return;
    translateTree(document.body);
    new MutationObserver((muts) => {
      muts.forEach((m) => {
        if (m.type === 'characterData') translateTextNode(m.target);
        else if (m.type === 'attributes') translateTree(m.target);
        else m.addedNodes.forEach(translateTree);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

    // Native dialogs never touch the DOM.
    const c = window.confirm.bind(window);
    const p = window.prompt.bind(window);
    const a = window.alert.bind(window);
    window.confirm = (msg) => c(translate(String(msg)));
    window.prompt = (msg, def) => p(translate(String(msg)), def);
    window.alert = (msg) => a(translate(String(msg)));
  }

  // Chart.js draws on canvas: translate dataset names, axis titles and labels
  // (only the ones in the dictionary, so data labels stay as they are).
  function hookCharts() {
    if (!window.Chart || hookCharts.done) return;
    hookCharts.done = true;
    window.Chart.register({
      id: 'kssI18n',
      beforeUpdate(chart) {
        if (lang !== 'en') return;
        const d = chart.data || {};
        if (Array.isArray(d.labels)) d.labels = d.labels.map((l) => (typeof l === 'string' ? translate(l) : l));
        (d.datasets || []).forEach((ds) => { if (typeof ds.label === 'string') ds.label = translate(ds.label); });
        Object.values((chart.options && chart.options.scales) || {}).forEach((s) => {
          if (s && s.title && typeof s.title.text === 'string') s.title.text = translate(s.title.text);
        });
      },
    });
  }

  window.I18N = {
    get lang() { return lang; },
    locale: () => (lang === 'en' ? 'en-GB' : 'th-TH'),
    t: translate,
    translateTree,
    hookCharts,
    // Called once the user is known: their saved language wins.
    adopt(next) {
      next = next === 'en' ? 'en' : 'th';
      try { localStorage.setItem('kss_lang', next); } catch (e) { /* ignore */ }
      if (next !== lang) location.reload();
    },
  };
  window.t = translate;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.addEventListener('load', hookCharts);
})();
