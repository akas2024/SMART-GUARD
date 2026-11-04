/* ==========================================================================
   SMARTGUARD - TELEMETRY MONITOR CONTROLLER
   Purpose: Connects to ESP32 /api endpoint, updates real-time sensor
            metrics, renders the sliding waveform canvas, and manages alarms.
   ========================================================================== */

const $ = (id) => document.getElementById(id);

// Resolve active worker from (1) URL parameters, (2) localStorage, (3) fleet registry, or (4) default to Akash Patil
function resolveActiveWorker() {
  const params = new URLSearchParams(window.location.search);
  let name = params.get("name");
  let id = params.get("id");
  let zone = params.get("zone");

  if (name && id) {
    localStorage.setItem("smartguard_active_worker_name", name);
    localStorage.setItem("smartguard_active_helmet_id", id);
    if (zone) localStorage.setItem("smartguard_active_zone", zone);
    return { name, id, zone: zone || "Zone C - Chemical Storage" };
  }

  // Check localStorage for active session saved when clicking Connect or Monitor in Fleet
  const savedName = localStorage.getItem("smartguard_active_worker_name");
  const savedId = localStorage.getItem("smartguard_active_helmet_id");
  const savedZone = localStorage.getItem("smartguard_active_zone");
  if (savedName && savedId) {
    return { name: savedName, id: savedId, zone: savedZone || "Zone C - Chemical Storage" };
  }

  // Check fleetData saved in localStorage to match the active IP
  try {
    const rawFleet = localStorage.getItem("smartguard_helmets_fleet");
    if (rawFleet) {
      const fleet = JSON.parse(rawFleet);
      const activeIp = localStorage.getItem("smartguard_active_ip") || "192.168.4.1";
      const matched = fleet.find(h => h.ip === activeIp) || fleet[0];
      if (matched && matched.name) {
        return { name: matched.name, id: matched.id || "HLM-05", zone: matched.zone || "Zone C - Chemical Storage" };
      }
    }
  } catch (e) {}

  return { name: "Akash Patil", id: "HLM-05", zone: "Zone C - Chemical Storage" };
}

const activeWorker = resolveActiveWorker();
const helmetIdParam = activeWorker.id;
const workerNameParam = activeWorker.name;
const workerZoneParam = activeWorker.zone;

function syncWorkerNamesToDOM() {
  if ($("headerHelmetId")) $("headerHelmetId").textContent = helmetIdParam;
  if ($("headerWorkerName")) $("headerWorkerName").textContent = workerNameParam;
  if ($("modalHelmetId")) $("modalHelmetId").textContent = helmetIdParam;
  if ($("modalWorkerName")) $("modalWorkerName").textContent = workerNameParam;
  if ($("modalWorkerZone")) $("modalWorkerZone").textContent = workerZoneParam;
  if ($("wifiModalHelmetId")) $("wifiModalHelmetId").textContent = helmetIdParam;
  if ($("wifiModalWorkerName")) $("wifiModalWorkerName").textContent = workerNameParam;

  if (window.SmartGuardLiveMap) {
    window.SmartGuardLiveMap.workerName = workerNameParam;
    window.SmartGuardLiveMap.helmetId = helmetIdParam;
    window.SmartGuardLiveMap.workerZone = workerZoneParam;
    if (window.SmartGuardLiveMap.updateCoordinateDisplays) {
      window.SmartGuardLiveMap.updateCoordinateDisplays();
    }
  }

  if (window.SmartGuardWifiMap) {
    window.SmartGuardWifiMap.workerName = workerNameParam;
    window.SmartGuardWifiMap.helmetId = helmetIdParam;
    window.SmartGuardWifiMap.workerZone = workerZoneParam;
    if (window.SmartGuardWifiMap.updateUI) {
      window.SmartGuardWifiMap.updateUI();
    }
  }
}

syncWorkerNamesToDOM();
document.addEventListener("DOMContentLoaded", syncWorkerNamesToDOM);

