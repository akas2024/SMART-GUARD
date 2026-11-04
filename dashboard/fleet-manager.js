/* ==========================================================================
   SMARTGUARD - FLEET MANAGEMENT CONTROLLER
   Purpose: Handles Helmet Fleet CRUD, Live Sensor Polling on Demand,
            Horizontal Card Rendering, Search, and Status Filtering.
   ========================================================================== */

const STORAGE_KEY = "smartguard_helmets_fleet";

// Active connected helmet runtime state (Defaults to null: show Connect button by default)
let activeConnectedHelmetId = null;
let heartbeatTimer = null;
let consecutiveFailures = 0;

// Starter demo helmets if none exist in browser storage
const defaultHelmets = [
  {
    id: "HLM-05",
    name: "Akash Patil",
    zone: "Zone C - Chemical Storage",
    blood: "A+",
    status: "NORMAL",
    battery: "100%",
    heartRate: "75 BPM",
    contact: "WORN",
    lastSync: "Just now",
    ip: "192.168.4.1"
  },
  {
    id: "HLM-01",
    name: "Alex Mercer",
    zone: "Zone A - Scaffold Tower",
    blood: "O+",
    status: "NORMAL",
    battery: "94%",
    heartRate: "74 BPM",
    contact: "WORN",
    lastSync: "Just now",
    ip: "192.168.4.1"
  },
  {
    id: "HLM-02",
    name: "Rahul Sharma",
    zone: "Zone B - Excavation Pit",
    blood: "B+",
    status: "NORMAL",
    battery: "88%",
    heartRate: "78 BPM",
    contact: "WORN",
    lastSync: "2m ago",
    ip: "192.168.4.1"
  },
  {
    id: "HLM-03",
    name: "David Chen",
    zone: "Zone C - Chemical Storage",
    blood: "A+",
    status: "WARNING",
    battery: "62%",
    heartRate: "89 BPM",
    contact: "WORN",
    lastSync: "5m ago",
    ip: "192.168.4.1"
  },
  {
    id: "HLM-04",
    name: "Marcus Vance",
    zone: "Zone D - Welding Bay",
    blood: "AB+",
    status: "OFFLINE",
    battery: "15%",
    heartRate: "--",
    contact: "NOT WORN",
    lastSync: "12m ago",
    ip: "192.168.4.1"
  }
];

let fleetData = [];

// Load from LocalStorage
function loadFleetData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      fleetData = JSON.parse(saved);
      // Ensure HLM-05 Akash Patil exists if user had previous storage
      if (!fleetData.some((h) => h.id === "HLM-05")) {
        fleetData.unshift(defaultHelmets[0]);
        saveFleetData();
      }
    } catch (e) {
      fleetData = defaultHelmets;
    }
  } else {
    fleetData = defaultHelmets;
    saveFleetData();
  }
}

// Save to LocalStorage
function saveFleetData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fleetData));
}

// DOM Elements
const fleetGrid = document.getElementById("fleetGrid");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const zoneFilter = document.getElementById("zoneFilter");

const helmetModal = document.getElementById("helmetModal");
const helmetForm = document.getElementById("helmetForm");
const modalTitle = document.getElementById("modalTitle");
const editIndex = document.getElementById("editIndex");

const helmetIdInput = document.getElementById("helmetIdInput");
const workerNameInput = document.getElementById("workerNameInput");
const workerZoneInput = document.getElementById("workerZoneInput");
const bloodGroupInput = document.getElementById("bloodGroupInput");
const helmetIpInput = document.getElementById("helmetIpInput");
const statusInput = document.getElementById("statusInput");

