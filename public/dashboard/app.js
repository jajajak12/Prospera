'use strict';

// ── API ──────────────────────────────────────────────────────────────────────────
const BASE  = import.meta.env.VITE_PROSPERA_API_URL  || location.origin;
const KEY   = import.meta.env.VITE_PROSPERA_API_KEY || '';

async function fetchDashboard() {
  const url = BASE + '/api/dashboard' + (KEY ? `?key=${encodeURIComponent(KEY)}` : '');
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── State ──────────────────────────────────────────────────────────────────────
let data    = {};
let pnlChart = null;

// ── Render ──────────────────────────────────────────────────────────────────
function render(data) {
  renderOverview(data);
  renderScreening(data);
  renderPositions(data);
  renderPnL(data);
  renderLogs(data);
}

function renderOverview(d) {
  $('agent-status').textContent = d.status === 'ok' ? 'Running' : 'Stopped';
  $('agent-dot').style.background = d.status === 'ok' ? '#4ade80' : '#f87171';
  $('circuit-state').textContent = d.circuitState?.isCircuitBroken
    ? `Circuit OPEN (${d.circuitState.cooldownRemainingSec}s)`
    : 'Circuit OK';

  $('provider-badge').textContent = d.activeProvider === 'openrouter' ? 'OpenRouter' : 'MiniMax';
  $('provider-badge').className  = 'badge ' + (d.activeProvider === 'openrouter' ? 'badge-yellow' : 'badge-blue');

  if (d.uptime) {
    const s = Math.round(d.uptime), dd = Math.floor(s/86400), r = s%86400;
    const hh = Math.floor(r/3600), m = Math.floor((r%3600)/60);
    $('uptime-label').textContent = `Uptime ${dd > 0 ? dd+'d ' : ''}${hh}h ${m}m`;
  }

  const ep = d.exposurePct ?? 0;
  $('exposure-pct').textContent = ep + '%';
  $('exposure-bar').style.width  = Math.min(ep, 100) + '%';
  $('exposure-sol').textContent = d.deployedSol ? `${d.deployedSol} SOL deployed` : '';

  const pnl = d.pnlToday ?? 0;
  $('pnl-today').textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%';
  $('pnl-today').className   = 'text-xl font-bold ' + (pnl >= 0 ? 'pnl-pos' : 'pnl-neg');

  $('total-positions').textContent = `${d.totalPositions ?? 0}/${d.maxPositions ?? '?'}`;
  $('llm-zone-count').textContent  = `LLM zone: ${d.llmZone ?? 0}`;
  $('sol-balance').textContent    = d.solBalance != null ? d.solBalance.toFixed(3) + ' SOL' : '—';
  $('sol-price').textContent       = d.solPrice != null ? `$${d.solPrice.toFixed(2)}/SOL` : '';
  $('last-screening').textContent  = relTime(d.lastScreening);
  $('last-management').textContent = relTime(d.lastManagement);
  $('last-briefing').textContent   = relTime(d.lastBriefing);
  $('briefing-date').textContent   = d.briefingDate || '';
}

function renderScreening(d) {
  const s = d.lastScreeningReport || {};
  $('scr-discovered').textContent = s.discovered ?? '—';
  $('scr-aftervol').textContent   = s.afterVolume ?? '—';
  $('scr-pools').textContent      = s.meteoraPools ?? '—';
  $('scr-fibpassed').textContent  = s.fibPassed ?? '—';
  $('scr-report').textContent      = s.content || 'No screening report yet.';

  const cands = s.candidates || [];
  if (!cands.length) { $('scr-candidates').innerHTML = '<p class="text-sm text-slate-500">No candidates.</p>'; return; }
  $('scr-candidates').innerHTML = `
    <table>
      <thead><tr><th>Pair</th><th>Price</th><th>1h Vol</th><th>MCap</th><th>Fib</th><th>Conf</th></tr></thead>
      <tbody>${cands.map(c => `<tr>
        <td>${esc(c.name || c.symbol || '?')}</td>
        <td>${c.price != null ? '$'+c.price.toPrecision(3) : '—'}</td>
        <td>${c.volume_1h != null ? '$'+fmt(c.volume_1h) : '—'}</td>
        <td>${c.market_cap != null ? '$'+fmt(c.market_cap) : '—'}</td>
        <td><span class="badge ${c.signal==='ENTRY'?'badge-green':'badge-yellow'}">${c.signal||'?'}</span></td>
        <td>${c.confluence != null ? c.confluence.toFixed(2) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function renderPositions(d) {
  const pos = d.positions || [];
  $('pos-count').textContent       = pos.length;
  $('pos-llmzone').textContent     = d.llmZone ?? 0;
  $('pos-deterministic').textContent = d.deterministicCount ?? 0;

  if (!pos.length) {
    $('pos-table').innerHTML   = '<p class="text-sm text-slate-500">No open positions.</p>';
  } else {
    $('pos-table').innerHTML = `
      <table>
        <thead><tr><th>Pair</th><th>PnL %</th><th>Range</th><th>Fees</th><th>Value</th></tr></thead>
        <tbody>${pos.map(p => {
          const pnl = p.pnl_pct ?? 0;
          return `<tr>
            <td>${esc(p.pair || '?')}</td>
            <td class="${pnl>=0?'pnl-pos':'pnl-neg'} font-bold">${pnl>=0?'+':''}${pnl.toFixed(2)}%</td>
            <td>${p.in_range
              ? '<span class="badge badge-green">IN</span>'
              : `<span class="badge badge-red">OOR ${p.minutes_out_of_range||0}m</span>`}</td>
            <td>$${(p.unclaimed_fees_usd||0).toFixed(2)}</td>
            <td>$${(p.total_value_usd||0).toFixed(2)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  const closed = d.closedHistory || [];
  if (!closed.length) {
    $('pos-history').innerHTML = '<p class="text-sm text-slate-500">No closed positions yet.</p>';
  } else {
    $('pos-history').innerHTML = `
      <table>
        <thead><tr><th>Pair</th><th>PnL %</th><th>Closed</th></tr></thead>
        <tbody>${closed.map(c => {
          const pnl = c.pnl_pct ?? 0;
          return `<tr>
            <td>${esc(c.pair||'?')}</td>
            <td class="${pnl>=0?'pnl-pos':'pnl-neg'} font-bold">${pnl>=0?'+':''}${pnl.toFixed(2)}%</td>
            <td class="text-slate-500">${c.closedAt ? new Date(c.closedAt).toLocaleString() : '—'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }
}

function renderPnL(d) {
  const s = d.pnlStats || {};
  const pnlTot = parseFloat(s.totalPnl) || 0;
  $('pnl-total').textContent    = (pnlTot >= 0 ? '+' : '') + s.totalPnl + '%';
  $('pnl-total').className      = 'text-2xl font-bold ' + (pnlTot >= 0 ? 'pnl-pos' : 'pnl-neg');
  $('pnl-winrate').textContent  = s.winRate != null ? s.winRate + '%' : '—';
  $('pnl-drawdown').textContent = s.maxDrawdown != null ? s.maxDrawdown + '%' : '—';
  $('pnl-closed').textContent  = s.totalClosed ?? '—';
  renderPnlChart(d.pnlHistory || []);
}

function renderPnlChart(history) {
  const c = $('pnl-chart');
  if (!history.length) { c.style.display = 'none'; return; }
  c.style.display = 'block';

  const byDay = {};
  history.forEach(h => {
    const day = new Date(h.ts).toLocaleDateString('en-CA');
    byDay[day] = (byDay[day] || 0) + h.totalPnl;
  });
  const labels = Object.keys(byDay).slice(-30);
  const vals   = labels.map(d => byDay[d]);

  if (pnlChart) pnlChart.destroy();
  pnlChart = new Chart(c, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'PnL %', data: vals,
        backgroundColor: vals.map(v => v>=0 ? '#22c55e60' : '#ef444460'),
        borderColor:     vals.map(v => v>=0 ? '#22c55e'   : '#ef4444'),
        borderWidth: 1, borderRadius: 4 }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 10 }, grid: { color: '#1f2937' } },
        y: { ticks: { color: '#64748b' }, grid: { color: '#1f2937' } }
      }
    }
  });
}