const elements = {
  // Connection & System
  connectionPill: $("connectionPill"),
  connectionDot: $("connectionDot"),
  connectionText: $("connectionText"),
  uptimeText: $("uptimeText"),

  // Hero Banner
  heroBanner: $("heroBanner"),
  bannerIconWrap: $("bannerIconWrap"),
  statusTag: $("statusTag"),
  bannerTitle: $("bannerTitle"),
  bannerDesc: $("bannerDesc"),

  // Biometrics & Wear
  bpmValue: $("bpmValue"),
  bpmBadge: $("bpmBadge"),
  bpmHint: $("bpmHint"),
  contactStatus: $("contactStatus"),
  contactBadge: $("contactBadge"),
  opticalHint: $("opticalHint"),

  // Motion & Fall
  accelValue: $("accelValue"),
  fallBadge: $("fallBadge"),

  // Actuators
  motorPill: $("motorPill"),
  motorState: $("motorState"),
  buzzerPill: $("buzzerPill"),
  buzzerState: $("buzzerState"),

  // Environmental Hazards
  tempValue: $("tempValue"),
  humidityValue: $("humidityValue"),
  gasValue: $("gasValue"),
  gasBarFill: $("gasBarFill"),

  // Action Buttons
  ackBtn: $("ackBtn"),
  resetBtn: $("resetBtn"),

  // Event Feed
  lastEventTime: $("lastEventTime"),
  lastEventText: $("lastEventText")
};

// ----------------------------------------------------
// Real-time Canvas Waveform Chart
// ----------------------------------------------------
const canvas = $("liveChart");
const ctx = canvas ? canvas.getContext("2d") : null;
const maxDataPoints = 35;
const chartData = new Array(maxDataPoints).fill(9.81);

