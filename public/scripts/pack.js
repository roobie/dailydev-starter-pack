// Client-side pack renderer.
//
// The HTML shell at /pack/<u> arrives in ~100ms with just the header,
// languages chips, and a loading spinner. This script fetches the full
// pack data from the same URL (with ?format=json) and inserts the
// daily.dev sections into the DOM via createElement + textContent — no
// HTML interpolation, no innerHTML for untrusted data, no XSS surface.
//
// Stagger animation defined in styles.css (.fade-in :nth-child) gives the
// sections a "loading one by one" feel even though they share one fetch.

(function () {
  "use strict";

  const root = document.querySelector("[data-pack-root]");
  if (!root) return;
  const username = root.dataset.username;
  if (!username) return;

  const DAILYDEV = "https://app.daily.dev";

  fetch("/pack/" + encodeURIComponent(username) + "?format=json", {
    headers: { Accept: "application/json" },
  })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      render(data);
    })
    .catch(function (err) {
      renderError(String(err && err.message ? err.message : err));
    });

  function render(data) {
    const target = root.querySelector("[data-pack-content]");
    if (!target) return;
    // Clear the loading placeholder; the shell already painted languages.
    target.textContent = "";

    if (!data || !data.ok) {
      target.appendChild(buildError(data && data.error ? data.error : "Pack data missing"));
      return;
    }

    if (data.stage === "github-and-dailydev") {
      target.appendChild(buildTags(data.tags || []));
      target.appendChild(buildSources(data.sources || []));
      target.appendChild(buildArticles(data.articles || []));
      target.appendChild(buildApplyForm(data));
    } else {
      target.appendChild(buildDegraded());
    }
  }

  function renderError(message) {
    const target = root.querySelector("[data-pack-content]");
    if (!target) return;
    target.textContent = "";
    target.appendChild(buildError(message));
  }

  // ---- url safety ----

  function safeUrl(s, allowedHosts) {
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") return "";
      if (allowedHosts && allowedHosts.indexOf(u.hostname) === -1) return "";
      return u.toString();
    } catch (_e) {
      return "";
    }
  }

  // ---- builders (use DOM API to avoid HTML interpolation) ----

  function el(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
  }

  function chip(text, href) {
    const li = el("li", "chip");
    if (href) {
      const a = el("a");
      a.href = href;
      a.rel = "noopener";
      a.textContent = text;
      li.appendChild(a);
    } else {
      li.textContent = text;
    }
    return li;
  }

  function buildTags(tags) {
    const section = el("section", "tags fade-in");
    const h2 = el("h2");
    h2.textContent = "Top tags";
    section.appendChild(h2);
    const ul = el("ul", "chips");
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const li = chip(t.name, DAILYDEV + "/tags/" + encodeURIComponent(t.name));
      const count = el("span", "count");
      count.textContent = "×" + t.count;
      li.appendChild(document.createTextNode(" "));
      li.appendChild(count);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
  }

  function buildSources(sources) {
    const section = el("section", "sources fade-in");
    const h2 = el("h2");
    h2.textContent = "Top sources";
    section.appendChild(h2);
    const ul = el("ul", "chips");
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const li = chip(s.name, DAILYDEV + "/sources/" + encodeURIComponent(s.name));
      const count = el("span", "count");
      count.textContent = "×" + s.count;
      li.appendChild(document.createTextNode(" "));
      li.appendChild(count);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
  }

  function buildArticles(articles) {
    const section = el("section", "articles fade-in");
    const h2 = el("h2");
    h2.textContent = "Sample articles";
    section.appendChild(h2);
    const ol = el("ol", "article-list");
    for (let i = 0; i < articles.length; i++) {
      ol.appendChild(buildArticleItem(articles[i]));
    }
    section.appendChild(ol);
    return section;
  }

  function buildArticleItem(a) {
    const li = el("li", "article");

    const h3 = el("h3");
    const titleLink = el("a");
    titleLink.href = safeUrl(a.url) || "#";
    titleLink.rel = "noopener";
    titleLink.textContent = a.title || "";
    h3.appendChild(titleLink);
    li.appendChild(h3);

    if (a.summary) {
      const p = el("p", "summary");
      p.textContent = a.summary;
      li.appendChild(p);
    }

    const meta = el("p", "meta");
    const freq = el("span", "freq");
    const n = Number(a.frequency) || 0;
    freq.textContent = n + " match" + (n === 1 ? "" : "es");
    meta.appendChild(freq);

    if (a.source) {
      meta.appendChild(document.createTextNode(" "));
      const sourceSpan = el("span", "source");
      sourceSpan.appendChild(document.createTextNode("via "));
      const sourceLink = el("a");
      sourceLink.href = DAILYDEV + "/sources/" + encodeURIComponent(a.source);
      sourceLink.rel = "noopener";
      sourceLink.textContent = a.source;
      sourceSpan.appendChild(sourceLink);
      meta.appendChild(sourceSpan);
    }
    li.appendChild(meta);
    return li;
  }

  function buildApplyForm(data) {
    const uname = data.username;
    const section = el("section", "apply fade-in");
    const h2 = el("h2");
    h2.textContent = "Apply this pack";
    section.appendChild(h2);

    const intro = el("p");
    intro.textContent =
      "Paste your daily.dev Plus PAT to seed your account with these tags, sources, and bookmarks.";
    section.appendChild(intro);

    const form = el("form");
    form.action = "/pack/" + encodeURIComponent(uname) + "/apply";
    form.method = "post";
    form.autocomplete = "off";
    form.spellcheck = false;

    // Hidden payload — what the server needs to issue the 5 writes. The
    // apply endpoint validates shape on the server side; tamper-resistance
    // is not the property we want here (the visitor's PAT only mutates
    // their own daily.dev account).
    const payload = {
      tags: (data.tags || []).map(function (t) { return t.name; }).slice(0, 10),
      sources: (data.sources || []).map(function (s) { return s.name; }).slice(0, 5),
      // 10 is daily.dev's POST /bookmarks/ hard cap; larger batches return 400.
      postIds: (data.articles || []).map(function (a) { return a.id; }).filter(Boolean).slice(0, 10),
      languages: uniqueLanguages(data.repos || []).slice(0, 5),
    };
    const packField = el("input");
    packField.type = "hidden";
    packField.name = "pack";
    packField.value = JSON.stringify(payload);
    form.appendChild(packField);

    const label = el("label");
    label.htmlFor = "pat";
    label.textContent = "daily.dev Plus PAT";
    form.appendChild(label);

    const input = el("input");
    input.type = "password";
    input.id = "pat";
    input.name = "pat";
    input.required = true;
    input.autocomplete = "off";
    form.appendChild(input);

    const submit = el("button");
    submit.type = "submit";
    submit.textContent = "Apply pack";
    form.appendChild(submit);

    section.appendChild(form);

    const note = el("p", "note");
    note.textContent = "Used once for the writes, then discarded. Never stored server-side.";
    section.appendChild(note);
    return section;
  }

  function uniqueLanguages(repos) {
    const seen = Object.create(null);
    const out = [];
    for (let i = 0; i < repos.length; i++) {
      const lang = repos[i] && repos[i].language;
      if (typeof lang !== "string" || !lang) continue;
      if (seen[lang]) continue;
      seen[lang] = true;
      out.push(lang);
    }
    return out;
  }

  function buildDegraded() {
    const section = el("section", "degraded fade-in");
    const h2 = el("h2");
    h2.textContent = "Preview only — GitHub stage";
    section.appendChild(h2);
    const p = el("p");
    p.textContent =
      "This server isn't configured with a daily.dev operator token, so we can only show the GitHub-side derivation. Configure DAILY_DEV_API_TOKEN to see top tags, sources, and sample articles.";
    section.appendChild(p);
    return section;
  }

  function buildError(message) {
    const section = el("section", "degraded fade-in");
    const h2 = el("h2");
    h2.textContent = "Couldn't load pack data";
    section.appendChild(h2);
    const p = el("p");
    p.textContent = message;
    section.appendChild(p);
    return section;
  }
})();