const openAddModalBtn = document.getElementById("openAddModalBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const cancelModalBtn = document.getElementById("cancelModalBtn");

// Connect Modal Elements
const connectModal = document.getElementById("connectModal");
const connectModalTitle = document.getElementById("connectModalTitle");
const connectModalSubtitle = document.getElementById("connectModalSubtitle");
const connectIpInput = document.getElementById("connectIpInput");
const pingResultBox = document.getElementById("pingResultBox");
let activeConnectingHelmetId = null;

// Render Helmets in a sleek Horizontal Row Layout (not blockwise)
function renderFleet(highlightId = null) {
  const searchTerm = (searchInput.value || "").trim().toLowerCase();
  const selectedStatus = statusFilter.value;
  const selectedZone = zoneFilter.value;

  fleetGrid.innerHTML = "";

  const filtered = fleetData.filter((helmet) => {
    const matchSearch =
      helmet.id.toLowerCase().includes(searchTerm) ||
      helmet.name.toLowerCase().includes(searchTerm);

    const matchStatus =
      selectedStatus === "ALL" || helmet.status === selectedStatus;

    const matchZone =
      selectedZone === "ALL" || helmet.zone === selectedZone;

    return matchSearch && matchStatus && matchZone;
  });

  if (filtered.length === 0) {
    emptyState.style.display = "block";
    return;
  }

  emptyState.style.display = "none";

  // Only connected if actively connected in runtime session
  const activeHelmetId = activeConnectedHelmetId;

  filtered.forEach((helmet) => {
    // Map status classes
    let statusClass = "status-normal";
    let statusText = "🟢 Normal";
    if (helmet.status === "WARNING") {
      statusClass = "status-warning";
      statusText = "🟡 Warning";
    } else if (helmet.status === "DANGER") {
      statusClass = "status-danger";
      statusText = "🔴 Critical Alert";
    } else if (helmet.status === "OFFLINE") {
      statusClass = "status-offline";
      statusText = "⚪ Offline";
    }

    const isConnected = (helmet.id === activeHelmetId);

    const card = document.createElement("article");
    card.className = "helmet-card" + (isConnected ? " is-connected-card" : "") + (highlightId && helmet.id === highlightId ? " live-updated" : "");
    card.id = `card-${escapeHtml(helmet.id)}`;
    card.innerHTML = `
      <!-- Left Column: Identity & Worker Details -->
      <div class="helmet-info-col">
        <div class="helmet-header-badges">
          <span class="helmet-id-badge">${escapeHtml(helmet.id)}</span>
          ${isConnected ? `<span class="connected-status-pill">🟢 Connected</span>` : ""}
          <span class="status-badge ${statusClass}">${statusText}</span>
          <span class="helmet-ip-badge" title="Configured ESP32 IP">📡 ${escapeHtml(helmet.ip || "192.168.4.1")}</span>
        </div>
        <h3 class="worker-name">${escapeHtml(helmet.name)}</h3>
        <p class="worker-zone">${escapeHtml(helmet.zone)} · Blood: ${escapeHtml(helmet.blood || "N/A")}</p>
        <span class="sync-time-badge">🕒 Synced: ${escapeHtml(helmet.lastSync || "Just now")}</span>
      </div>

      <!-- Middle Column: Horizontal Vitals Snapshot -->
      <div class="vitals-preview-row">
        <div class="vitals-mini-item">
          <p>Heart Rate</p>
          <h5 id="hr-${escapeHtml(helmet.id)}">${escapeHtml(helmet.heartRate || "75 BPM")}</h5>
        </div>
        <div class="vitals-mini-item">
          <p>Placement</p>
          <h5 id="contact-${escapeHtml(helmet.id)}">${escapeHtml(helmet.contact || "WORN")}</h5>
        </div>
        <div class="vitals-mini-item">
          <p>Battery</p>
          <h5>${escapeHtml(helmet.battery || "100%")}</h5>
        </div>
      </div>

      <!-- Right Column: Horizontal Action Buttons -->
      <div class="helmet-card-actions">
        <!-- Connect / Disconnect Helmet Button -->
        ${isConnected ? `
        <button type="button" class="btn-connected-helmet" id="disconnBtn-${escapeHtml(helmet.id)}" title="Connected to ESP32. Click or Hover to Disconnect" onclick="disconnectHelmet('${escapeHtml(helmet.id)}')">
          <span class="btn-connected-view">
            <span class="connected-dot"></span>
            <span>Connected</span>
          </span>
          <span class="btn-disconnect-view">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
              <line x1="12" y1="2" x2="12" y2="12"></line>
            </svg>
            <span>Disconnect</span>
          </span>
        </button>
        ` : `
        <button type="button" class="btn-connect-helmet" id="connBtn-${escapeHtml(helmet.id)}" title="Connect to this Helmet's ESP32" onclick="connectHelmetDirectly('${escapeHtml(helmet.id)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <span>Connect Helmet</span>
        </button>
        `}

        <a href="live-telemetry.html?id=${encodeURIComponent(helmet.id)}&name=${encodeURIComponent(helmet.name)}&ip=${encodeURIComponent(helmet.ip || '192.168.4.1')}" class="btn-monitor" onclick="setActiveHelmetSession('${escapeHtml(helmet.id)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span>Monitor</span>
        </a>

        <div class="helmet-btn-icons-group">
          <button type="button" class="btn-icon-action" title="Edit Helmet Details" onclick="openEditModal('${escapeHtml(helmet.id)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>

          <button type="button" class="btn-icon-action btn-icon-danger" title="Delete Helmet" onclick="deleteHelmet('${escapeHtml(helmet.id)}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    fleetGrid.appendChild(card);
  });
}

// Check Live Sensor Status Immediately from ESP32 /api
async function checkLiveSensorStatus(helmetId) {
  const btn = document.getElementById(`syncBtn-${helmetId}`);
  let origContent = "";
  if (btn) {
    origContent = btn.innerHTML;
    btn.classList.add("syncing");
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="spin-anim" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
        <line x1="2" y1="12" x2="6" y2="12"/>
        <line x1="18" y1="12" x2="22" y2="12"/>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
      </svg>
      <span>Fetching Sensor...</span>
    `;
  }

  const idx = fleetData.findIndex((h) => h.id === helmetId);
  const targetIp = (idx !== -1 && fleetData[idx].ip) ? fleetData[idx].ip : "192.168.4.1";
  const url = (window.location.hostname && targetIp === window.location.hostname) ? "/api" : `http://${targetIp}/api`;

  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (idx !== -1) {
      // Determine Heart Rate string
      let hrStr = "--";
      if (data.fingerDetected && data.heartRate > 0) {
        hrStr = `${data.heartRate} BPM`;
      } else if (data.fingerDetected) {
        hrStr = "Detecting...";
      } else {
        hrStr = "-- (No contact)";
      }

      // Determine Contact string
      const contactStr = data.fingerDetected ? "WORN" : "NOT WORN";

      // Determine Status
      let newStatus = "NORMAL";
      if (data.emergencyActive || data.motionAlert) {
        newStatus = "DANGER";
      } else if (data.environmentWarning) {
        newStatus = "WARNING";
      } else if (!data.mpuOK && !data.maxOK) {
        newStatus = "OFFLINE";
      }

      fleetData[idx].heartRate = hrStr;
      fleetData[idx].contact = contactStr;
      fleetData[idx].status = newStatus;
      fleetData[idx].lastSync = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      saveFleetData();
      renderFleet(helmetId);
    }
  } catch (err) {
    alert("Could not reach ESP32 sensor. Please verify your phone or laptop is connected to the 'SmartGuard-ESP32' Wi-Fi network.");
    if (btn) {
      btn.classList.remove("syncing");
      btn.disabled = false;
      btn.innerHTML = origContent;
    }
  }
}

window.checkLiveSensorStatus = checkLiveSensorStatus;

// Global Toolbar Sync All Helmets Live
async function checkAllHelmetsLive(isSilent = false) {
  const syncAllBtn = document.getElementById("syncAllBtn");
  let origText = "";
  if (!isSilent && syncAllBtn) {
    origText = syncAllBtn.innerHTML;
    syncAllBtn.disabled = true;
    syncAllBtn.innerHTML = `
      <svg class="spin-anim" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="2" x2="12" y2="6"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
        <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
        <line x1="2" y1="12" x2="6" y2="12"/>
        <line x1="18" y1="12" x2="22" y2="12"/>
        <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
        <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
      </svg>
      <span>Syncing Sensors...</span>
    `;
  }

  try {
    const res = await fetch("/api", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let hrStr = data.fingerDetected && data.heartRate > 0 ? `${data.heartRate} BPM` : (data.fingerDetected ? "Detecting..." : "--");
    let contactStr = data.fingerDetected ? "WORN" : "NOT WORN";
    let newStatus = (data.emergencyActive || data.motionAlert) ? "DANGER" : (data.environmentWarning ? "WARNING" : "NORMAL");

    // Update active primary helmet
    if (fleetData.length > 0) {
      fleetData[0].heartRate = hrStr;
      fleetData[0].contact = contactStr;
      fleetData[0].status = newStatus;
      fleetData[0].lastSync = timeNow;
    }

    saveFleetData();
    renderFleet(fleetData.length > 0 ? fleetData[0].id : null);
  } catch (err) {
    if (!isSilent) {
      alert("Could not contact ESP32. Please ensure you are connected to SmartGuard-ESP32 Wi-Fi.");
    }
  } finally {
    if (!isSilent && syncAllBtn) {
      syncAllBtn.disabled = false;
      syncAllBtn.innerHTML = origText;
    }
  }
}
window.checkAllHelmetsLive = checkAllHelmetsLive;

// Automatically monitor sensors every 5 minutes in background
const AUTO_MONITOR_MS = 5 * 60 * 1000;
setInterval(() => {
  console.log("[SmartGuard] 5-minute background auto monitor running...");
  checkAllHelmetsLive(true);
}, AUTO_MONITOR_MS);

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Tab Switching between Search & Manual in Add Worker Helmet Modal
function switchHelmetModalTab(tab) {
  const tabBtnSearch = document.getElementById("tabBtnSearch");
  const tabBtnManual = document.getElementById("tabBtnManual");
  const tabContentSearch = document.getElementById("tabContentSearch");
  const tabContentManual = document.getElementById("tabContentManual");

  if (tab === "search") {
    if (tabBtnSearch) tabBtnSearch.classList.add("active");
    if (tabBtnManual) tabBtnManual.classList.remove("active");
    if (tabContentSearch) tabContentSearch.style.display = "block";
    if (tabContentManual) tabContentManual.style.display = "none";
    if (scanSubnetSelect && window.location.hostname && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      scanSubnetSelect.value = "AUTO";
    }
  } else {
    if (tabBtnSearch) tabBtnSearch.classList.remove("active");
    if (tabBtnManual) tabBtnManual.classList.add("active");
    if (tabContentSearch) tabContentSearch.style.display = "none";
    if (tabContentManual) tabContentManual.style.display = "block";
    if (isDiscoveryScanning && discoveryAbortController) {
      discoveryAbortController.abort();
      isDiscoveryScanning = false;
      if (startScanBtn) startScanBtn.classList.remove("scanning");
      if (scanBtnLabel) scanBtnLabel.textContent = "Start Network Scan";
    }
  }
}
window.switchHelmetModalTab = switchHelmetModalTab;

// Modal Handlers
function openAddModal() {
  modalTitle.textContent = "Add Worker Helmet";
  const modalSubtitle = document.getElementById("modalSubtitle");
  if (modalSubtitle) modalSubtitle.textContent = "Search for active helmets on your network or connect manually.";
  editIndex.value = "-1";
  helmetForm.reset();
  helmetIdInput.disabled = false;
  if (helmetIpInput) helmetIpInput.value = "192.168.4.1";

  const tabsNav = document.getElementById("helmetModalTabs");
  if (tabsNav) tabsNav.style.display = "flex";

  switchHelmetModalTab("search");
  helmetModal.classList.add("open");
}

function openEditModal(helmetId) {
  const index = fleetData.findIndex((h) => h.id === helmetId);
  if (index === -1) return;

  const item = fleetData[index];
  modalTitle.textContent = `Edit Helmet (${item.id})`;
  const modalSubtitle = document.getElementById("modalSubtitle");
  if (modalSubtitle) modalSubtitle.textContent = "Update worker assignment, zone, and ESP32 IP.";
  editIndex.value = String(index);

  helmetIdInput.value = item.id;
  helmetIdInput.disabled = true; // Helmet hardware ID is primary key
  workerNameInput.value = item.name;
  workerZoneInput.value = item.zone;
  bloodGroupInput.value = item.blood || "O+";
  if (helmetIpInput) helmetIpInput.value = item.ip || "192.168.4.1";
  statusInput.value = item.status || "NORMAL";

  const tabsNav = document.getElementById("helmetModalTabs");
  if (tabsNav) tabsNav.style.display = "none";

  switchHelmetModalTab("manual");
  helmetModal.classList.add("open");
}

window.openEditModal = openEditModal;

function closeModal() {
  if (isDiscoveryScanning && discoveryAbortController) {
    discoveryAbortController.abort();
    isDiscoveryScanning = false;
    if (startScanBtn) startScanBtn.classList.remove("scanning");
    if (scanBtnLabel) scanBtnLabel.textContent = "Start Network Scan";
  }
  helmetModal.classList.remove("open");
  helmetIdInput.disabled = false;
}
window.closeModal = closeModal;

// Delete Helmet
function deleteHelmet(helmetId) {
  const target = fleetData.find((h) => h.id === helmetId);
  if (!target) return;

  const confirmed = window.confirm(
    `Are you sure you want to delete Helmet "${target.id}" assigned to "${target.name}"?`
  );

  if (confirmed) {
    fleetData = fleetData.filter((h) => h.id !== helmetId);
    saveFleetData();
    renderFleet();
  }
}

window.deleteHelmet = deleteHelmet;

// Connect Helmet Modal functions
function openConnectModal(helmetId) {
  activeConnectingHelmetId = helmetId;
  const item = fleetData.find((h) => h.id === helmetId);
  if (!item) return;

  if (connectModalTitle) connectModalTitle.textContent = `Connect to ${item.id}`;
  if (connectModalSubtitle) connectModalSubtitle.textContent = `Assigned to: ${item.name} (${item.zone})`;
  if (connectIpInput) connectIpInput.value = item.ip || "192.168.4.1";
  if (pingResultBox) {
    pingResultBox.style.display = "none";
    pingResultBox.textContent = "";
  }

  if (connectModal) connectModal.classList.add("open");
}
window.openConnectModal = openConnectModal;

function closeConnectModal() {
  if (connectModal) connectModal.classList.remove("open");
  activeConnectingHelmetId = null;
}
window.closeConnectModal = closeConnectModal;

async function testPingInModal() {
  const ip = (connectIpInput ? connectIpInput.value.trim() : "") || "192.168.4.1";
  const pingBtn = document.getElementById("pingBtn");
  if (pingBtn) pingBtn.disabled = true;

  if (pingResultBox) {
    pingResultBox.style.display = "block";
    pingResultBox.style.background = "#eff6ff";
    pingResultBox.style.color = "#1d4ed8";
    pingResultBox.style.border = "1px solid #bfdbfe";
    pingResultBox.textContent = `⏳ Pinging http://${ip}/api...`;
  }

  const t0 = performance.now();
  try {
    const url = (window.location.hostname && ip === window.location.hostname) ? "/api" : `http://${ip}/api`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ms = Math.round(performance.now() - t0);

    if (pingResultBox) {
      pingResultBox.style.background = "#ecfdf5";
      pingResultBox.style.color = "#047857";
      pingResultBox.style.border = "1px solid #a7f3d0";
      pingResultBox.innerHTML = `🟢 <b>Success!</b> Helmet reachable (${ms}ms ping). Battery: ${data.battery || '100%'}, Status: ${data.emergencyActive ? '🔴 Alert' : '🟢 Normal'}`;
    }
  } catch (err) {
    if (pingResultBox) {
      pingResultBox.style.background = "#fef2f2";
      pingResultBox.style.color = "#b91c1c";
      pingResultBox.style.border = "1px solid #fecaca";
      pingResultBox.innerHTML = `🔴 <b>Unreachable</b> at http://${ip}/api.<br><small style="font-weight: 500;">Ensure phone/PC is connected to Wi-Fi SSID <b>SmartGuard-ESP32</b> (pass: <code>guard1234</code>) or site router.</small>`;
    }
  } finally {
    if (pingBtn) pingBtn.disabled = false;
  }
}
window.testPingInModal = testPingInModal;

function saveAndConnectHelmet() {
  if (!activeConnectingHelmetId) return;
  const ipVal = (connectIpInput ? connectIpInput.value.trim() : "") || "192.168.4.1";
  const helmetId = activeConnectingHelmetId;

  const idx = fleetData.findIndex((h) => h.id === helmetId);
  if (idx !== -1) {
    fleetData[idx].ip = ipVal;
    saveFleetData();
    localStorage.removeItem("smartguard_is_disconnected");
    activeConnectedHelmetId = fleetData[idx].id;
    localStorage.setItem("smartguard_active_ip", ipVal);
    localStorage.setItem("smartguard_active_helmet_id", fleetData[idx].id);
    localStorage.setItem("smartguard_active_worker_name", fleetData[idx].name);
    localStorage.setItem("smartguard_active_zone", fleetData[idx].zone || "Zone C - Chemical Storage");
    renderFleet(helmetId);
    startHeartbeatMonitor(activeConnectedHelmetId);
  }

  closeConnectModal();

  // Connect to ESP32 to fetch live sensor values directly onto the card (without auto-opening monitor tab)
  connectHelmetDirectly(helmetId);
}
window.saveAndConnectHelmet = saveAndConnectHelmet;

function setActiveHelmetSession(helmetId) {
  const h = fleetData.find((item) => item.id === helmetId);
  if (h) {
    activeConnectedHelmetId = h.id;
    localStorage.removeItem("smartguard_is_disconnected");
    localStorage.setItem("smartguard_active_helmet_id", h.id);
    localStorage.setItem("smartguard_active_worker_name", h.name);
    localStorage.setItem("smartguard_active_zone", h.zone || "Zone C - Chemical Storage");
    localStorage.setItem("smartguard_active_ip", h.ip || "192.168.4.1");
    if (typeof renderFleet === "function") {
      renderFleet(h.id);
    }
    startHeartbeatMonitor(h.id);
  }
}
function disconnectHelmet(helmetId) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  activeConnectedHelmetId = null;
  localStorage.removeItem("smartguard_active_helmet_id");
  localStorage.setItem("smartguard_is_disconnected", "true");

  const item = fleetData.find((h) => h.id === helmetId);
  const name = item ? item.name : helmetId;

  renderFleet();

  const gatewayBtnText = document.getElementById("gatewayBtnText");
  if (gatewayBtnText) {
    const prev = gatewayBtnText.textContent;
    gatewayBtnText.textContent = `Disconnected ${name}`;
    setTimeout(() => {
      gatewayBtnText.textContent = prev;
    }, 2500);
  }
}
window.disconnectHelmet = disconnectHelmet;

// Connect directly to ESP32, pull live values, and start auto-disconnection heartbeat
async function connectHelmetDirectly(helmetId) {
  const helmet = fleetData.find((h) => h.id === helmetId);
  if (!helmet) return;

  const btn = document.getElementById(`connBtn-${helmetId}`);
  let origHtml = "";
  if (btn) {
    origHtml = btn.innerHTML;
  }

  const ip = helmet.ip || "192.168.4.1";

  // Connect immediately on the web page & save active session
  activeConnectedHelmetId = helmet.id;
  localStorage.removeItem("smartguard_is_disconnected");
  localStorage.setItem("smartguard_active_helmet_id", helmet.id);
  localStorage.setItem("smartguard_active_worker_name", helmet.name);
  localStorage.setItem("smartguard_active_ip", ip);
  localStorage.setItem("smartguard_active_zone", helmet.zone || "Zone C - Chemical Storage");

  // Re-render card with live values and Disconnect button
  renderFleet(helmet.id);

  // Start auto-heartbeat to verify Wi-Fi connection continuously
  startHeartbeatMonitor(helmet.id);

  const url = (window.location.hostname && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) ? "/api" : `http://${ip}/api`;

  try {
    let res;
    try {
      res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
    } catch (e) {
      if (url !== "/api" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
        res = await fetch("/api", { cache: "no-store", signal: AbortSignal.timeout(3500) });
      } else {
        throw e;
      }
    }

    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "Failed"}`);
    const data = await res.json();

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let hrStr = data.fingerDetected && data.heartRate > 0 ? `${data.heartRate} BPM` : (data.fingerDetected ? "Detecting..." : "--");
    let contactStr = data.fingerDetected ? "WORN" : "NOT WORN";
    let newStatus = (data.emergencyActive || data.motionAlert) ? "DANGER" : (data.environmentWarning ? "WARNING" : "NORMAL");

    helmet.heartRate = hrStr;
    helmet.contact = contactStr;
    helmet.status = newStatus;
    helmet.lastSync = timeNow;
    if (data.batteryPercent !== undefined) {
      helmet.battery = `${data.batteryPercent}%`;
    }

    saveFleetData();
    renderFleet(helmet.id);
  } catch (err) {
    console.warn(`[SmartGuard] Attempting to connect to ESP32 at ${ip}... (no blocking popup)`, err);
  }
}
window.connectHelmetDirectly = connectHelmetDirectly;

// Auto-Heartbeat Monitor: Detects when Wi-Fi is turned off or disconnected and automatically flips button back to Connect
function startHeartbeatMonitor(helmetId) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  consecutiveFailures = 0;

  heartbeatTimer = setInterval(async () => {
    if (activeConnectedHelmetId !== helmetId) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;
    }

    const helmet = fleetData.find((h) => h.id === helmetId);
    if (!helmet) return;

    const ip = helmet.ip || "192.168.4.1";
    const url = (window.location.hostname && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) ? "/api" : `http://${ip}/api`;

    try {
      let res;
      try {
        res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
      } catch (e) {
        if (url !== "/api" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
          res = await fetch("/api", { cache: "no-store", signal: AbortSignal.timeout(2000) });
        } else {
          throw e;
        }
      }

      if (!res || !res.ok) throw new Error("Unreachable");
      const data = await res.json();
      consecutiveFailures = 0;

      // Update live vitals in real time
      const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let hrStr = data.fingerDetected && data.heartRate > 0 ? `${data.heartRate} BPM` : (data.fingerDetected ? "Detecting..." : "--");
      let contactStr = data.fingerDetected ? "WORN" : "NOT WORN";
      let newStatus = (data.emergencyActive || data.motionAlert) ? "DANGER" : (data.environmentWarning ? "WARNING" : "NORMAL");

      helmet.heartRate = hrStr;
      helmet.contact = contactStr;
      helmet.status = newStatus;
      helmet.lastSync = timeNow;

      const hrEl = document.getElementById(`hr-${helmet.id}`);
      const contactEl = document.getElementById(`contact-${helmet.id}`);
      if (hrEl) hrEl.textContent = hrStr;
      if (contactEl) contactEl.textContent = contactStr;
    } catch (netErr) {
      consecutiveFailures++;
      // If Wi-Fi is turned off or disconnected for > 15 seconds (6 consecutive failures):
      if (consecutiveFailures >= 6) {
        console.warn(`[SmartGuard] Wi-Fi turned off or ESP32 disconnected. Auto-disconnecting ${helmetId}...`);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        activeConnectedHelmetId = null;
        localStorage.removeItem("smartguard_active_helmet_id");
        localStorage.setItem("smartguard_is_disconnected", "true");

        // Mark helmet as OFFLINE
        helmet.status = "OFFLINE";
        helmet.lastSync = "Wi-Fi disconnected";
        saveFleetData();

        // Automatically flip button back to "Connect Helmet"
        renderFleet();
      }
    }
  }, 2500);
}