function resizeCanvas() {
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * (window.devicePixelRatio || 1);
  canvas.height = rect.height * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function drawChart() {
  if (!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  ctx.clearRect(0, 0, width, height);

  // Background Grid Lines
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  for (let y = 20; y < height; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Draw Waveform Line
  const minG = 0;
  const maxG = 30; // 0 to 30 m/s^2 scale
  const stepX = width / (maxDataPoints - 1);

  ctx.beginPath();
  for (let i = 0; i < chartData.length; i++) {
    const val = Math.max(minG, Math.min(maxG, chartData[i]));
    const x = i * stepX;
    const y = height - ((val - minG) / (maxG - minG)) * (height - 20) - 10;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  // Gradient Area Fill Under Wave
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(29, 78, 216, 0.16)");
  gradient.addColorStop(1, "rgba(29, 78, 216, 0.0)");
  ctx.fillStyle = gradient;
  ctx.fill();
}

function pushChartData(val) {
  chartData.shift();
  chartData.push(Number(val) || 9.81);
  drawChart();
}

// ----------------------------------------------------
// UI Update Logic
// ----------------------------------------------------

function setConnectionState(online) {
  if (online) {
    elements.connectionPill.className = "connection-pill";
    elements.connectionText.textContent = "ESP32 Connected";
  } else {
    elements.connectionPill.className = "connection-pill offline";
    elements.connectionText.textContent = "Connection Lost";
  }
}

function updateHeroBanner(data) {
  const banner = elements.heroBanner;
  banner.classList.remove("safe", "warning", "danger");

  if (data.emergencyActive) {
    banner.classList.add("danger");
    elements.statusTag.textContent = "CRITICAL EMERGENCY";
    elements.bannerTitle.textContent = "Emergency SOS Active!";
    elements.bannerDesc.textContent =
      "Worker has triggered a 4-second SOS distress event. Check immediately!";
  } else if (data.motionAlert) {
    banner.classList.add("danger");
    elements.statusTag.textContent = "MOTION ALERT";
    elements.bannerTitle.textContent = data.motionAlertReason;
    elements.bannerDesc.textContent =
      "Impact or worker inactivity detected. Acknowledge only after checking worker.";
  } else if (data.environmentWarning) {
    banner.classList.add("warning");
    elements.statusTag.textContent = "ENVIRONMENT HAZARD";
    elements.bannerTitle.textContent = "Environmental Reading Exceeded";
    elements.bannerDesc.textContent = data.environmentAcknowledged
      ? "Warning acknowledged by supervisor; condition is still active."
      : "High toxic gas, extreme heat, or humidity detected in worker's zone.";
  } else {
    banner.classList.add("safe");
    elements.statusTag.textContent = "ALL SYSTEMS NOMINAL";
    elements.bannerTitle.textContent = "Monitoring Active";
    elements.bannerDesc.textContent =
      "Sensors active. No environmental or motion hazards detected.";
  }
}

function updateBiometrics(data) {
  // Helmet Contact & Heart Rate
  if (!data.maxOK) {
    elements.contactStatus.textContent = "OFFLINE";
    elements.contactStatus.style.color = "#dc2626";
    elements.contactBadge.textContent = "Sensor Error";
    elements.bpmValue.textContent = "--";
    elements.bpmBadge.textContent = "Unavailable";
    elements.opticalHint.textContent = "MAX30102 Not Detected";
  } else if (!data.fingerDetected) {
    elements.contactStatus.textContent = "NOT WORN";
    elements.contactStatus.style.color = "#64748b";
    elements.contactBadge.textContent = "Off Head / Desk";
    elements.contactBadge.className = "footer-badge";
    elements.bpmValue.textContent = "--";
    elements.bpmBadge.textContent = "Awaiting Skin Contact";
    elements.bpmBadge.className = "footer-badge";
    elements.opticalHint.textContent = `Red: ${data.maxRed} | IR: ${data.maxIR}`;
  } else {
    elements.contactStatus.textContent = "WORN ON HEAD";
    elements.contactStatus.style.color = "#059669";
    elements.contactBadge.textContent = "Active Contact";
    elements.contactBadge.className = "footer-badge safe-badge";
    elements.opticalHint.textContent = `Red: ${data.maxRed} | IR: ${data.maxIR}`;

    if (data.heartRate && data.heartRate > 0) {
      elements.bpmValue.textContent = String(data.heartRate);
      if (data.heartRate > 120) {
        elements.bpmBadge.textContent = "High Heart Rate!";
        elements.bpmBadge.className = "footer-badge danger-badge";
      } else if (data.heartRate < 50) {
        elements.bpmBadge.textContent = "Low Heart Rate";
        elements.bpmBadge.className = "footer-badge warn-badge";
      } else {
        elements.bpmBadge.textContent = "Normal Heart Rate";
        elements.bpmBadge.className = "footer-badge safe-badge";
      }
    } else {
      elements.bpmValue.textContent = "--";
      elements.bpmBadge.textContent = "Detecting Pulse...";
      elements.bpmBadge.className = "footer-badge";
    }
  }
}

function updateMotion(data) {
  if (data.mpuOK) {
    const mag = Number(data.accelerationMagnitude) || 9.81;
    elements.accelValue.textContent = mag.toFixed(2);
    pushChartData(mag);

    if (mag >= 24.5) {
      elements.fallBadge.textContent = "High Impact Spike!";
      elements.fallBadge.className = "footer-badge danger-badge";
    } else {
      elements.fallBadge.textContent = "Normal Motion (1.0g)";
      elements.fallBadge.className = "footer-badge safe-badge";
    }
  } else {
    elements.accelValue.textContent = "--";
    elements.fallBadge.textContent = "MPU6050 Offline";
    elements.fallBadge.className = "footer-badge danger-badge";
  }

  // Actuator States
  updateMotorActuatorUI(data.motorOn === true);

  if (data.buzzerOn) {
    elements.buzzerPill.classList.add("active");
    elements.buzzerState.textContent = "SOUNDING";
  } else {
    elements.buzzerPill.classList.remove("active");
    elements.buzzerState.textContent = "SILENT";
  }
}

// Vibration Motor Hardware Installation State
let isMotorHardwareConnected = localStorage.getItem("smartguard_motor_connected") === "true"; // Defaults to false

function updateMotorActuatorUI(isMotorFiring) {
  if (!elements.motorPill || !elements.motorState) return;
  const motorHint = $("motorFooterHint");

  if (!isMotorHardwareConnected) {
    elements.motorPill.className = "actuator-item disconnected";
    elements.motorState.textContent = "NOT CONNECTED";
    if (motorHint) motorHint.textContent = "Motor hardware: Disconnected (Click to enable)";
    return;
  }

  if (isMotorFiring) {
    elements.motorPill.className = "actuator-item active";
    elements.motorState.textContent = "VIBRATING";
    if (motorHint) motorHint.textContent = "Vibration Motor: ACTIVE · Pulsing alert pattern";
  } else {
    elements.motorPill.className = "actuator-item";
    elements.motorState.textContent = "STANDBY";
    if (motorHint) motorHint.textContent = "Vibration Motor: Standby · Ready for alerts";
  }
}

if (elements.motorPill) {
  elements.motorPill.addEventListener("click", () => {
    isMotorHardwareConnected = !isMotorHardwareConnected;
    localStorage.setItem("smartguard_motor_connected", isMotorHardwareConnected ? "true" : "false");
    updateMotorActuatorUI(false);
  });
}

function updateEnvironment(data) {
  // Temperature & Humidity
  elements.tempValue.textContent = data.dhtOK
    ? Number(data.temperatureC).toFixed(1)
    : "--";

  elements.humidityValue.textContent = data.dhtOK
    ? Number(data.humidityPercent).toFixed(0)
    : "--";

  // MQ135 Gas
  const gas = Number(data.mq135Raw) || 0;
  elements.gasValue.textContent = String(gas);

  // Gas Progress Bar (scale: 0 to 2400)
  const pct = Math.min(100, Math.max(5, (gas / 2400) * 100));
  elements.gasBarFill.style.width = `${pct}%`;

  if (gas >= 2400) {
    elements.gasBarFill.style.background = "#dc2626";
  } else if (gas >= 1200) {
    elements.gasBarFill.style.background = "#d97706";
  } else {
    elements.gasBarFill.style.background = "linear-gradient(to right, #059669, #d97706)";
  }
}

function updateDashboard(data) {
  updateHeroBanner(data);
  updateBiometrics(data);
  updateMotion(data);
  updateEnvironment(data);

  // Sync GPS Coordinates to Live Location Map Module (Supports Live vs Last Known)
  if (window.SmartGuardLiveMap) {
    const lat = data.gpsLatitude !== undefined ? data.gpsLatitude : (data.latitude !== undefined ? data.latitude : (data.lat !== undefined ? data.lat : null));
    const lng = data.gpsLongitude !== undefined ? data.gpsLongitude : (data.longitude !== undefined ? data.longitude : (data.lng !== undefined ? data.lng : null));
    const fixValid = data.gpsFixValid === true;
    const satellites = data.gpsSatellites || 0;
    const zone = data.zone || null;

    if (lat !== null && lng !== null) {
      window.SmartGuardLiveMap.updateWorkerLocation(Number(lat), Number(lng), fixValid, satellites, zone);
    }
  }

  // Sync worker identity & zone to Wi-Fi Positioning Module
  if (window.SmartGuardWifiMap) {
    if (data.zone) window.SmartGuardWifiMap.workerZone = data.zone;
    window.SmartGuardWifiMap.workerName = workerNameParam;
    window.SmartGuardWifiMap.helmetId = helmetIdParam;
  }

  // Uptime & Event Feed
  if (data.uptimeSeconds !== undefined) {
    const mins = Math.floor(data.uptimeSeconds / 60);
    const secs = data.uptimeSeconds % 60;
    elements.uptimeText.textContent = `Uptime: ${mins}m ${secs}s`;
  }

  if (data.lastEvent) {
    elements.lastEventText.textContent = data.lastEvent;
    const now = new Date();
    elements.lastEventTime.textContent = now.toTimeString().split(" ")[0];
  }
}

// ----------------------------------------------------
// Target ESP32 Host / IP Configuration
// ----------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);

let targetIp =
  urlParams.get("ip") ||
  localStorage.getItem("smartguard_active_ip") ||
  window.location.hostname ||
  "192.168.4.1";

if (!targetIp || targetIp === "localhost" || targetIp === "127.0.0.1") {
  targetIp = "192.168.4.1";
}

const targetIpInput = $("targetIpInput");
const ipLatencyText = $("ipLatencyText");
const ipPingDot = $("ipPingDot");
const btnHotspotIp = $("btnHotspotIp");
const btnAutoIp = $("btnAutoIp");

function updateQuickIpBtns() {
  if (btnHotspotIp) {
    btnHotspotIp.classList.toggle("active", targetIp === "192.168.4.1");
  }
  if (btnAutoIp) {
    btnAutoIp.classList.toggle(
      "active",
      targetIp === (window.location.hostname || "192.168.4.1")
    );
  }
}

if (targetIpInput) {
  targetIpInput.value = targetIp;
  targetIpInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyCustomIp();
  });
  updateQuickIpBtns();
}

function getApiBase() {
  if (!targetIp) return "";
  if (window.location.hostname && targetIp === window.location.hostname) {
    return "";
  }
  const clean = targetIp.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `http://${clean}`;
}

function setQuickIp(ip) {
  targetIp = ip;
  if (targetIpInput) targetIpInput.value = ip;
  localStorage.setItem("smartguard_active_ip", ip);
  updateQuickIpBtns();
  if (ipLatencyText) ipLatencyText.textContent = `Connecting to ${ip}...`;
  fetchTelemetry();
}
window.setQuickIp = setQuickIp;

function applyCustomIp() {
  if (targetIpInput) {
    const val = targetIpInput.value.trim();
    if (val) {
      targetIp = val;
      localStorage.setItem("smartguard_active_ip", val);
      updateQuickIpBtns();
      isUserDisconnected = false;
      const disconnBtn = $("disconnectIpBtn");
      if (disconnBtn) disconnBtn.style.opacity = "1";
      if (ipLatencyText) ipLatencyText.textContent = `Connecting to ${val}...`;
      startTelemetryPolling();

      const connectBtn = $("connectIpBtn");
      if (connectBtn) {
        const orig = connectBtn.innerHTML;
        connectBtn.innerHTML = `<span>Connecting...</span>`;
        connectBtn.disabled = true;
        connectBtn.style.opacity = "0.85";
        setTimeout(() => {
          connectBtn.innerHTML = orig;
          connectBtn.disabled = false;
          connectBtn.style.opacity = "1";
        }, 800);
      }

      fetchTelemetry();
    }
  }
}
window.applyCustomIp = applyCustomIp;

// ----------------------------------------------------
// API Communication
// ----------------------------------------------------

async function fetchTelemetry() {
  if (isUserDisconnected) return;
  const t0 = performance.now();
  const apiBase = getApiBase();
  const url = `${apiBase}/api`;

  try {
    let res;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    try {
      res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timeoutId);
    } catch (netErr) {
      clearTimeout(timeoutId);
      if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        res = await fetch("/api", { cache: "no-store" });
      } else {
        throw netErr;
      }
    }

    if (!res || !res.ok) {
      if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
        res = await fetch("/api", { cache: "no-store" });
      }
    }

    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "Failed"}`);
    const data = await res.json();
    const pingMs = Math.round(performance.now() - t0);

    setConnectionState(true);
    if (ipPingDot) {
      ipPingDot.className = "status-dot connected";
    }
    if (ipLatencyText) {
      ipLatencyText.textContent = `Connected (${targetIp}) • ${pingMs}ms latency`;
    }

    updateDashboard(data);
  } catch (err) {
    setConnectionState(false);
    if (ipPingDot) {
      ipPingDot.className = "status-dot offline";
    }
    if (ipLatencyText) {
      ipLatencyText.textContent = `Target unreachable: ${targetIp}`;
    }

    elements.bannerTitle.textContent = "Helmet Telemetry Disconnected";
    elements.bannerDesc.textContent =
      `Could not reach ESP32 at http://${targetIp}/api. Make sure your device is connected to the 'SmartGuard-ESP32' Wi-Fi network or local site router.`;
    elements.heroBanner.className = "hero-banner danger";
    elements.statusTag.textContent = "OFFLINE";
  }
}

