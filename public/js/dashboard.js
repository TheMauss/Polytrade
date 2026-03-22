/* Polytrade Dashboard — real-time client */

const socket = io();

// State
let lastData = {};

socket.on("connect", () => {
  updateBadge("online", "Connected");
  // Fetch historical data on connect
  fetchData();
});

socket.on("disconnect", () => {
  updateBadge("offline", "Disconnected");
});

socket.on("update", (data) => {
  lastData = data;
  renderStatus(data.status);
  renderRisk(data.risk);
});

// Poll API for full data every 5s
setInterval(fetchData, 5000);

async function fetchData() {
  try {
    const [opps, trades, metrics] = await Promise.all([
      fetch("/api/opportunities?limit=20").then((r) => r.json()),
      fetch("/api/trades?limit=50").then((r) => r.json()),
      fetch("/api/metrics").then((r) => r.json()),
    ]);
    renderOpportunities(opps);
    renderTrades(trades);
    renderMetrics(metrics);
    document.getElementById("last-update").textContent =
      `Last update: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

// --- Renderers ---

function renderStatus(status) {
  if (!status) return;

  setText("m-open-positions", status.openPositions ?? 0);
  const daily = status.dailyPnl ?? 0;
  setTextWithColor("m-daily-pnl", `$${daily.toFixed(2)}`, daily);

  // Render positions table
  const tbody = document.querySelector("#positions-table tbody");
  tbody.innerHTML = "";
  for (const p of status.positions ?? []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${p.id}</code></td>
      <td><span class="tag tag-${p.type === 'intra_event' ? 'intra' : 'cross'}">${p.type}</span></td>
      <td>${p.legs}</td>
      <td>$${p.invested.toFixed(2)}</td>
      <td class="${p.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${p.pnl.toFixed(4)}</td>
      <td>${p.entryEdge.toFixed(1)}%</td>
      <td>${p.currentEdge.toFixed(1)}%</td>
      <td>${p.ageMinutes.toFixed(0)}m</td>
    `;
    tbody.appendChild(tr);
  }

  // Update badge
  if (status.paused) {
    updateBadge("paused", "Paused");
  } else if (lastData.risk?.killSwitch) {
    updateBadge("killed", "Killed");
  } else {
    updateBadge("online", "Running");
  }
}

function renderRisk(risk) {
  // Could extend to show risk status in UI
}

function renderMetrics(m) {
  if (!m) return;
  setTextWithColor("m-total-pnl", `$${(m.totalPnl ?? 0).toFixed(2)}`, m.totalPnl ?? 0);
  setText("m-win-rate", `${(m.winRate ?? 0).toFixed(1)}%`);
  setText("m-total-trades", m.totalTrades ?? 0);
  setTextWithColor("m-avg-pnl", `$${(m.avgPnl ?? 0).toFixed(4)}`, m.avgPnl ?? 0);
}

function renderOpportunities(opps) {
  const tbody = document.querySelector("#opportunities-table tbody");
  tbody.innerHTML = "";
  for (const o of opps) {
    const tr = document.createElement("tr");
    const time = o.detectedAt ? new Date(o.detectedAt).toLocaleTimeString() : "--";
    const markets = (o.markets ?? []).map((m) => truncate(m, 40)).join(", ");
    tr.innerHTML = `
      <td>${time}</td>
      <td><span class="tag tag-${o.arbType === 'intra_event' ? 'intra' : 'cross'}">${o.arbType}</span></td>
      <td title="${markets}">${truncate(markets, 60)}</td>
      <td>${(o.combinedProb ?? 0).toFixed(3)}</td>
      <td>${(o.grossEdgePct ?? 0).toFixed(1)}%</td>
      <td class="pnl-positive">${(o.netEdgePct ?? 0).toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderTrades(trades) {
  const tbody = document.querySelector("#trades-table tbody");
  tbody.innerHTML = "";
  for (const t of trades) {
    const tr = document.createElement("tr");
    const time = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : "--";
    const pnl = t.pnl ?? 0;
    tr.innerHTML = `
      <td>${time}</td>
      <td><span class="tag tag-${t.action}">${t.action}</span></td>
      <td><code>${t.positionId ?? "--"}</code></td>
      <td>${t.arbType ?? "--"}</td>
      <td>$${(t.totalInvested ?? 0).toFixed(2)}</td>
      <td class="${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${pnl.toFixed(4)}</td>
      <td>${t.reason ?? ""}</td>
    `;
    tbody.appendChild(tr);
  }
}

// --- Controls ---

async function control(action) {
  try {
    await fetch(`/api/control/${action}`, { method: "POST" });
  } catch (err) {
    console.error("Control error:", err);
  }
}

async function updateConfig() {
  const minEdge = document.getElementById("input-min-edge").value;
  try {
    await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ min_edge_pct: Number(minEdge) }),
    });
  } catch (err) {
    console.error("Config error:", err);
  }
}

// --- Helpers ---

function setText(id, value) {
  document.getElementById(id).textContent = String(value);
}

function setTextWithColor(id, text, value) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "metric-value " + (value > 0 ? "positive" : value < 0 ? "negative" : "");
}

function updateBadge(type, text) {
  const el = document.getElementById("status-badge");
  el.textContent = text;
  el.className = `badge badge-${type}`;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}