// Browser network event listeners
window.addEventListener("offline", () => {
  if (activeConnectedHelmetId) {
    disconnectHelmet(activeConnectedHelmetId);
  }
});


window.setActiveHelmetSession = setActiveHelmetSession;

async function testEsp32Gateway() {
  const btn = document.getElementById("testGatewayBtn");
  const dot = document.getElementById("gatewayStatusDot");
  const btnText = document.getElementById("gatewayBtnText");

  if (btnText) btnText.textContent = "Pinging 192.168.4.1...";
  const t0 = performance.now();

  try {
    const url = (window.location.hostname && window.location.hostname === "192.168.4.1") ? "/api" : "http://192.168.4.1/api";
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error();
    const ms = Math.round(performance.now() - t0);
    if (dot) dot.className = "status-dot connected";
    if (btnText) btnText.textContent = `Online (${ms}ms ping)`;
  } catch (e) {
    if (dot) dot.className = "status-dot offline";
    if (btnText) btnText.textContent = "Unreachable (Check Wi-Fi)";
    alert("Could not reach ESP32 at 192.168.4.1. Please connect your phone/laptop Wi-Fi to 'SmartGuard-ESP32' (password: guard1234).");
  }
}
window.testEsp32Gateway = testEsp32Gateway;

// =====================================================
// ACTIVE HELMET DISCOVERY & NETWORK SCANNER
// =====================================================
const discoveryModal = document.getElementById("discoveryModal");
const scanSubnetSelect = document.getElementById("scanSubnetSelect");
const customScanInput = document.getElementById("customScanInput");
const startScanBtn = document.getElementById("startScanBtn");
const scanBtnLabel = document.getElementById("scanBtnLabel");
const scanProgressBarWrap = document.getElementById("scanProgressBarWrap");
const scanStatusText = document.getElementById("scanStatusText");
const scanPercentText = document.getElementById("scanPercentText");
const scanProgressFill = document.getElementById("scanProgressFill");
const discoveredCount = document.getElementById("discoveredCount");
const discoveredHelmetsList = document.getElementById("discoveredHelmetsList");