async function postAction(endpoint, btn) {
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = "0.7";

  const apiBase = getApiBase();
  const url = `${apiBase}${endpoint}`;

  try {
    let res;
    try {
      res = await fetch(url, { method: "POST", cache: "no-store" });
    } catch (netErr) {
      if (apiBase !== "" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
        res = await fetch(endpoint, { method: "POST", cache: "no-store" });
      } else {
        throw netErr;
      }
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchTelemetry();
  } catch (err) {
    alert(`Could not communicate with helmet ESP32 at ${url}.`);
  } finally {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.innerHTML = origHtml;
  }
}

elements.ackBtn.addEventListener("click", () => {
  postAction("/api/ack", elements.ackBtn);
});

elements.resetBtn.addEventListener("click", () => {
  const confirmed = window.confirm(
    "Reset the emergency event? Only do this after verifying the worker is safe."
  );
  if (confirmed) {
    postAction("/api/reset-emergency", elements.resetBtn);
  }
});

// Global manual refresh trigger for the "Check Live Status" button
window.pollTelemetry = async function() {
  const checkBtn = document.getElementById("checkLiveBtn");
  if (checkBtn) {
    checkBtn.classList.add("syncing");
    checkBtn.disabled = true;
  }
  await fetchTelemetry();
  if (checkBtn) {
    setTimeout(() => {
      checkBtn.classList.remove("syncing");
      checkBtn.disabled = false;
    }, 400);
  }
};


let pollIntervalTimer = null;
let isUserDisconnected = false;

function startTelemetryPolling() {
  isUserDisconnected = false;
  if (!pollIntervalTimer) {
    pollIntervalTimer = setInterval(fetchTelemetry, 1500);
  }
}

function disconnectTelemetry() {
  isUserDisconnected = true;
  if (pollIntervalTimer) {
    clearInterval(pollIntervalTimer);
    pollIntervalTimer = null;
  }
  setConnectionState(false);
  if (ipPingDot) {
    ipPingDot.className = "status-dot offline";
  }
  if (ipLatencyText) {
    ipLatencyText.textContent = `Disconnected from ESP32 (${targetIp})`;
  }
  elements.bannerTitle.textContent = "Helmet Telemetry Disconnected";
  elements.bannerDesc.textContent = "ESP32 telemetry stream paused by user. Click 'Connect' to resume live data.";
  elements.heroBanner.className = "hero-banner warn";
  elements.statusTag.textContent = "DISCONNECTED";

  const disconnBtn = $("disconnectIpBtn");
  const connBtn = $("connectIpBtn");
  if (disconnBtn) disconnBtn.style.opacity = "0.6";
  if (connBtn) connBtn.style.opacity = "1";
}
window.disconnectTelemetry = disconnectTelemetry;
window.startTelemetryPolling = startTelemetryPolling;

// Initial fetch and managed 1.5s interval
fetchTelemetry();
pollIntervalTimer = setInterval(fetchTelemetry, 1500);
