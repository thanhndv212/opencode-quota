/**
 * OpenCode Quota — Menubar App Renderer
 *
 * Self-contained vanilla JavaScript application.
 * Uses the quotaApi exposed via Electron contextBridge.
 * No framework dependencies — just DOM APIs.
 */

(function () {
  "use strict";

  const api = window.quotaApi;
  if (!api) {
    document.getElementById("root").innerHTML =
      '<div class="empty-state"><div class="icon">⚠</div><div class="text">quotaApi not available</div><div class="hint">This app must run inside the Electron shell.</div></div>';
    return;
  }

  // ===========================================================================
  // State
  // ===========================================================================
  let activeTab = 0;
  let quotaData = null;
  let tokenData = null;
  let alerts = [];
  let pricingOverrides = [];
  let pricingSnapshot = null;
  let apikeyStatus = null;
  let isLoading = false;
  let toastTimer = null;

  // ===========================================================================
  // DOM helpers
  // ===========================================================================
  const $ = (sel, parent) => (parent || document).querySelector(sel);
  const $$ = (sel, parent) => [...(parent || document).querySelectorAll(sel)];
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "className") e.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k === "disabled") { if (v) e.setAttribute("disabled", ""); }
      else e.setAttribute(k, v);
    });
    children.forEach(c => {
      if (c == null) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  };

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function formatNumber(n) {
    if (n == null) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function showToast(msg, type) {
    const existing = $(".toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);
    const toast = el("div", { className: "toast " + (type === "error" ? "toast-error" : "toast-success") }, msg);
    document.body.appendChild(toast);
    toastTimer = setTimeout(() => toast.remove(), 3000);
  }

  // Global Escape key handler – closes the topmost modal overlay
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlays = $$(".modal-overlay");
    if (overlays.length > 0) overlays[overlays.length - 1].remove();
  });

  // ===========================================================================
  // API calls
  // ===========================================================================
  async function refreshQuota() {
    setLoading(true);
    try {
      quotaData = await api.quota.fetch(true);
    } catch (e) {
      showToast(e.message, "error");
    }
    setLoading(false);
    renderContent();
  }

  async function fetchTokens() {
    setLoading(true);
    try {
      const activeBtn = $(".token-window-select.btn-primary");
      const window = activeBtn?.getAttribute("data-window") || "week";
      tokenData = await api.tokens.query({ window });
    } catch (e) {
      showToast(e.message, "error");
    }
    setLoading(false);
    renderTokenUsage();
  }

  async function loadAlerts() {
    try { alerts = await api.alerts.list(); } catch (e) { /* ignore */ }
    if (activeTab === 2) renderAlerts();
  }

  async function loadPricing() {
    try {
      const data = await api.pricing.list();
      pricingOverrides = data.overrides || [];
      pricingSnapshot = data.snapshot;
    } catch (e) { /* ignore */ }
    if (activeTab === 3) renderPricing();
  }

  async function loadApikeyStatus() {
    try { apikeyStatus = await api.apikeys.status(); } catch (e) { /* ignore */ }
    if (activeTab === 4) renderApiKeys();
  }

  function setLoading(v) {
    isLoading = v;
    const btn = $(".btn-refresh");
    if (btn) { btn.textContent = v ? "⟳ Refreshing..." : "⟳ Refresh"; btn.disabled = v; }
  }

  // ===========================================================================
  // Render engine
  // ===========================================================================
  const root = document.getElementById("root");

  function render() {
    clear(root);
    root.appendChild(renderHeader());
    root.appendChild(renderTabNav());
    const content = el("div", { style: { flex: "1", overflow: "hidden", display: "flex", flexDirection: "column" } });
    root.appendChild(content);

    const contentArea = el("div", { className: "tab-content", style: { flex: "1", overflowY: "auto" } });
    content.appendChild(contentArea);

    renderContentInto(contentArea);
  }

  function renderContentInto(container) {
    clear(container);
    switch (activeTab) {
      case 0: renderDashboardInto(container); break;
      case 1: renderTokenUsageInto(container); break;
      case 2: renderAlertsInto(container); break;
      case 3: renderPricingInto(container); break;
      case 4: renderApiKeysInto(container); break;
    }
  }

  function renderContent() { renderContentInto($(".tab-content")); }

  // ===========================================================================
  // Header
  // ===========================================================================
  function renderHeader() {
    return el("div", { className: "app-header" },
      el("h1", {}, "Quota Monitor"),
      el("div", { className: "header-actions" },
        el("button", { className: "btn btn-small btn-refresh", onClick: refreshQuota }, "⟳ Refresh"),
        el("button", { className: "btn-icon", onClick: () => api.app.quit(), title: "Quit" }, "✕"),
      ),
    );
  }

  // ===========================================================================
  // Tab Nav
  // ===========================================================================
  const TABS = [
    { label: "◉ Dashboard", title: "Dashboard" },
    { label: "⬡ Tokens", title: "Token Usage" },
    { label: "⚠ Alerts", title: "Budget Alerts" },
    { label: "$ Pricing", title: "Pricing" },
    { label: "🔑 API Keys", title: "API Keys" },
  ];

  function getActiveTabTitle() {
    return TABS[activeTab]?.title || "Quota Monitor";
  }

  function renderTabNav() {
    const nav = el("div", { className: "tab-nav" });
    TABS.forEach((tab, i) => {
      nav.appendChild(el("button", {
        className: "tab-btn" + (i === activeTab ? " active" : ""),
        onClick: () => {
          activeTab = i;
          updateHeaderTitle();
          renderContent();
          if (i === 1) fetchTokens();
          if (i === 2) loadAlerts();
          if (i === 3) loadPricing();
          if (i === 4) loadApikeyStatus();
        },
      }, tab.label));
    });
    return nav;
  }

  function updateHeaderTitle() {
    const h1 = $(".app-header h1");
    if (h1) h1.textContent = getActiveTabTitle();
  }

  // ===========================================================================
  // Dashboard
  // ===========================================================================

  // Regex to match OpenCode Go multi-window entries like "OpenCode Go (dvtn) 5h"
  const OPENCODE_GO_ENTRY_RE = /^OpenCode Go \(([^)]+)\) (5h|Weekly|Monthly)$/;

  function parseOpenCodeGoEntry(entry) {
    if (entry.kind === "value") return null;
    const m = (entry.name || "").match(OPENCODE_GO_ENTRY_RE);
    if (!m) return null;
    return { workspace: m[1], window: m[2], entry };
  }

  function groupOpenCodeGoEntries(entries) {
    const groups = new Map();
    const others = [];
    for (const e of entries) {
      const parsed = parseOpenCodeGoEntry(e);
      if (!parsed) { others.push(e); continue; }
      if (!groups.has(parsed.workspace)) groups.set(parsed.workspace, []);
      groups.get(parsed.workspace).push(parsed);
    }
    return { groups, others };
  }

  function renderGroupedOpenCodeGoCard(workspace, windows) {
    const card = el("div", { className: "card" });
    card.appendChild(el("div", { className: "card-title", style: { marginBottom: "10px" } }, "OpenCode Go (" + workspace + ")"));

    // Sort windows: 5h, Weekly, Monthly
    const order = { "5h": 0, "Weekly": 1, "Monthly": 2 };
    windows.sort((a, b) => (order[a.window] || 0) - (order[b.window] || 0));

    // Find the shortest reset time across all windows for the status line
    let shortestReset = "";
    let shortestDiff = Infinity;
    for (const w of windows) {
      if (w.entry.resetTimeIso) {
        const diff = new Date(w.entry.resetTimeIso) - new Date();
        if (diff > 0 && diff < shortestDiff) { shortestDiff = diff; }
      }
    }
    if (shortestDiff > 0 && shortestDiff < Infinity) {
      const h = Math.floor(shortestDiff / 3600000);
      const m = Math.floor((shortestDiff % 3600000) / 60000);
      shortestReset = h > 24 ? Math.floor(h / 24) + "d" : h + "h " + m + "m";
    }

    for (const w of windows) {
      const remaining = Math.max(0, Math.min(100, w.entry.percentRemaining || 0));
      const used = 100 - remaining;
      let barClass = "good";
      if (used >= 90) barClass = "danger";
      else if (used >= 75) barClass = "warning";

      const row = el("div", { style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" } });

      // Window label
      row.appendChild(el("span", { style: { width: "52px", fontSize: "10px", color: "var(--text-secondary)", textAlign: "right", flexShrink: "0" } }, w.window));

      // Mini bar
      const barWrap = el("div", { className: "percent-bar-container", style: { flex: "1", margin: "0", height: "12px" } });
      barWrap.appendChild(el("div", { className: "percent-bar-fill " + barClass, style: { width: used + "%" } }));
      row.appendChild(barWrap);

      // Percentage
      row.appendChild(el("span", { style: { width: "36px", fontSize: "10px", fontFamily: "var(--font-mono)", textAlign: "right", flexShrink: "0", color: "var(--text-primary)" } }, Math.round(used) + "%"));

      card.appendChild(row);
    }

    // Reset countdown
    if (shortestReset) {
      card.appendChild(el("div", { style: { marginTop: "6px", fontSize: "10px", color: "var(--text-muted)", textAlign: "right" } }, "⟳ " + shortestReset));
    }

    return card;
  }

  function renderDashboardInto(container) {
    if (!quotaData) {
      container.appendChild(el("div", { className: "empty-state" },
        el("div", { className: "icon" }, "◉"),
        el("div", { className: "text" }, "No quota data loaded"),
        el("div", { className: "hint" }, "Click Refresh to fetch quota status"),
      ));
      return;
    }

    const entries = quotaData.entries || [];
    const providerIds = quotaData.detectedProviderIds || [];

    // Filter
    const filterBar = el("div", { className: "filter-bar" });
    const sel = el("select", { className: "filter-select", onChange: () => renderContent() });
    sel.appendChild(el("option", { value: "all" }, "All providers (" + entries.length + ")"));
    providerIds.forEach(id => sel.appendChild(el("option", { value: id }, id)));
    filterBar.appendChild(el("div", { className: "filter-group" }, el("span", { className: "filter-label" }, "Provider:"), sel));
    filterBar.appendChild(el("span", { style: { fontSize: "10px", color: "var(--text-muted)", marginLeft: "auto" } }, providerIds.length + " providers"));
    container.appendChild(filterBar);

    const filterVal = sel.value;
    const filtered = filterVal === "all" ? entries : entries.filter(e => e.name && e.name.toLowerCase().includes(filterVal.toLowerCase()));

    // Group OpenCode Go entries by workspace; render others as individual cards
    const { groups, others } = groupOpenCodeGoEntries(filtered);

    // Sort grouped workspaces by Monthly remaining (descending), fall back to best window
    const sortedGroups = [...groups].sort(([, aw], [, bw]) => {
      const monthly = (ws) => ws.find(w => w.window === "Monthly")?.entry.percentRemaining;
      const best = (ws) => Math.max(...ws.map(w => w.entry.percentRemaining ?? 0));
      const aVal = monthly(aw) ?? best(aw);
      const bVal = monthly(bw) ?? best(bw);
      return bVal - aVal;
    });

    // Merge groups and individual cards into one sorted list
    const merged = [
      ...sortedGroups.map(([workspace, windows]) => {
        const monthly = windows.find(w => w.window === "Monthly")?.entry.percentRemaining;
        const best = Math.max(...windows.map(w => w.entry.percentRemaining ?? 0));
        const key = -(monthly ?? best);                                            // negative = sort by remaining desc, groups below value
        return { type: "group", workspace, windows, sortKey: key };
      }),
      ...others.map(entry => ({ type: "card", entry,
        sortKey: entry.percentRemaining == null ? -9999                           // value entry — pin to top
          : entry.percentRemaining > 0 ? -entry.percentRemaining                  // remaining desc
          : 100 })),                                                              // 0% last
    ].sort((a, b) => a.sortKey - b.sortKey);

    for (const item of merged) {
      if (item.type === "group") {
        container.appendChild(renderGroupedOpenCodeGoCard(item.workspace, item.windows));
      } else {
        container.appendChild(renderProviderCard(item.entry));
      }
    }

    if (quotaData.sessionTokens) {
      const st = quotaData.sessionTokens;
      const card = el("div", { className: "card", style: { marginTop: "12px" } });
      card.appendChild(el("div", { className: "card-title" }, "Session Tokens"));
      card.appendChild(renderKV("Input", formatNumber(st.totalInput)));
      card.appendChild(renderKV("Output", formatNumber(st.totalOutput)));
      container.appendChild(card);
    }
  }

  function renderProviderCard(entry) {
    const card = el("div", { className: "card" });
    const header = el("div", { className: "card-header" });
    header.appendChild(el("span", { className: "card-title" }, entry.name));

    if (entry.kind === "value") {
      header.appendChild(el("span", { className: "card-subtitle", style: { fontSize: "12px", color: "var(--accent)" } }, entry.value));
    }
    card.appendChild(header);

    if (entry.kind !== "value" && entry.percentRemaining != null) {
      const remaining = Math.max(0, Math.min(100, entry.percentRemaining));
      const used = 100 - remaining;
      let barClass = "good";
      if (used >= 90) barClass = "danger";
      else if (used >= 75) barClass = "warning";

      const barContainer = el("div", { className: "percent-bar-container" });
      barContainer.appendChild(el("div", { className: "percent-bar-fill " + barClass, style: { width: used + "%" } }));
      card.appendChild(barContainer);

      const label = el("div", { className: "percent-bar-label" });
      label.appendChild(el("span", { className: "value" }, Math.round(used) + "% used"));

      let resetText = "";
      if (entry.resetTimeIso) {
        const diff = new Date(entry.resetTimeIso) - new Date();
        if (diff > 0) {
          const h = Math.floor(diff / 3600000);
          const m = Math.floor((diff % 3600000) / 60000);
          resetText = h > 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h + "h " + m + "m";
        }
      }
      label.appendChild(el("span", { className: "value" }, resetText ? "⟳ " + resetText : ""));
      card.appendChild(label);
    }

    return card;
  }

  // ===========================================================================
  // Token Usage
  // ===========================================================================

  function fmtCompact(n) {
    if (!Number.isFinite(n)) return "0";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (abs >= 1_000_000_000) return sign + (abs / 1_000_000_000).toFixed(1) + "B";
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1) + "M";
    if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + "K";
    return String(Math.trunc(n));
  }

  function fmtUsd(n) {
    if (!Number.isFinite(n)) return "$0.00";
    return "$" + n.toFixed(2);
  }

  function normalizeSourceName(providerID) {
    const p = (providerID || "").toLowerCase();
    if (p.includes("opencode")) return "OpenCode";
    if (p.includes("cursor")) return "Cursor";
    if (p.includes("claude") || p.includes("anthropic")) return "Claude";
    if (p.includes("github") || p.includes("copilot")) return "Copilot";
    if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return "OpenAI";
    if (p.includes("google") || p.includes("antigravity") || p.includes("gemini")) return "Google";
    if (p.includes("azure")) return "Azure";
    return providerID || "Unknown";
  }

  function sourceSortKey(providerID) {
    const s = (providerID || "").toLowerCase();
    if (s === "opencode") return 1;
    if (s === "claude" || s === "anthropic") return 2;
    if (s === "cursor") return 3;
    if (s === "copilot" || s.includes("copilot")) return 4;
    if (s === "openai") return 5;
    if (s.includes("google")) return 6;
    if (s.includes("azure")) return 7;
    return 99;
  }

  function renderTokenUsageInto(container) {
    if (!tokenData) {
      container.appendChild(el("div", { className: "loading-center" },
        el("span", { className: "spinner" }), " Loading token data...",
      ));
      fetchTokens();
      return;
    }

    const agg = tokenData.aggregate || {};
    const totals = agg.totals || {};
    const winLabel = tokenData.window?.label || "Usage";

    // ── Window selector ──────────────────────────────
    const filterBar = el("div", { className: "filter-bar" });
    const windows = [{ v: "day", l: "24h" }, { v: "week", l: "7d" }, { v: "month", l: "30d" }, { v: "all", l: "All" }];
    const group = el("div", { className: "filter-group" }, el("span", { className: "filter-label" }, "Window:"));
    windows.forEach(w => {
      group.appendChild(el("button", {
        className: "btn btn-small token-window-select " + ((tokenData?.window?.label || "").includes(w.l) ? "btn-primary" : ""),
        onClick: () => { fetchTokens(); },
        "data-window": w.v,
      }, w.l));
    });
    filterBar.appendChild(group);
    filterBar.appendChild(el("button", { className: "btn btn-small", onClick: fetchTokens, style: { marginLeft: "auto" } }, "⟳ Refresh"));
    container.appendChild(filterBar);

    // ── Summary card ─────────────────────────────────
    const summary = el("div", { className: "card" });
    summary.appendChild(el("div", { className: "card-title" }, winLabel));

    const priced = totals.priced || {};
    const unknownTok = totals.unknown || {};
    const unpricedTok = totals.unpriced || {};
    const hasCache = (priced.cache_read || 0) + (priced.cache_write || 0) > 0;
    const hasReason = (priced.reasoning || 0) + (unknownTok.reasoning || 0) + (unpricedTok.reasoning || 0) > 0;

    const grid = el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px", marginTop: "6px" } });
    grid.appendChild(renderKV("Messages", formatNumber(totals.messageCount || 0)));
    grid.appendChild(renderKV("Sessions", formatNumber(totals.sessionCount || 0)));
    grid.appendChild(renderKV("Cost", fmtUsd(totals.costUsd), "var(--accent)"));
    grid.appendChild(renderKV("Input Tokens", fmtCompact(priced.input || 0)));
    grid.appendChild(renderKV("Output Tokens", fmtCompact(priced.output || 0)));
    if (hasCache) {
      grid.appendChild(renderKV("Cache Read", fmtCompact(priced.cache_read || 0)));
      grid.appendChild(renderKV("Cache Write", fmtCompact(priced.cache_write || 0)));
    }
    if (hasReason) {
      grid.appendChild(renderKV("Reasoning", fmtCompact(priced.reasoning || 0)));
    }
    summary.appendChild(grid);
    container.appendChild(summary);

    // ── Models table ─────────────────────────────────
    const bySourceModel = agg.bySourceModel || [];
    if (bySourceModel.length > 0) {
      const grouped = new Map();
      for (const row of bySourceModel) {
        const src = normalizeSourceName(row.sourceProviderID);
        if (!grouped.has(src)) grouped.set(src, []);
        grouped.get(src).push(row);
      }

      const sources = [...grouped.keys()].sort((a, b) => {
        const ka = sourceSortKey(a), kb = sourceSortKey(b);
        return ka !== kb ? ka - kb : a.localeCompare(b);
      });

      const modelCard = el("div", { className: "card" });
      modelCard.appendChild(el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Models"));

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Source", "Model", "Input", "Output", "C.Read", "C.Write", "Reason", "Total", "Cost"].forEach(h => {
        hRow.appendChild(el("th", {}, h));
      });
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      for (let si = 0; si < sources.length; si++) {
        const src = sources[si];
        const list = grouped.get(src);
        list.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));

        for (const row of list) {
          const t = row.tokens || {};
          const tr = el("tr");
          [src,
           (row.sourceModelID || "?"),
           fmtCompact(t.input || 0),
           fmtCompact(t.output || 0),
           fmtCompact(t.cache_read || 0),
           fmtCompact(t.cache_write || 0),
           fmtCompact(t.reasoning || 0),
           fmtCompact((t.input||0)+(t.output||0)+(t.cache_read||0)+(t.cache_write||0)+(t.reasoning||0)),
           fmtUsd(row.costUsd)
          ].forEach((v, i) => {
            tr.appendChild(el("td", { className: i >= 2 && i <= 7 ? "num-col" : i === 8 ? "cost-col" : "text-col" }, v));
          });
          tbody.appendChild(tr);
        }

        // Separator row between sources
        if (si < sources.length - 1) {
          const sep = el("tr");
          sep.appendChild(el("td", { colSpan: 9, style: { padding: "2px 0" } }, ""));
          tbody.appendChild(sep);
        }
      }
      table.appendChild(tbody);
      modelCard.appendChild(table);
      container.appendChild(modelCard);
    }

    // ── Top Sessions ─────────────────────────────────
    const sessions = (agg.bySession || []).filter(s => (s.costUsd || 0) > 0 || (s.messageCount || 0) > 0);
    if (sessions.length > 0) {
      const top = sessions.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, 10);
      const sessCard = el("div", { className: "card" });
      sessCard.appendChild(el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Top Sessions"));

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Session", "Cost", "Tokens", "Msgs", "Title"].forEach(h => hRow.appendChild(el("th", {}, h)));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      top.forEach(row => {
        const tr = el("tr");
        tr.appendChild(el("td", { className: "text-col", style: { fontFamily: "var(--font-mono)", fontSize: "9px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis" } }, row.sessionID || "-"));
        tr.appendChild(el("td", { className: "cost-col" }, fmtUsd(row.costUsd)));
        tr.appendChild(el("td", { className: "num-col" }, fmtCompact((row.tokens?.input||0)+(row.tokens?.output||0)+(row.tokens?.cache_read||0)+(row.tokens?.cache_write||0)+(row.tokens?.reasoning||0))));
        tr.appendChild(el("td", { className: "num-col" }, formatNumber(row.messageCount || 0)));
        tr.appendChild(el("td", { className: "text-col", style: { maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (row.title || "").trim().slice(0, 30) || "(untitled)"));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      sessCard.appendChild(table);
      container.appendChild(sessCard);
    }

    // ── Unpriced Models ──────────────────────────────
    const unpriced = agg.unpriced || [];
    if (unpriced.length > 0) {
      const card = el("div", { className: "card" });
      card.appendChild(el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Unpriced Models (" + unpriced.length + ")"));

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Source", "Model", "Tokens", "Msgs"].forEach(h => hRow.appendChild(el("th", {}, h)));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      unpriced.slice(0, 20).forEach(u => {
        const tr = el("tr");
        tr.appendChild(el("td", { className: "text-col" }, normalizeSourceName(u.key?.sourceProviderID)));
        tr.appendChild(el("td", { className: "text-col", style: { fontFamily: "var(--font-mono)", fontSize: "10px" } }, u.key?.sourceModelID || "?"));
        tr.appendChild(el("td", { className: "num-col" }, fmtCompact((u.tokens?.input||0)+(u.tokens?.output||0))));
        tr.appendChild(el("td", { className: "num-col" }, formatNumber(u.messageCount || 0)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
      card.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "8px" } }, "Add custom pricing in the Pricing tab."));
      container.appendChild(card);
    }

    // ── Unknown Pricing ──────────────────────────────
    const unknown = agg.unknown || [];
    if (unknown.length > 0) {
      const card = el("div", { className: "card" });
      card.appendChild(el("div", { className: "card-title", style: { marginBottom: "8px" } }, "Unknown Pricing (" + unknown.length + ")"));

      const table = el("table", { className: "data-table" });
      const thead = el("thead");
      const hRow = el("tr");
      ["Source", "Model", "Tokens", "Msgs"].forEach(h => hRow.appendChild(el("th", {}, h)));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = el("tbody");
      unknown.slice(0, 20).forEach(u => {
        const tr = el("tr");
        tr.appendChild(el("td", { className: "text-col" }, normalizeSourceName(u.key?.sourceProviderID)));
        tr.appendChild(el("td", { className: "text-col", style: { fontFamily: "var(--font-mono)", fontSize: "10px" } }, u.key?.sourceModelID || "?"));
        tr.appendChild(el("td", { className: "num-col" }, fmtCompact((u.tokens?.input||0)+(u.tokens?.output||0))));
        tr.appendChild(el("td", { className: "num-col" }, formatNumber(u.messageCount || 0)));
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
      card.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "8px" } }, "Run /quota_status for full pricing diagnostics."));
      container.appendChild(card);
    }
  }

  function renderTokenUsage() { const c = $(".tab-content"); if (c) { clear(c); renderTokenUsageInto(c); } }

  // ===========================================================================
  // Budget Alerts
  // ===========================================================================
  function renderAlertsInto(container) {
    const header = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" } });
    header.appendChild(el("span", { style: { fontSize: "12px", color: "var(--text-secondary)" } }, alerts.length + " rule" + (alerts.length !== 1 ? "s" : "")));
    header.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: showCreateAlertModal }, "+ New Alert"));
    container.appendChild(header);

    if (alerts.length === 0) {
      container.appendChild(el("div", { className: "empty-state" },
        el("div", { className: "icon" }, "⚠"),
        el("div", { className: "text" }, "No budget alerts configured"),
        el("div", { className: "hint" }, "Create alerts to monitor your token spending"),
      ));
      return;
    }

    alerts.forEach(alert => {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, alert.name));
      hdr.appendChild(el("span", { className: "tag " + (alert.enabled ? "tag-green" : "tag-gray") }, alert.enabled ? "ON" : "OFF"));
      card.appendChild(hdr);
      card.appendChild(renderKV("Scope", (alert.scope?.type || "global") + (alert.scope?.providerId ? "/" + alert.scope.providerId : "")));
      card.appendChild(renderKV("Threshold", (alert.metric === "cost_usd" ? "$" : "") + alert.threshold + " " + (alert.metric || "").replace(/_/g, " ")));
      card.appendChild(renderKV("Window", alert.window));
      card.appendChild(el("div", { style: { marginTop: "8px" } },
        el("button", { className: "btn btn-small btn-danger", onClick: () => deleteAlert(alert.id) }, "Delete"),
      ));
      container.appendChild(card);
    });
  }

  function renderAlerts() { const c = $(".tab-content"); if (c) { clear(c); renderAlertsInto(c); } }

  async function deleteAlert(id) {
    try { await api.alerts.delete(id); showToast("Alert deleted"); await loadAlerts(); } catch (e) { showToast(e.message, "error"); }
  }

  function showCreateAlertModal() {
    const overlay = el("div", { className: "modal-overlay", onClick: e => { if (e.target === overlay) overlay.remove(); } });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "New Budget Alert"));

    const fields = [
      ["Name", "text", "name", ""],
      ["Scope Type", "select", "scopeType", "global", ["global", "provider", "model"]],
      ["Provider ID", "text", "scopeProviderId", ""],
      ["Model ID", "text", "scopeModelId", ""],
      ["Window", "select", "window", "day", ["day", "week", "month", "all"]],
      ["Metric", "select", "metric", "cost_usd", ["cost_usd", "tokens_total", "tokens_input", "tokens_output"]],
      ["Threshold", "number", "threshold", "1"],
      ["Direction", "select", "direction", "above", ["above", "below"]],
    ];

    const values = {};
    fields.forEach(([label, type, key, def, opts]) => {
      values[key] = def;
      const group = el("div", { className: "form-group" });
      group.appendChild(el("label", { className: "form-label" }, label));
      if (type === "select" && opts) {
        const s = el("select", { className: "filter-select", style: { width: "100%" }, onChange: e => values[key] = e.target.value });
        opts.forEach(o => s.appendChild(el("option", { value: o }, o)));
        group.appendChild(s);
      } else {
        group.appendChild(el("input", { className: "form-input", type: type, placeholder: "", onInput: e => values[key] = type === "number" ? parseFloat(e.target.value) || 0 : e.target.value }));
      }
      modal.appendChild(group);
    });

    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"));
    actions.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: async () => {
      try {
        await api.alerts.create({
          name: values["name"] || "New Alert",
          scope: { type: values["scopeType"], providerId: values["scopeProviderId"] || undefined, modelId: values["scopeModelId"] || undefined },
          window: values["window"],
          metric: values["metric"],
          threshold: values["threshold"],
          direction: values["direction"],
        });
        showToast("Alert created");
        overlay.remove();
        await loadAlerts();
      } catch (e) { showToast(e.message, "error"); }
    } }, "Create"));
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // Pricing Editor
  // ===========================================================================
  function renderPricingInto(container) {
    if (pricingSnapshot) {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, "Pricing Snapshot"));
      hdr.appendChild(el("span", { className: "tag " + (pricingSnapshot.stale ? "tag-yellow" : "tag-green") }, pricingSnapshot.stale ? "STALE" : "FRESH"));
      card.appendChild(hdr);
      card.appendChild(renderKV("Updated", pricingSnapshot.generatedAt ? new Date(pricingSnapshot.generatedAt).toLocaleDateString() : "never"));
      card.appendChild(renderKV("Providers", String(pricingSnapshot.providerCount || 0)));
      card.appendChild(renderKV("Models", String(pricingSnapshot.modelCount || 0)));
      container.appendChild(card);
    }

    const hdr = el("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } });
    hdr.appendChild(el("span", { style: { fontSize: "12px", color: "var(--text-secondary)" } }, pricingOverrides.length + " override" + (pricingOverrides.length !== 1 ? "s" : "")));
    hdr.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: showAddPricingModal }, "+ Add Override"));
    container.appendChild(hdr);

    pricingOverrides.forEach(o => {
      const card = el("div", { className: "card" });
      const ch = el("div", { className: "card-header" });
      ch.appendChild(el("span", { className: "card-title" }, o.provider + "/" + o.model));
      ch.appendChild(el("button", { className: "btn btn-small btn-danger", onClick: async () => {
        try { await api.pricing.delete(o.provider, o.model); showToast("Override removed"); await loadPricing(); } catch (e) { showToast(e.message, "error"); }
      } }, "✕"));
      card.appendChild(ch);
      const rates = o.rates || {};
      const g = el("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "4px", fontSize: "10px" } });
      if (rates.input != null) g.appendChild(renderKV("Input", "$" + rates.input + "/1M"));
      if (rates.output != null) g.appendChild(renderKV("Output", "$" + rates.output + "/1M"));
      if (rates.cache_read != null) g.appendChild(renderKV("Cache Read", "$" + rates.cache_read + "/1M"));
      if (rates.cache_write != null) g.appendChild(renderKV("Cache Write", "$" + rates.cache_write + "/1M"));
      if (rates.reasoning != null) g.appendChild(renderKV("Reasoning", "$" + rates.reasoning + "/1M"));
      card.appendChild(g);
      if (o.label) card.appendChild(el("div", { style: { fontSize: "10px", color: "var(--text-muted)", marginTop: "4px" } }, o.label));
      container.appendChild(card);
    });
  }

  function renderPricing() { const c = $(".tab-content"); if (c) { clear(c); renderPricingInto(c); } }

  function showAddPricingModal() {
    const overlay = el("div", { className: "modal-overlay", onClick: e => { if (e.target === overlay) overlay.remove(); } });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "Add Pricing Override"));
    const vals = {};
    [
      ["Provider", "text", "provider", ""],
      ["Model", "text", "model", ""],
      ["Input ($/1M tokens)", "number", "input", ""],
      ["Output ($/1M tokens)", "number", "output", ""],
      ["Cache Read ($/1M)", "number", "cache_read", ""],
      ["Cache Write ($/1M)", "number", "cache_write", ""],
      ["Reasoning ($/1M)", "number", "reasoning", ""],
      ["Label (optional)", "text", "label", ""],
    ].forEach(([label, type, key, def]) => {
      vals[key] = def;
      const g = el("div", { className: "form-group" });
      g.appendChild(el("label", { className: "form-label" }, label));
      g.appendChild(el("input", { className: "form-input", type: type, placeholder: "", onInput: e => vals[key] = type === "number" ? e.target.value : e.target.value }));
      modal.appendChild(g);
    });
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"));
    actions.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: async () => {
      const rates = {};
      if (vals["input"]) rates.input = parseFloat(vals["input"]);
      if (vals["output"]) rates.output = parseFloat(vals["output"]);
      if (vals["cache_read"]) rates.cache_read = parseFloat(vals["cache_read"]);
      if (vals["cache_write"]) rates.cache_write = parseFloat(vals["cache_write"]);
      if (vals["reasoning"]) rates.reasoning = parseFloat(vals["reasoning"]);
      try {
        await api.pricing.save({ provider: vals["provider"], model: vals["model"], rates, label: vals["label"] || undefined });
        showToast("Override saved"); overlay.remove(); await loadPricing();
      } catch (e) { showToast(e.message, "error"); }
    } }, "Save"));
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // API Keys
  // ===========================================================================
  function renderApiKeysInto(container) {
    if (!apikeyStatus) {
      container.appendChild(el("div", { className: "loading-center" }, el("span", { className: "spinner" }), " Loading..."));
      return;
    }

    if (apikeyStatus.state === "empty") {
      container.appendChild(el("div", { className: "empty-state" },
        el("div", { className: "icon" }, "🔑"),
        el("div", { className: "text" }, "No API key store found"),
        el("div", { className: "hint" }, "Create an encrypted store to manage your provider API keys"),
        el("button", { className: "btn btn-primary", style: { marginTop: "12px" }, onClick: showInitStoreModal }, "Create Key Store"),
      ));
      return;
    }

    if (apikeyStatus.state === "locked") {
      const card = el("div", { className: "card" });
      const hdr = el("div", { className: "card-header" });
      hdr.appendChild(el("span", { className: "card-title" }, "Key Store Locked"));
      hdr.appendChild(el("span", { className: "tag tag-yellow" }, "🔒 LOCKED"));
      card.appendChild(hdr);
      card.appendChild(el("div", { style: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "8px" } }, (apikeyStatus.providerCount || 0) + " key(s) stored"));
      card.appendChild(el("button", { className: "btn btn-primary", onClick: showUnlockModal }, "Unlock with Passphrase"));
      container.appendChild(card);
      return;
    }

    if (apikeyStatus.state === "unlocked") {
      const actions = el("div", { style: { display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" } });
      actions.appendChild(el("button", { className: "btn btn-small", onClick: showAddKeyModal }, "+ Add Key"));
      actions.appendChild(el("button", { className: "btn btn-small", onClick: showExportModal }, "↗ Export"));
      actions.appendChild(el("button", { className: "btn btn-small", onClick: async () => { await api.apikeys.lock(); await loadApikeyStatus(); showToast("Store locked"); } }, "🔒 Lock"));
      container.appendChild(actions);

      const providers = apikeyStatus.providers || [];
      if (providers.length === 0) {
        container.appendChild(el("div", { className: "empty-state" },
          el("div", { className: "text" }, "No API keys stored"),
          el("div", { className: "hint" }, "Add keys for providers like OpenAI, Anthropic, etc."),
        ));
      }
      providers.forEach(info => {
        const card = el("div", { className: "card" });
        const hdr = el("div", { className: "card-header" });
        hdr.appendChild(el("span", { className: "card-title" }, info.providerId));
        hdr.appendChild(el("span", { className: "tag " + (info.hasKey ? "tag-green" : "tag-gray") }, info.hasKey ? "STORED" : "EMPTY"));
        card.appendChild(hdr);
        card.appendChild(renderKV("Label", info.label || "-"));
        card.appendChild(renderKV("Updated", new Date(info.updatedAt).toLocaleDateString()));
        card.appendChild(el("div", { style: { marginTop: "8px" } },
          el("button", { className: "btn btn-small btn-danger", onClick: async () => {
            try { await api.apikeys.delete(info.providerId); showToast("Key deleted"); await loadApikeyStatus(); } catch (e) { showToast(e.message, "error"); }
          } }, "Delete"),
        ));
        container.appendChild(card);
      });
    }
  }

  function renderApiKeys() { const c = $(".tab-content"); if (c) { clear(c); renderApiKeysInto(c); } }

  function showInitStoreModal() {
    showPassphraseModal("Create API Key Store", "Set a master passphrase to encrypt your API keys at rest.", async (pass) => {
      await api.apikeys.init(pass);
      showToast("Key store initialized");
      await loadApikeyStatus();
    });
  }

  function showUnlockModal() {
    showPassphraseModal("Unlock Key Store", "Enter your master passphrase.", async (pass) => {
      await api.apikeys.unlock(pass);
      showToast("Key store unlocked");
      await loadApikeyStatus();
    });
  }

  function showExportModal() {
    showPassphraseModal("Export API Keys", "Set a one-time passphrase to encrypt the export file.", async (pass) => {
      const result = await api.apikeys.export(pass);
      const blob = new Blob([JSON.stringify(result.bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = result.defaultFileName; a.click();
      URL.revokeObjectURL(url);
      showToast("Keys exported");
    });
  }

  function showAddKeyModal() {
    const overlay = el("div", { className: "modal-overlay", onClick: e => { if (e.target === overlay) overlay.remove(); } });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, "Add API Key"));
    const vals = { providerId: "", apiKey: "", label: "" };
    [
      ["Provider ID", "text", "providerId", "e.g. openai, anthropic"],
      ["API Key", "password", "apiKey", "sk-..."],
      ["Label (optional)", "text", "label", "e.g. Work account"],
    ].forEach(([label, type, key, placeholder]) => {
      const g = el("div", { className: "form-group" });
      g.appendChild(el("label", { className: "form-label" }, label));
      g.appendChild(el("input", { className: "form-input", type: type, placeholder: placeholder, onInput: e => vals[key] = e.target.value }));
      modal.appendChild(g);
    });
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"));
    actions.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: async () => {
      try {
        await api.apikeys.save(vals.providerId, vals.apiKey, vals.label || undefined);
        showToast("API key saved"); overlay.remove(); await loadApikeyStatus();
      } catch (e) { showToast(e.message, "error"); }
    } }, "Save"));
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showPassphraseModal(title, desc, onConfirm) {
    const overlay = el("div", { className: "modal-overlay", onClick: e => { if (e.target === overlay) overlay.remove(); } });
    const modal = el("div", { className: "modal" });
    modal.appendChild(el("div", { className: "modal-title" }, title));
    if (desc) modal.appendChild(el("div", { style: { fontSize: "11px", color: "var(--text-secondary)", marginBottom: "12px" } }, desc));
    let pass = "";
    const g = el("div", { className: "form-group" });
    g.appendChild(el("label", { className: "form-label" }, "Passphrase"));
    g.appendChild(el("input", { className: "form-input", type: "password", placeholder: "Enter passphrase", onInput: e => pass = e.target.value }));
    modal.appendChild(g);
    const actions = el("div", { className: "modal-actions" });
    actions.appendChild(el("button", { className: "btn btn-small", onClick: () => overlay.remove() }, "Cancel"));
    actions.appendChild(el("button", { className: "btn btn-small btn-primary", onClick: async () => {
      try { await onConfirm(pass); overlay.remove(); } catch (e) { showToast(e.message, "error"); }
    } }, "Confirm"));
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================
  function renderKV(key, value, color) {
    const row = el("div", { className: "kv-row" });
    row.appendChild(el("span", { className: "key" }, key));
    row.appendChild(el("span", { className: "value", style: color ? { color } : {} }, value));
    return row;
  }

  // ===========================================================================
  // Init
  // ===========================================================================
  function init() {
    render();
    refreshQuota();
    loadAlerts();
    loadPricing();
    loadApikeyStatus();

    // Listen for refresh events from main process
    if (api.app.onRefresh) {
      api.app.onRefresh(() => refreshQuota());
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