let isDiscoveryScanning = false;
let discoveryAbortController = null;
let foundHelmetsMap = new Map(); // ip -> { ip, data, latency }

function openDiscoveryModal() {
  openAddModal();
  switchHelmetModalTab("search");
}
window.openDiscoveryModal = openDiscoveryModal;

function closeDiscoveryModal() {
  closeModal();
}
window.closeDiscoveryModal = closeDiscoveryModal;

function onScanSubnetChange() {
  if (!scanSubnetSelect || !customScanInput) return;
  if (scanSubnetSelect.value === "CUSTOM") {
    customScanInput.style.display = "block";
    customScanInput.focus();
  } else {
    customScanInput.style.display = "none";
  }
}
window.onScanSubnetChange = onScanSubnetChange;

function getSubnetPrefix() {
  if (!scanSubnetSelect) return "192.168.4.";
  const val = scanSubnetSelect.value;
  if (val === "CUSTOM") {
    let custom = (customScanInput ? customScanInput.value.trim() : "");
    if (!custom) return "192.168.1.";
    if (!custom.endsWith(".") && custom.split(".").length === 3) custom += ".";
    return custom;
  }
  if (val === "AUTO") {
    const host = window.location.hostname;
    if (host && host.includes(".") && !host.includes("localhost") && !host.includes("127.0.0.1")) {
      const parts = host.split(".");
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.`;
      }
    }
    return "192.168.4.";
  }
  return val;
}

async function probeHelmetIp(ip, signal) {
  const startTime = performance.now();
  const url = (window.location.hostname && ip === window.location.hostname) ? "/api" : `http://${ip}/api`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const latency = Math.round(performance.now() - startTime);
  return { ip, data, latency };
}

async function startHelmetDiscovery() {
  if (isDiscoveryScanning) {
    if (discoveryAbortController) discoveryAbortController.abort();
    isDiscoveryScanning = false;
    if (scanBtnLabel) scanBtnLabel.textContent = "Start Network Scan";
    if (scanStatusText) scanStatusText.textContent = "Scan stopped by user.";
    if (startScanBtn) startScanBtn.classList.remove("scanning");
    return;
  }

  isDiscoveryScanning = true;
  discoveryAbortController = new AbortController();
  const signal = discoveryAbortController.signal;

  if (startScanBtn) startScanBtn.classList.add("scanning");
  if (scanBtnLabel) scanBtnLabel.textContent = "Stop Scanning";
  if (scanProgressBarWrap) scanProgressBarWrap.style.display = "block";

  foundHelmetsMap.clear();
  renderDiscoveredList();

  // Automatically build target IP list to probe across all common environment channels
  const targets = new Set();

  // 1. Direct Hotspot AP addresses (192.168.4.1 is the primary ESP32 SoftAP IP)
  for (let i = 1; i <= 6; i++) targets.add(`192.168.4.${i}`);

  // 2. Current browser host subnet (if viewing site from a router-assigned IP)
  const host = window.location.hostname;
  if (host && host.includes(".") && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    const parts = host.split(".");
    if (parts.length === 4) {
      const currentSubnet = `${parts[0]}.${parts[1]}.${parts[2]}.`;
      targets.add(host);
      for (let i = 1; i <= 50; i++) targets.add(`${currentSubnet}${i}`);
      for (const h of [100, 101, 102, 103, 104, 105, 110, 120]) targets.add(`${currentSubnet}${h}`);
    }
  }

  // 3. Common site router subnets (192.168.1.x and 192.168.0.x)
  for (let i = 1; i <= 30; i++) {
    targets.add(`192.168.1.${i}`);
    targets.add(`192.168.0.${i}`);
  }
  for (const h of [100, 101, 102, 103, 104, 105]) {
    targets.add(`192.168.1.${h}`);
    targets.add(`192.168.0.${h}`);
  }

  const ipList = Array.from(targets);
  const total = ipList.length;
  let scannedCount = 0;
  const BATCH_SIZE = 6; // smaller batch size so ESP32 single-thread webserver is not overwhelmed

  try {
    // 1. Immediately probe the primary ESP32 Hotspot address first
    try {
      const prioritySignal = AbortSignal.timeout(2500);
      const prioResult = await probeHelmetIp("192.168.4.1", prioritySignal);
      foundHelmetsMap.set("192.168.4.1", prioResult);
      renderDiscoveredList();
    } catch (e) {
      // 192.168.4.1 not on hotspot or unreachable
    }

    // 2. Probe remaining environment addresses
    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (signal.aborted) break;

      const chunk = ipList.slice(i, i + BATCH_SIZE);
      const promises = chunk.map(async (ip) => {
        try {
          const timeoutSignal = AbortSignal.timeout(2000);
          const result = await probeHelmetIp(ip, timeoutSignal);
          foundHelmetsMap.set(ip, result);
          renderDiscoveredList();
        } catch (e) {
          // not found or offline
        }
      });

      await Promise.all(promises);
      scannedCount = Math.min(total, i + BATCH_SIZE);
      const percent = Math.round((scannedCount / total) * 100);

      if (scanProgressFill) scanProgressFill.style.width = `${percent}%`;
      if (scanPercentText) scanPercentText.textContent = `${percent}%`;
      if (scanStatusText) scanStatusText.textContent = `Scanning environment devices... ${scannedCount} of ${total} checked (${foundHelmetsMap.size} found)`;
    }

    if (scanStatusText) {
      scanStatusText.textContent = `Scan complete. Found ${foundHelmetsMap.size} active helmet(s) nearby.`;
    }
  } catch (err) {
    if (scanStatusText) scanStatusText.textContent = "Scan completed.";
  } finally {
    isDiscoveryScanning = false;
    if (startScanBtn) startScanBtn.classList.remove("scanning");
    if (scanBtnLabel) scanBtnLabel.textContent = "🔍 Re-Scan for Nearby Helmets";
  }
}
window.startHelmetDiscovery = startHelmetDiscovery;

function renderDiscoveredList() {
  if (!discoveredHelmetsList) return;
  const count = foundHelmetsMap.size;
  if (discoveredCount) discoveredCount.textContent = count;

  if (count === 0) {
    discoveredHelmetsList.innerHTML = `
      <div class="discovery-empty-placeholder">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 8px;">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p style="font-size: 13.5px; font-weight: 800; color: #334155; margin-bottom: 4px;">Searching for active helmets...</p>
        <p style="font-size: 12px; color: #64748b; margin: 0; max-width: 420px; line-height: 1.5;">Ensure your SmartGuard helmet battery is turned on and connected to the Wi-Fi network.</p>
      </div>
    `;
    return;
  }

  discoveredHelmetsList.innerHTML = "";
  foundHelmetsMap.forEach(({ ip, data, latency }) => {
    const rawId = data.deviceId || `HLM-${ip.split(".").pop().padStart(2, "0")}`;
    const rawName = data.deviceName || `Worker (${rawId})`;
    const inFleet = fleetData.some((h) => h.ip === ip || h.id.toUpperCase() === rawId.toUpperCase());

    const hr = (data.heartRate && data.heartRate > 0) ? `${Math.round(data.heartRate)} BPM` : (data.fingerDetected ? "Reading..." : "NO CONTACT");
    const temp = (data.temperatureC && data.temperatureC > -100) ? `${data.temperatureC.toFixed(1)}°C` : "--";
    const motion = data.emergencyActive ? "🔴 SOS ALERT" : (data.motionAlert ? "🟡 Motion Alert" : "🟢 Normal");

    const item = document.createElement("div");
    item.className = "discovered-card" + (inFleet ? " in-fleet" : "");
    item.innerHTML = `
      <div class="discovered-card-header">
        <div class="discovered-ident">
          <span class="helmet-id-badge">${escapeHtml(rawId)}</span>
          <strong style="font-size: 14.5px; color: var(--text-main);">${escapeHtml(rawName)}</strong>
          <span class="discovered-ip-pill">📡 ${escapeHtml(ip)}</span>
        </div>
        <span class="discovered-latency-tag">⚡ ${latency}ms latency</span>
      </div>

      <div class="discovered-card-metrics">
        <div class="disc-metric"><span>Heart Rate</span><strong>${escapeHtml(hr)}</strong></div>
        <div class="disc-metric"><span>Temp</span><strong>${escapeHtml(temp)}</strong></div>
        <div class="disc-metric"><span>Status</span><strong>${escapeHtml(motion)}</strong></div>
        <div class="disc-metric"><span>Battery</span><strong>100%</strong></div>
      </div>

      <div class="discovered-card-actions">
        ${inFleet 
          ? `<button type="button" class="btn-connect-discovered connected" onclick="connectDiscoveredHelmet('${escapeHtml(ip)}', '${escapeHtml(rawId)}', '${escapeHtml(rawName)}')">
               <span>✔ Connected in Fleet (Sync Live)</span>
             </button>`
          : `<button type="button" class="btn-connect-discovered" onclick="connectDiscoveredHelmet('${escapeHtml(ip)}', '${escapeHtml(rawId)}', '${escapeHtml(rawName)}')">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                 <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
               </svg>
               <span>Connect & Add to Fleet</span>
             </button>`
        }
        <a href="live-telemetry.html?id=${encodeURIComponent(rawId)}&name=${encodeURIComponent(rawName)}&ip=${encodeURIComponent(ip)}" class="btn-disc-monitor" title="Open live telemetry directly">
          <span>Monitor</span>
        </a>
      </div>
    `;
    discoveredHelmetsList.appendChild(item);
  });
}

function connectDiscoveredHelmet(ip, deviceId, deviceName) {
  let existingIdx = fleetData.findIndex((h) => h.ip === ip || h.id.toUpperCase() === deviceId.toUpperCase());

  if (existingIdx !== -1) {
    fleetData[existingIdx].ip = ip;
    fleetData[existingIdx].lastSync = "Just now";
    saveFleetData();
    renderFleet(fleetData[existingIdx].id);
    renderDiscoveredList();
    alert(`Updated connection for "${fleetData[existingIdx].name}" (ID: ${fleetData[existingIdx].id}) at IP ${ip}!`);
  } else {
    const workerName = window.prompt(`Discovered Helmet ${deviceId} at ${ip}!\nEnter Worker Name for this helmet:`, deviceName || "Worker " + deviceId);
    if (workerName === null) return;

    const zoneName = "Zone A - Scaffold Tower";

    fleetData.unshift({
      id: deviceId,
      name: workerName.trim() || `Worker (${deviceId})`,
      zone: zoneName,
      blood: "O+",
      ip: ip,
      status: "NORMAL",
      battery: "100%",
      heartRate: "72 BPM",
      contact: "WORN",
      lastSync: "Just now"
    });

    saveFleetData();
    setActiveHelmetSession(deviceId);
    renderFleet(deviceId);
    renderDiscoveredList();
    closeDiscoveryModal();
    connectHelmetDirectly(deviceId);
  }
}
window.connectDiscoveredHelmet = connectDiscoveredHelmet;

// Save / Submit Form
helmetForm.addEventListener("submit", (e) => {
  e.preventDefault();

  const idx = parseInt(editIndex.value, 10);
  const idVal = helmetIdInput.value.trim().toUpperCase();
  const nameVal = workerNameInput.value.trim();
  const zoneVal = workerZoneInput.value;
  const bloodVal = bloodGroupInput.value;
  const ipVal = (helmetIpInput ? helmetIpInput.value.trim() : "") || "192.168.4.1";
  const statusVal = statusInput.value;

  if (!idVal || !nameVal) {
    alert("Please fill in all required fields.");
    return;
  }

  if (idx === -1) {
    // Check duplicate ID
    if (fleetData.some((h) => h.id.toUpperCase() === idVal)) {
      alert(`Helmet ID "${idVal}" is already registered. Please use a unique ID.`);
      return;
    }

    fleetData.unshift({
      id: idVal,
      name: nameVal,
      zone: zoneVal,
      blood: bloodVal,
      ip: ipVal,
      status: statusVal,
      battery: "100%",
      heartRate: "75 BPM",
      contact: "WORN",
      lastSync: "Just now"
    });
  } else {
    // Update existing
    fleetData[idx].name = nameVal;
    fleetData[idx].zone = zoneVal;
    fleetData[idx].blood = bloodVal;
    fleetData[idx].ip = ipVal;
    fleetData[idx].status = statusVal;
  }

  saveFleetData();
  closeModal();
  renderFleet();
});

// Event Listeners
openAddModalBtn.addEventListener("click", openAddModal);
closeModalBtn.addEventListener("click", closeModal);
cancelModalBtn.addEventListener("click", closeModal);

searchInput.addEventListener("input", renderFleet);
statusFilter.addEventListener("change", renderFleet);
zoneFilter.addEventListener("change", renderFleet);

// Close modals on click outside box
helmetModal.addEventListener("click", (e) => {
  if (e.target === helmetModal) closeModal();
});

if (connectModal) {
  connectModal.addEventListener("click", (e) => {
    if (e.target === connectModal) closeConnectModal();
  });
}

if (discoveryModal) {
  discoveryModal.addEventListener("click", (e) => {
    if (e.target === discoveryModal) closeDiscoveryModal();
  });
}

// Initial Load
loadFleetData();
renderFleet();
