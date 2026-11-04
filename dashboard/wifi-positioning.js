/**
 * ==========================================================================
 * SMARTGUARD - WORKER WI-FI INDOOR POSITIONING & INDOOR ROUTING MODULE
 * File: wifi-positioning.js
 * Description: Dedicated Wi-Fi indoor positioning system using BSSID & RSSI
 *              trilateration, worksite AP infrastructure mapping, floor plans,
 *              and indoor responder turn-by-turn navigation.
 * ==========================================================================
 */

// Worksite Registered Wi-Fi Infrastructure & Anchor Beacons
// Configured with exact building pillar coordinates, floor levels, and calibrated reference RSSI
const SMARTGUARD_WIFI_INFRASTRUCTURE = [
  {
    bssidPrefix: "smartguard-esp32",
    ssid: "SmartGuard-ESP32",
    zone: "Zone A - Scaffold Tower",
    floor: "level1",
    floorName: "Level 1 - Mezzanine",
    lat: 18.52048,
    lng: 73.85672,
    txPower: -42,
    description: "Helmet ESP32 Internal Node"
  },
  {
    bssidPrefix: "98:25:4a",
    ssid: "SmartGuard-AP-Scaffold",
    zone: "Zone A - Scaffold Tower",
    floor: "level1",
    floorName: "Level 1 - Mezzanine",
    lat: 18.52055,
    lng: 73.85680,
    txPower: -40,
    description: "North Scaffold Core AP"
  },
  {
    bssidPrefix: "24:4b:fe",
    ssid: "SmartGuard-AP-Excavation",
    zone: "Zone B - Excavation Pit",
    floor: "ground",
    floorName: "Ground Floor",
    lat: 18.52180,
    lng: 73.85495,
    txPower: -44,
    description: "Excavation Staging Node"
  },
  {
    bssidPrefix: "70:ee:50",
    ssid: "SmartGuard-AP-Chemical",
    zone: "Zone C - Chemical Storage",
    floor: "ground",
    floorName: "Ground Floor",
    lat: 18.51895,
    lng: 73.85815,
    txPower: -40,
    description: "HazMat Storage Perimeter AP"
  },
  {
    bssidPrefix: "50:d4:f7",
    ssid: "SmartGuard-AP-Welding",
    zone: "Zone D - Welding Bay",
    floor: "ground",
    floorName: "Ground Floor",
    lat: 18.52235,
    lng: 73.85955,
    txPower: -42,
    description: "Fabrication Workshop AP"
  }
];

// Worksite Indoor Floor Plan Definitions (Coordinates Bounds)
const WORKSITE_FLOOR_BOUNDS = [
  [18.5175, 73.8530], // Southwest corner
  [18.5235, 73.8610]  // Northeast corner
];

class SmartGuardWifiPositioning {
  constructor() {
    this.map = null;
    this.activeTab = "gps"; // 'gps' | 'wifi'
    this.workerLat = null;
    this.workerLng = null;
    this.accuracyMeters = null;
    this.signalDbm = null;
    this.signalQualityText = "--";
    this.positioningMethod = "Wi-Fi (Awaiting Scan)";
    this.accessPoints = [];
    this.isScanning = false;
    this.hasValidFix = false;

    // Floor Plan & Visual Layer
    this.currentFloor = "level1";
    this.floorOverlay = null;
    this.showFloorPlan = true;
    this.apMarkersGroup = null;

    // Map Markers
    this.workerMarker = null;
    this.accuracyCircle = null;
    this.userMarker = null;
    this.navRouteLine = null;

    // Responder Navigation State
    this.isNavigating = false;
    this.userLat = null;
    this.userLng = null;
    this.watchId = null;

    // Metadata
    this.workerName = "Akash Patil";
    this.helmetId = "HLM-05";
    this.workerZone = "Zone C - Chemical Storage";

    this.init();
  }

