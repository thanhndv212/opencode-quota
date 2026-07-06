// OpenCode Quota Dashboard - Frontend Logic

let burndownChart = null;
let modelChart = null;

// Chart.js doesn't pick up CSS custom properties, so mirror the theme here.
if (typeof Chart !== 'undefined') {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  Chart.defaults.color = isDark ? '#909296' : '#666';
  Chart.defaults.borderColor = isDark ? '#373a40' : '#ddd';
}

const KNOWN_PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  google: 'Google',
};

function labelForProvider(provider) {
  return KNOWN_PROVIDER_LABELS[provider] || provider;
}

/**
 * Replaces the provider <select>'s hardcoded options with the real set of
 * providers that actually have data, fetched from the backend. A static
 * list drifts as providers are added/renamed (this app supports many:
 * Anthropic, OpenAI, DeepSeek, Z.ai, Moonshot, Cursor, GitHub Copilot,
 * OpenRouter, Google, and more) — silently omitting one the user has real
 * data for makes the dashboard look empty for no visible reason. Falls
 * back to the static HTML options (unmodified) if the fetch fails or no
 * provider has recorded any data yet (fresh install).
 */
async function populateProviderSelect() {
  const providerSelect = document.getElementById('provider-select');
  try {
    const res = await fetch('/api/dashboard/providers');
    if (!res.ok) return;
    const { providers } = await res.json();
    if (!providers || providers.length === 0) return;

    providerSelect.innerHTML = '';
    for (const provider of providers) {
      const option = document.createElement('option');
      option.value = provider;
      option.textContent = labelForProvider(provider);
      option.selected = true; // default to showing everything that actually has data
      providerSelect.appendChild(option);
    }
  } catch {
    // Network error — keep the static fallback options already in the HTML.
  }
}

async function fetchDashboardData() {
  const providerSelect = document.getElementById('provider-select');
  const providers = Array.from(providerSelect.selectedOptions).map((opt) => opt.value);
  const days = parseInt(document.getElementById('timerange-select').value, 10);

  const res = await fetch(`/api/dashboard/summary?providers=${providers.join(',')}&days=${days}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.statusText}`);
  }
  return res.json();
}

function renderQuotaCards(providers) {
  const container = document.getElementById('quota-cards');
  container.innerHTML = '';

  if (!providers || providers.length === 0) {
    container.innerHTML = '<div class="loading">No providers selected</div>';
    return;
  }

  let hasAnyQuota = false;

  providers.forEach((providerData) => {
    const quota = providerData.currentQuota;
    if (!quota || !quota.limits || quota.limits.length === 0) {
      return;
    }

    hasAnyQuota = true;

    quota.limits.forEach((limit) => {
      const card = document.createElement('div');
      card.className = 'quota-card';

      const color = limit.percent > 70 ? 'green' : limit.percent > 30 ? 'yellow' : 'red';
      const resetTime = formatResetTime(limit.resets_at);
      const kindLabel = formatLimitKind(limit.kind);

      card.innerHTML = `
        <h3>${providerData.provider} · ${kindLabel}</h3>
        <div class="quota-bar">
          <div class="quota-bar-fill ${color}" style="width: ${limit.percent}%"></div>
        </div>
        <div class="quota-meta">
          <span>${limit.percent}% remaining</span>
          <span>resets ${resetTime}</span>
        </div>
      `;

      container.appendChild(card);
    });
  });

  if (!hasAnyQuota) {
    container.innerHTML =
      '<div class="loading">No quota data available. Run some AI sessions first.</div>';
  }
}

function renderBurndownChart(providers) {
  const ctx = document.getElementById('burndown-chart');
  if (!ctx) {
    console.error('renderBurndownChart: #burndown-chart canvas not found in DOM');
    return;
  }

  if (burndownChart) {
    burndownChart.destroy();
  }

  const datasets = providers
    .filter((p) => p.quotaHistory && p.quotaHistory.length > 0)
    .map((providerData) => ({
      label: providerData.provider,
      data: providerData.quotaHistory.map((h) => ({
        x: new Date(h.timestamp),
        y: h.percentRemaining,
      })),
      borderColor: getProviderColor(providerData.provider),
      backgroundColor: getProviderColor(providerData.provider, 0.1),
      tension: 0.1,
      fill: false,
    }));

  if (datasets.length === 0) {
    ctx.parentElement.innerHTML = '<p class="loading">No historical quota data yet. Check back after running some sessions.</p>';
    return;
  }

  burndownChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        x: {
          type: 'time',
          time: { unit: 'day' },
          title: { display: true, text: 'Date' },
        },
        y: {
          beginAtZero: true,
          max: 100,
          title: { display: true, text: '% Remaining' },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
          },
        },
      },
    },
  });
}