function renderLogs(d) {
  const logs = d.logs || [];
  if (!logs.length) { $('recent-logs').innerHTML = '<p class="text-sm text-slate-500">No logs.</p>'; return; }
  $('recent-logs').innerHTML = logs.slice(-50).map(l => {
    const cat = (l.cat||'').toLowerCase();
    const cls = cat==='error'||cat==='management_error' ? 'log-error'
              : cat==='warn'||cat==='management_warn'    ? 'log-warn'
              : cat==='management'                      ? 'log-mgmt'
              : cat==='screening'                        ? 'log-scr' : 'log-info';
    return `<div class="log-line ${cls}">
      <span class="log-ts">${new Date(l.ts).toLocaleTimeString()}</span>
      <span class="text-[10px] text-indigo-500 mr-2">[${esc(cat)}]</span>
      ${esc(l.msg||'')}
    </div>`;
  }).join('');
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
const TAB_ORDER = ['overview','screening','positions','pnl'];
function switchTab(tab) {
  TAB_ORDER.forEach(t => {
    const pg = document.getElementById('page-' + t);
    const btn = document.getElementById('tab-'  + t);
    if (t === tab) { pg.classList.remove('hidden'); btn.className = 'tab-btn tab-active'; }
    else          { pg.classList.add('hidden');    btn.className = 'tab-btn tab-inactive'; }
  });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function relTime(ts) {
  if (!ts) return '—';
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60000)  return 'Just now';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

function fmt(n) {
  if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
  return n.toFixed(0);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  try {
    data = await fetchDashboard();
    render(data);
  } catch(e) {
    $('load-err').classList.remove('hidden');
    $('load-err-msg').textContent = 'Gagal fetch data: ' + e.message;
    document.getElementById('overview-grid').style.opacity = '0.3';
  }
}

init();
setInterval(init, 30000);