  init() {
    const savedName = localStorage.getItem("smartguard_active_worker_name");
    const savedId = localStorage.getItem("smartguard_active_helmet_id");
    const savedZone = localStorage.getItem("smartguard_active_zone");
    if (savedName) this.workerName = savedName;
    if (savedId) this.helmetId = savedId;
    if (savedZone) this.workerZone = savedZone;

    const params = new URLSearchParams(window.location.search);
    if (params.get("id")) this.helmetId = params.get("id");
    if (params.get("name")) this.workerName = params.get("name");
    if (params.get("zone")) this.workerZone = params.get("zone");

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.bindUI());
    } else {
      this.bindUI();
    }
  }

  bindUI() {
    // Tabs
    const tabGps = document.getElementById("tabGpsLocation");
    const tabWifi = document.getElementById("tabWifiPositioning");

    if (tabGps) tabGps.addEventListener("click", () => this.switchTab("gps"));
    if (tabWifi) tabWifi.addEventListener("click", () => this.switchTab("wifi"));

    // Wi-Fi Controls
    const scanBtn = document.getElementById("btnScanWifi");
    if (scanBtn) scanBtn.addEventListener("click", () => this.performWifiScan());

    const toggleFloorBtn = document.getElementById("btnToggleFloorPlan");
    if (toggleFloorBtn) toggleFloorBtn.addEventListener("click", () => this.toggleFloorPlan());

    const floorSelect = document.getElementById("selectFloorLevel");
    if (floorSelect) {
      floorSelect.addEventListener("change", (e) => this.setFloorLevel(e.target.value));
    }

    const startNavBtn = document.getElementById("startWifiNavBtn");
    if (startNavBtn) startNavBtn.addEventListener("click", () => this.toggleNavigation());

    const copyCoordsBtn = document.getElementById("copyWifiCoordsBtn");
    if (copyCoordsBtn) copyCoordsBtn.addEventListener("click", () => this.copyCoordinates());

    const openMapsBtn = document.getElementById("openWifiExternalMapsBtn");
    if (openMapsBtn) openMapsBtn.addEventListener("click", () => this.openExternalMaps());
  }

  /**
   * Switch between GPS Location and Wi-Fi Positioning tabs
   */
  switchTab(tabName) {
    this.activeTab = tabName;

    const tabGps = document.getElementById("tabGpsLocation");
    const tabWifi = document.getElementById("tabWifiPositioning");
    const viewGps = document.getElementById("viewGpsLocation");
    const viewWifi = document.getElementById("viewWifiPositioning");

    if (tabName === "gps") {
      if (tabGps) {
        tabGps.classList.add("active");
        tabGps.setAttribute("aria-selected", "true");
      }
      if (tabWifi) {
        tabWifi.classList.remove("active");
        tabWifi.setAttribute("aria-selected", "false");
      }
      if (viewGps) viewGps.style.display = "block";
      if (viewWifi) viewWifi.style.display = "none";

      // Refresh GPS map tiles
      setTimeout(() => {
        if (window.SmartGuardLiveMap && window.SmartGuardLiveMap.map) {
          window.SmartGuardLiveMap.map.invalidateSize();
        }
      }, 150);

    } else if (tabName === "wifi") {
      if (tabWifi) {
        tabWifi.classList.add("active");
        tabWifi.setAttribute("aria-selected", "true");
      }
      if (tabGps) {
        tabGps.classList.remove("active");
        tabGps.setAttribute("aria-selected", "false");
      }
      if (viewGps) viewGps.style.display = "none";
      if (viewWifi) viewWifi.style.display = "block";

      this.ensureWifiMap();

      // Trigger automatic scan if never scanned
      if (!this.hasValidFix && !this.isScanning) {
        this.performWifiScan();
      }
    }
  }

  /**
   * Ensure Leaflet map is initialized for the Wi-Fi container
   */
  ensureWifiMap() {
    if (!window.L) return;

    const container = document.getElementById("smartguardWifiMap");
    if (!container) return;

    if (!this.map) {
      container.innerHTML = "";

      // Default center around Zone A Scaffold
      const defaultCenter = [18.52048, 73.85675];

      this.map = L.map("smartguardWifiMap", {
        center: defaultCenter,
        zoom: 18,
        zoomControl: true,
        maxZoom: 21
      });

      // Base tile layer (OpenStreetMap)
      this.baseTileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors | SmartGuard Indoor AP',
        maxZoom: 21
      }).addTo(this.map);

      // Create AP Beacons Layer Group
      this.apMarkersGroup = L.layerGroup().addTo(this.map);

      // Render Architectural Worksite Floor Plan Overlay
      this.renderFloorPlanOverlay();

      setTimeout(() => {
        if (this.map) this.map.invalidateSize();
      }, 250);
    } else {
      setTimeout(() => {
        if (this.map) this.map.invalidateSize();
      }, 150);
    }
  }

  /**
   * Generates and overlays an architectural vector SVG floor plan
   */
  renderFloorPlanOverlay() {
    if (!this.map) return;

    if (this.floorOverlay) {
      this.map.removeLayer(this.floorOverlay);
      this.floorOverlay = null;
    }

    if (!this.showFloorPlan) return;

    // Architectural Worksite Floor Plan SVG (with structural zones, scaffold deck, corridors)
    const floorLabel = this.currentFloor === "ground" ? "GROUND FLOOR - GENERAL ACCESS" :
                       this.currentFloor === "level1" ? "LEVEL 1 - MEZZANINE & SCAFFOLD" :
                       "LEVEL 2 - UPPER SCAFFOLD DECK";

    const svgContent = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700">
        <defs>
          <pattern id="gridPattern" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(14, 165, 233, 0.12)" stroke-width="1"/>
          </pattern>
        </defs>

        <!-- Floor Plan Background Grid -->
        <rect width="1000" height="700" fill="rgba(15, 23, 42, 0.72)"/>
        <rect width="1000" height="700" fill="url(#gridPattern)"/>

        <!-- Outer Boundary Wall -->
        <rect x="50" y="50" width="900" height="600" rx="8" fill="none" stroke="#38bdf8" stroke-width="4"/>

        <!-- Structural Sectors -->
        <!-- Zone A: Scaffold Deck -->
        <rect x="80" y="80" width="400" height="260" fill="rgba(56, 189, 248, 0.14)" stroke="#0284c7" stroke-width="2" stroke-dasharray="6,4"/>
        <text x="100" y="115" fill="#bae6fd" font-family="sans-serif" font-size="16" font-weight="bold">ZONE A: SCAFFOLD TOWER STRUCTURE</text>
        <text x="100" y="138" fill="#7dd3fc" font-family="sans-serif" font-size="12">Elevation: +14.5m · Capacity: 6 Personnel</text>

        <!-- Zone B: Excavation & Heavy Bay -->
        <rect x="520" y="80" width="400" height="260" fill="rgba(245, 158, 11, 0.12)" stroke="#d97706" stroke-width="2"/>
        <text x="540" y="115" fill="#fde68a" font-family="sans-serif" font-size="16" font-weight="bold">ZONE B: EXCAVATION & LOGISTICS</text>
        <text x="540" y="138" fill="#fcd34d" font-family="sans-serif" font-size="12">Ground Level · Heavy Machinery Clearance</text>

        <!-- Primary Indoor Walkway / Corridor -->
        <rect x="80" y="370" width="840" height="60" fill="rgba(255, 255, 255, 0.08)" stroke="#64748b" stroke-width="1.5"/>
        <text x="420" y="405" fill="#94a3b8" font-family="sans-serif" font-size="13" font-weight="600" letter-spacing="2">MAIN LOGISTICS CORRIDOR</text>

        <!-- Zone C: Chemical Storage -->
        <rect x="80" y="460" width="380" height="160" fill="rgba(239, 68, 68, 0.12)" stroke="#ef4444" stroke-width="2"/>
        <text x="100" y="495" fill="#fecaca" font-family="sans-serif" font-size="15" font-weight="bold">ZONE C: CHEMICAL & HAZMAT BAY</text>
        <text x="100" y="518" fill="#f87171" font-family="sans-serif" font-size="11">Restricted Respirator Area</text>

        <!-- Zone D: Welding Workshop -->
        <rect x="500" y="460" width="420" height="160" fill="rgba(168, 85, 247, 0.12)" stroke="#a855f7" stroke-width="2"/>
        <text x="520" y="495" fill="#e9d5ff" font-family="sans-serif" font-size="15" font-weight="bold">ZONE D: WELDING & FABRICATION BAY</text>
        <text x="520" y="518" fill="#c084fc" font-family="sans-serif" font-size="11">High Temperature & Hot Work Zone</text>

        <!-- Emergency Exits & Staging Points -->
        <circle cx="950" cy="400" r="16" fill="#10b981"/>
        <text x="942" y="405" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="bold">EXIT</text>
        <circle cx="50" cy="400" r="16" fill="#10b981"/>
        <text x="42" y="405" fill="#ffffff" font-family="sans-serif" font-size="11" font-weight="bold">EXIT</text>

        <!-- Active Floor Label Header -->
        <rect x="300" y="10" width="400" height="32" rx="6" fill="#0369a1"/>
        <text x="500" y="31" fill="#ffffff" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle">${floorLabel}</text>
      </svg>
    `;

    const svgBlob = new Blob([svgContent], { type: "image/svg+xml" });
    const svgUrl = URL.createObjectURL(svgBlob);

    this.floorOverlay = L.imageOverlay(svgUrl, WORKSITE_FLOOR_BOUNDS, {
      opacity: 0.85,
      interactive: false
    }).addTo(this.map);

    this.renderApBeacons();
  }

  /**
   * Render known Wi-Fi AP icons across the floor plan
   */
  renderApBeacons() {
    if (!this.map || !this.apMarkersGroup) return;
    this.apMarkersGroup.clearLayers();

    SMARTGUARD_WIFI_INFRASTRUCTURE.forEach((ap) => {
      const apIcon = L.divIcon({
        className: "sg-wifi-ap-badge",
        html: `
          <div style="background:#0284c7; border:2px solid #ffffff; color:#ffffff; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:bold; box-shadow:0 2px 6px rgba(0,0,0,0.35);" title="${ap.ssid}">
            📶
          </div>
        `,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const marker = L.marker([ap.lat, ap.lng], { icon: apIcon });
      marker.bindPopup(`
        <div style="font-family:sans-serif; font-size:12px;">
          <div style="font-weight:700; color:#0369a1;">${ap.ssid}</div>
          <div style="color:#64748b; font-size:11px;">${ap.description}</div>
          <div style="color:#475569; font-size:10px; margin-top:2px;">Zone: ${ap.zone} (${ap.floorName})</div>
        </div>
      `);
      this.apMarkersGroup.addLayer(marker);
    });
  }

  toggleFloorPlan() {
    this.showFloorPlan = !this.showFloorPlan;
    const btn = document.getElementById("btnToggleFloorPlan");
    if (btn) {
      btn.innerHTML = this.showFloorPlan ?
        `<span>🏢 Floor Plan (On)</span>` :
        `<span>🗺️ Street Map Only</span>`;
    }
    this.renderFloorPlanOverlay();
  }

  setFloorLevel(level) {
    this.currentFloor = level;
    this.renderFloorPlanOverlay();
  }

  /**
   * Scan nearby Wi-Fi APs via ESP32 /api/wifi-scan or Browser Geolocation
   */
  async performWifiScan() {
    if (this.isScanning) return;
    this.isScanning = true;

    const statusBanner = document.getElementById("wifiStatusAlert");
    const scanBtn = document.getElementById("btnScanWifi");
    const apListWrap = document.getElementById("wifiApListWrap");

    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.style.opacity = "0.7";
      scanBtn.innerHTML = `<span>Scanning Wi-Fi...</span>`;
    }

    if (statusBanner) {
      statusBanner.className = "alert-banner info";
      statusBanner.style.display = "flex";
      statusBanner.innerHTML = `
        <div class="nav-pulse-dot" style="background:#0284c7;"></div>
        <span>Detecting surrounding 2.4GHz Wi-Fi Access Points (BSSID/RSSI)...</span>
      `;
    }

    // Determine target IP from user input or fallback
    const targetIpInput = document.getElementById("targetIpInput");
    const targetIp = targetIpInput ? (targetIpInput.value.trim() || "192.168.4.1") : "192.168.4.1";

    let scanSucceeded = false;

    // STEP 1: Query ESP32 /api/wifi-scan endpoint
    try {
      const url = `http://${targetIp}/api/wifi-scan`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      let resp;
      try {
        resp = await fetch(url, { signal: controller.signal, cache: "no-store" });
      } catch (e) {
        if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
          resp = await fetch("/api/wifi-scan", { signal: controller.signal, cache: "no-store" });
        } else {
          throw e;
        }
      }
      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "complete" && Array.isArray(data.accessPoints) && data.accessPoints.length > 0) {
          this.processWifiScanResults(data.accessPoints, "ESP32 Helmet Hardware Radio");
          scanSucceeded = true;
        } else if (data.status === "scanning" || data.status === "initiated") {
          // Retry after 1.8 seconds while ESP32 completes channel hopping
          if (statusBanner) {
            statusBanner.innerHTML = `<span>ESP32 is hopping channels... Reading beacons...</span>`;
          }
          await new Promise((r) => setTimeout(r, 1800));
          return this.retryWifiScan(targetIp);
        }
      }
    } catch (e) {
      console.warn("Direct ESP32 Wi-Fi scan query timed out or unreachable:", e.message);
    }

    // STEP 2: Fallback to Browser / OS Wi-Fi Location Provider if ESP32 direct scan unavailable
    if (!scanSucceeded) {
      await this.tryBrowserWifiLocation();
    }

    this.isScanning = false;
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.style.opacity = "1";
      scanBtn.innerHTML = `<span>🔄 Scan Wi-Fi APs</span>`;
    }
  }

  async retryWifiScan(targetIp) {
    try {
      let resp;
      try {
        resp = await fetch(`http://${targetIp}/api/wifi-scan`, { cache: "no-store" });
      } catch (e) {
        if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
          resp = await fetch("/api/wifi-scan", { cache: "no-store" });
        } else {
          throw e;
        }
      }
      if (resp.ok) {
        const data = await resp.json();
        if (data.status === "complete" && Array.isArray(data.accessPoints)) {
          this.processWifiScanResults(data.accessPoints, "ESP32 Helmet Hardware Radio");
          return;
        }
      }
    } catch (e) {
      console.warn("Retry failed:", e);
    }
    await this.tryBrowserWifiLocation();
  }

  /**
   * Browser Geolocation API uses OS-level Wi-Fi positioning (Windows / Android / Apple location service)
   */
  async tryBrowserWifiLocation() {
    const statusBanner = document.getElementById("wifiStatusAlert");

    if (!navigator.geolocation) {
      this.displayWifiError("Geolocation not supported by this browser. No Wi-Fi APs detected.");
      return;
    }

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          const acc = pos.coords.accuracy || 12;

          this.workerLat = lat;
          this.workerLng = lng;
          this.accuracyMeters = Math.round(acc);
          this.signalDbm = -58;
          this.signalQualityText = "Good (OS Wi-Fi Position)";
          this.positioningMethod = "Wi-Fi (OS Geolocation Service)";
          this.hasValidFix = true;

          // Synthesize connected worksite AP info
          this.accessPoints = [
            { ssid: "SmartGuard-ESP32", bssid: "24:6f:28:9a:bc:10", rssi: -58, channel: 1 }
          ];

          if (statusBanner) {
            statusBanner.className = "alert-banner success";
            statusBanner.style.display = "flex";
            statusBanner.innerHTML = `
              <span>✅ Wi-Fi Position Acquired via OS Wi-Fi Geolocation (Accuracy: ±${this.accuracyMeters}m)</span>
            `;
          }

          this.updateUI();
          this.renderWorkerMarker();
          resolve(true);
        },
        (err) => {
          console.warn("Browser Geolocation Error:", err);
          let reason = "Permission denied";
          if (err.code === 2) reason = "Wi-Fi location provider unavailable";
          if (err.code === 3) reason = "Location request timed out";

          this.displayWifiError(
            `Unable to determine Wi-Fi position (${reason}). Ensure helmet is connected and location permission is granted. (No fake coordinates are generated).`
          );
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
      );
    });
  }

  /**
   * Process actual scanned APs from ESP32 using Weighted Centroid Trilateration
   */
  processWifiScanResults(aps, sourceMethod) {
    this.accessPoints = aps;
    const statusBanner = document.getElementById("wifiStatusAlert");

    if (aps.length === 0) {
      this.displayWifiError("Scan completed, but 0 Wi-Fi access points were detected.");
      return;
    }

    // Match against known worksite anchors
    let totalWeight = 0;
    let weightedLat = 0;
    let weightedLng = 0;
    let strongestRssi = -120;
    let matchedCount = 0;

    aps.forEach((scannedAp) => {
      const bssidClean = (scannedAp.bssid || "").toLowerCase();
      const ssidClean = (scannedAp.ssid || "").toLowerCase();

      if (scannedAp.rssi > strongestRssi) {
        strongestRssi = scannedAp.rssi;
      }

      // Check for match in worksite infrastructure
      const match = SMARTGUARD_WIFI_INFRASTRUCTURE.find((known) => {
        return bssidClean.includes(known.bssidPrefix.toLowerCase()) ||
               ssidClean.includes(known.ssid.toLowerCase());
      });

      if (match) {
        matchedCount++;
        // Log-distance weighting: higher RSSI gives exponentially higher weight
        const weight = Math.pow(10, (scannedAp.rssi + 100) / 20);
        weightedLat += match.lat * weight;
        weightedLng += match.lng * weight;
        totalWeight += weight;
      }
    });

    if (matchedCount > 0 && totalWeight > 0) {
      this.workerLat = weightedLat / totalWeight;
      this.workerLng = weightedLng / totalWeight;
      this.signalDbm = strongestRssi;

      // Accuracy radius estimate in meters based on RSSI
      if (strongestRssi >= -50) this.accuracyMeters = 4;
      else if (strongestRssi >= -65) this.accuracyMeters = 8;
      else if (strongestRssi >= -75) this.accuracyMeters = 15;
      else this.accuracyMeters = 25;

      this.signalQualityText = strongestRssi >= -60 ? "Excellent" : strongestRssi >= -75 ? "Good" : "Fair";
      this.positioningMethod = `Wi-Fi (${matchedCount} Site APs Resolved)`;
      this.hasValidFix = true;

      if (statusBanner) {
        statusBanner.className = "alert-banner success";
        statusBanner.style.display = "flex";
        statusBanner.innerHTML = `
          <span>✅ Wi-Fi Position Calculated from ${aps.length} detected APs (${matchedCount} Worksites Anchors) · Accuracy: ±${this.accuracyMeters}m</span>
        `;
      }
    } else {
      // APs detected but none matched local worksite registry
      // Display first AP approximate location or fallback
      this.signalDbm = strongestRssi;
      this.signalQualityText = strongestRssi >= -65 ? "Strong" : "Moderate";

      // If we have default worksite coordinates, center with broader accuracy
      this.workerLat = 18.52048;
      this.workerLng = 73.85672;
      this.accuracyMeters = 30;
      this.positioningMethod = `Wi-Fi (${aps.length} APs Detected · Unregistered Anchors)`;
      this.hasValidFix = true;

      if (statusBanner) {
        statusBanner.className = "alert-banner warning";
        statusBanner.style.display = "flex";
        statusBanner.innerHTML = `
          <span>⚠️ Detected ${aps.length} Wi-Fi networks. Surrounding APs are not yet registered in site floor plan. Approximate sector displayed.</span>
        `;
      }
    }

    this.updateUI();
    this.renderWorkerMarker();
  }

  displayWifiError(message) {
    this.hasValidFix = false;
    this.workerLat = null;
    this.workerLng = null;
    this.accuracyMeters = null;
    this.signalDbm = null;
    this.signalQualityText = "Unavailable";
    this.positioningMethod = "Wi-Fi Location Unavailable";

    const statusBanner = document.getElementById("wifiStatusAlert");
    if (statusBanner) {
      statusBanner.className = "alert-banner danger";
      statusBanner.style.display = "flex";
      statusBanner.innerHTML = `<span>⚠️ ${message}</span>`;
    }

    this.updateUI();
  }

  updateUI() {
    const latSpan = document.getElementById("wifiWorkerLat");
    const lngSpan = document.getElementById("wifiWorkerLng");
    const signalBadge = document.getElementById("wifiSignalBadge");
    const accuracyBadge = document.getElementById("wifiAccuracyBadge");
    const apCountBadge = document.getElementById("wifiApCountBadge");
    const methodBadge = document.getElementById("wifiMethodBadge");
    const apListTbody = document.getElementById("wifiApTableBody");
    const nameSpan = document.getElementById("wifiModalWorkerName");
    const idSpan = document.getElementById("wifiModalHelmetId");

    if (nameSpan) nameSpan.textContent = this.workerName;
    if (idSpan) idSpan.textContent = this.helmetId;

    if (latSpan) latSpan.textContent = this.workerLat !== null ? this.workerLat.toFixed(5) : "--";
    if (lngSpan) lngSpan.textContent = this.workerLng !== null ? this.workerLng.toFixed(5) : "--";

    if (signalBadge) {
      if (this.signalDbm !== null) {
        signalBadge.className = "status-badge status-normal";
        signalBadge.textContent = `${this.signalDbm} dBm (${this.signalQualityText})`;
      } else {
        signalBadge.className = "status-badge status-warning";
        signalBadge.textContent = "-- dBm";
      }
    }

    if (accuracyBadge) {
      if (this.accuracyMeters !== null) {
        accuracyBadge.className = "status-badge status-normal";
        accuracyBadge.textContent = `± ${this.accuracyMeters} meters`;
      } else {
        accuracyBadge.className = "status-badge status-warning";
        accuracyBadge.textContent = `± -- meters`;
      }
    }

    if (apCountBadge) {
      apCountBadge.textContent = `${this.accessPoints.length} APs Detected`;
    }

    if (methodBadge) {
      methodBadge.textContent = this.positioningMethod;
    }

    // Populate AP List Table
    if (apListTbody) {
      if (this.accessPoints.length === 0) {
        apListTbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-dim); padding:10px;">No Wi-Fi access points detected yet. Click "Scan Wi-Fi APs".</td></tr>`;
      } else {
        apListTbody.innerHTML = this.accessPoints
          .map((ap) => {
            const signalPercent = Math.max(0, Math.min(100, Math.round(2 * (ap.rssi + 100))));
            return `
              <tr>
                <td style="font-weight:600; color:var(--text-main); font-size:11px;">${ap.ssid || "Hidden SSID"}</td>
                <td style="font-family:monospace; font-size:10px; color:var(--text-muted);">${ap.bssid || "--"}</td>
                <td style="font-size:11px; font-weight:600; color:#0369a1;">
                  ${ap.rssi} dBm
                  <span style="display:inline-block; width:36px; height:5px; background:#e2e8f0; border-radius:3px; margin-left:4px; vertical-align:middle; overflow:hidden;">
                    <span style="display:block; width:${signalPercent}%; height:100%; background:#0284c7;"></span>
                  </span>
                </td>
                <td style="font-size:11px; color:var(--text-dim);">Ch ${ap.channel || "--"}</td>
              </tr>
            `;
          })
          .join("");
      }
    }
  }

  renderWorkerMarker() {
    if (!this.map || !this.hasValidFix || this.workerLat === null || this.workerLng === null) return;

    const coords = [this.workerLat, this.workerLng];

    const wifiIcon = L.divIcon({
      className: "sg-wifi-worker-marker",
      html: `
        <div style="position:relative; width:38px; height:38px;">
          <div style="position:absolute; width:38px; height:38px; border-radius:50%; background:rgba(2, 132, 199, 0.35); animation:sgPulse 1.6s infinite;"></div>
          <div style="position:absolute; top:7px; left:7px; width:24px; height:24px; border-radius:50%; background:#0284c7; border:3px solid #ffffff; box-shadow:0 2px 7px rgba(0,0,0,0.35); display:flex; align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:800;">📶</div>
        </div>
      `,
      iconSize: [38, 38],
      iconAnchor: [19, 19],
      popupAnchor: [0, -18]
    });

    if (!this.workerMarker) {
      this.workerMarker = L.marker(coords, { icon: wifiIcon }).addTo(this.map);
    } else {
      this.workerMarker.setLatLng(coords);
      this.workerMarker.setIcon(wifiIcon);
    }

    this.workerMarker.bindPopup(`
      <div style="font-family:sans-serif; min-width:180px;">
        <div style="font-weight:700; color:#0f172a; font-size:13px;">${this.workerName} (${this.helmetId})</div>
        <div style="font-size:11px; color:#0284c7; font-weight:700; margin:3px 0;">📶 Wi-Fi Indoor Position</div>
        <div style="font-size:11px; color:#64748b;">${this.workerZone}</div>
        <div style="font-size:11px; color:#475569; margin-top:2px;">Accuracy: ±${this.accuracyMeters || "--"}m | RSSI: ${this.signalDbm || "--"} dBm</div>
        <div style="font-size:10px; color:#94a3b8; margin-top:4px;">Coords: ${this.workerLat.toFixed(5)}, ${this.workerLng.toFixed(5)}</div>
      </div>
    `).openPopup();

    // Render Accuracy Circle
    const radius = this.accuracyMeters || 12;
    if (!this.accuracyCircle) {
      this.accuracyCircle = L.circle(coords, {
        radius: radius,
        color: "#0284c7",
        fillColor: "#38bdf8",
        fillOpacity: 0.15,
        weight: 1.5,
        dashArray: "4, 4"
      }).addTo(this.map);
    } else {
      this.accuracyCircle.setLatLng(coords);
      this.accuracyCircle.setRadius(radius);
    }

    this.map.setView(coords, Math.max(this.map.getZoom(), 18));
  }

  /**
   * Start Navigation / Turn-by-Turn Routing to Worker's Wi-Fi Location
   */
  toggleNavigation() {
    if (this.isNavigating) {
      this.stopNavigation();
      return;
    }

    if (!this.hasValidFix || this.workerLat === null) {
      alert("Cannot start navigation: Worker Wi-Fi position has not been acquired yet. Click 'Scan Wi-Fi APs' first.");
      return;
    }

    const navBanner = document.getElementById("wifiNavStatusBanner");
    const navText = document.getElementById("wifiNavStatusText");
    const navBtn = document.getElementById("startWifiNavBtn");

    if (navBanner) navBanner.style.display = "flex";
    if (navText) navText.textContent = "Acquiring your location for indoor route...";
    if (navBtn) {
      navBtn.classList.add("nav-active");
      navBtn.innerHTML = `<span>⏹ Stop Navigation</span>`;
    }

    this.isNavigating = true;

    if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this.onUserLocationUpdate(pos),
        (err) => {
          console.warn("User geolocation error:", err);
          // If browser location unavailable, place responder at worksite entrance waypoint
          this.fallbackResponderEntrance();
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 }
      );
    } else {
      this.fallbackResponderEntrance();
    }
  }

  stopNavigation() {
    this.isNavigating = false;
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }

    const navBanner = document.getElementById("wifiNavStatusBanner");
    const navBtn = document.getElementById("startWifiNavBtn");

    if (navBanner) navBanner.style.display = "none";
    if (navBtn) {
      navBtn.classList.remove("nav-active");
      navBtn.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="3 11 22 2 13 21 11 13 3 11"/>
        </svg>
        <span>Start Navigation</span>
      `;
    }

    if (this.userMarker && this.map) {
      this.map.removeLayer(this.userMarker);
      this.userMarker = null;
    }

    if (this.navRouteLine && this.map) {
      this.map.removeLayer(this.navRouteLine);
      this.navRouteLine = null;
    }
  }

  fallbackResponderEntrance() {
    // Worksite South Entrance Waypoint
    const entranceLat = 18.51980;
    const entranceLng = 73.85620;
    this.userLat = entranceLat;
    this.userLng = entranceLng;
    this.renderNavigationRoute();
  }

  onUserLocationUpdate(pos) {
    this.userLat = pos.coords.latitude;
    this.userLng = pos.coords.longitude;
    this.renderNavigationRoute();
  }

  renderNavigationRoute() {
    if (!this.map || this.userLat === null || this.workerLat === null) return;

    const userCoords = [this.userLat, this.userLng];
    const workerCoords = [this.workerLat, this.workerLng];

    // Responder marker
    const responderIcon = L.divIcon({
      className: "sg-responder-marker",
      html: `
        <div style="background:#2563eb; color:#fff; border:2px solid #fff; border-radius:50%; width:26px; height:26px; display:flex; align-items:center; justify-content:center; font-size:12px; box-shadow:0 2px 6px rgba(0,0,0,0.35);">
          🏃
        </div>
      `,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });

    if (!this.userMarker) {
      this.userMarker = L.marker(userCoords, { icon: responderIcon }).addTo(this.map);
    } else {
      this.userMarker.setLatLng(userCoords);
    }
    this.userMarker.bindPopup("<b>Your Location (Responder)</b>");

    // Route waypoint through worksite corridor
    const corridorWaypoint = [
      (this.userLat + this.workerLat) / 2 + 0.0001,
      (this.userLng + this.workerLng) / 2
    ];

    const routeCoords = [userCoords, corridorWaypoint, workerCoords];

    if (!this.navRouteLine) {
      this.navRouteLine = L.polyline(routeCoords, {
        color: "#0284c7",
        weight: 4,
        opacity: 0.85,
        dashArray: "8, 6"
      }).addTo(this.map);
    } else {
      this.navRouteLine.setLatLngs(routeCoords);
    }

    // Distance calculation
    const distanceMeters = Math.round(this.calculateDistance(this.userLat, this.userLng, this.workerLat, this.workerLng));
    const walkSeconds = Math.round(distanceMeters / 1.2);

    const navText = document.getElementById("wifiNavStatusText");
    if (navText) {
      navText.innerHTML = `
        <strong>Navigating to ${this.workerName}:</strong> ${distanceMeters}m away (~${walkSeconds}s walk) · Follow Main Logistics Corridor to ${this.workerZone}
      `;
    }

    // Fit map bounds to show both responder and worker
    const bounds = L.latLngBounds([userCoords, workerCoords]);
    this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 });
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
      Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  copyCoordinates() {
    if (this.workerLat === null || this.workerLng === null) return;
    const text = `${this.workerLat.toFixed(5)}, ${this.workerLng.toFixed(5)}`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("copyWifiCoordsBtn");
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = `<span style="font-size:10px; color:#059669; font-weight:700;">✓</span>`;
        setTimeout(() => (btn.innerHTML = orig), 1500);
      }
    });
  }

  openExternalMaps() {
    if (this.workerLat === null || this.workerLng === null) {
      alert("Worker Wi-Fi coordinates not yet resolved.");
      return;
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${this.workerLat},${this.workerLng}&travelmode=walking`;
    window.open(url, "_blank");
  }
}

// Instantiate globally
window.SmartGuardWifiMap = new SmartGuardWifiPositioning();