function renderModelChart(providers) {
  const ctx = document.getElementById('model-chart');
  if (!ctx) {
    console.error('renderModelChart: #model-chart canvas not found in DOM');
    return;
  }

  if (modelChart) {
    modelChart.destroy();
  }

  // Aggregate models across providers
  const modelMap = new Map();
  providers.forEach((providerData) => {
    if (providerData.modelBreakdown) {
      providerData.modelBreakdown.forEach((model) => {
        if (!modelMap.has(model.model)) {
          modelMap.set(model.model, 0);
        }
        modelMap.set(model.model, modelMap.get(model.model) + model.costUsd);
      });
    }
  });

  const sortedModels = Array.from(modelMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10); // Top 10

  if (sortedModels.length === 0) {
    ctx.parentElement.innerHTML = '<p class="loading">No usage data yet. Run some AI sessions to see model breakdown.</p>';
    return;
  }

  modelChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sortedModels.map(([model]) => model),
      datasets: [
        {
          label: 'Cost (USD)',
          data: sortedModels.map(([, cost]) => cost),
          backgroundColor: 'rgba(54, 162, 235, 0.6)',
          borderColor: 'rgba(54, 162, 235, 1)',
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Cost (USD)' },
        },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `$${ctx.parsed.y.toFixed(3)}`,
          },
        },
      },
    },
  });
}

function renderResetHistory(providers) {
  const tbody = document.querySelector('#reset-history-table tbody');
  tbody.innerHTML = '';

  // Combine resets from all providers
  const allResets = providers.flatMap((p) =>
    (p.weeklyResets || []).map((r) => ({ ...r, provider: p.provider }))
  );

  if (allResets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="loading">No reset history available yet</td></tr>';
    return;
  }

  allResets.sort((a, b) => b.reset_at - a.reset_at);

  allResets.forEach((reset) => {
    const utilization = reset.quota_used;
    const badge = utilization > 80 ? 'high' : utilization > 50 ? 'medium' : 'low';
    const badgeText = utilization > 80 ? 'High' : utilization > 50 ? 'Medium' : 'Low';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${reset.provider}</td>
      <td>${formatDate(reset.reset_at)}</td>
      <td>${utilization.toFixed(1)}%</td>
      <td>${reset.quota_remaining.toFixed(1)}%</td>
      <td><span class="utilization-badge ${badge}">${badgeText}</span></td>
    `;
    tbody.appendChild(row);
  });
}

async function renderDashboard() {
  try {
    const data = await fetchDashboardData();

    renderQuotaCards(data.providers);
    renderBurndownChart(data.providers);
    renderModelChart(data.providers);
    renderResetHistory(data.providers);
  } catch (err) {
    console.error('Failed to render dashboard:', err);
    const container = document.querySelector('.container');
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = `Failed to load dashboard: ${err.message}. Make sure quota tracking is running.`;
    container.insertBefore(errorDiv, container.firstChild);
  }
}

// Helpers
function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatResetTime(isoString) {
  const resetAt = new Date(isoString);
  const now = new Date();
  const diffMs = resetAt - now;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d`;
  if (diffHours > 0) return `${diffHours}h`;
  if (diffMs > 0) return '<1h';
  return 'now';
}

function formatLimitKind(kind) {
  const labels = {
    session: '5-Hour',
    weekly_all: '7-Day',
    weekly_scoped: '7-Day (Model)',
    monthly: 'Monthly',
    seven_day_fable: 'Fable 7-Day',
  };
  return labels[kind] || kind.replace(/_/g, ' ');
}

function getProviderColor(provider, alpha = 1) {
  const colors = {
    anthropic: `rgba(255, 99, 132, ${alpha})`,
    openai: `rgba(54, 162, 235, ${alpha})`,
    deepseek: `rgba(75, 192, 192, ${alpha})`,
    openrouter: `rgba(255, 206, 86, ${alpha})`,
    google: `rgba(153, 102, 255, ${alpha})`,
  };
  return colors[provider] || `rgba(201, 203, 207, ${alpha})`;
}

// Event listeners
document.getElementById('refresh-btn').addEventListener('click', renderDashboard);
document.getElementById('provider-select').addEventListener('change', renderDashboard);
document.getElementById('timerange-select').addEventListener('change', renderDashboard);

// Initial render
populateProviderSelect().then(renderDashboard);

// Auto-refresh every 5 minutes
setInterval(renderDashboard, 5 * 60 * 1000);
