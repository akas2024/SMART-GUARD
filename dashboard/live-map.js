/**
 * ==========================================================================
 * SMARTGUARD - WORKER LIVE LOCATION & NAVIGATION MAP MODULE
 * File: live-map.js
 * Description: Interactive Leaflet-powered live tracking map with automatic
 *              Live Location and Last Known Location tracking. Zero API key needed!
 * ==========================================================================
 */

// Preset worksite zone defaults when GPS has not yet received its first fix
const SMARTGUARD_ZONE_COORDS = {
  "Zone A - Scaffold Tower": { lat: 18.52043, lng: 73.85674, note: "Scaffold Tower & High-Rise Elevation" },
  "Zone B - Excavation Pit": { lat: 18.52185, lng: 73.85490, note: "Excavation Pit & Heavy Earthmoving" },
  "Zone C - Chemical Storage": { lat: 18.51890, lng: 73.85820, note: "Hazardous Chemical & Gas Storage" },
  "Zone D - Welding Bay": { lat: 18.52240, lng: 73.85960, note: "Welding & Fabrication Workshop" }
};

class SmartGuardLiveMap {
  constructor() {
    this.modal = null;
    this.map = null;
    this.leafletLoaded = false;
    this.loadingScript = false;

    // Markers & Layers
    this.liveMarker = null;
    this.lastKnownMarker = null;
    this.trailLine = null;
    this.accuracyCircle = null;

    // Coordinates state
    this.workerLat = 18.52043;
    this.workerLng = 73.85674;
    this.lastKnownLat = 18.52043;
    this.lastKnownLng = 73.85674;
    this.lastSeenTimestamp = "System started";
    this.hasActiveFix = false;

    // Worker metadata
    this.workerName = "Akash Patil";
    this.helmetId = "HLM-05";
    this.workerZone = "Zone C - Chemical Storage";
    this.satellites = 0;

    // User navigation state
    this.userLat = null;
    this.userLng = null;
    this.userMarker = null;
    this.isNavigating = false;
    this.watchId = null;

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

    if (SMARTGUARD_ZONE_COORDS[this.workerZone]) {
      this.workerLat = SMARTGUARD_ZONE_COORDS[this.workerZone].lat;
      this.workerLng = SMARTGUARD_ZONE_COORDS[this.workerZone].lng;
      this.lastKnownLat = this.workerLat;
      this.lastKnownLng = this.workerLng;
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.bindUI());
    } else {
      this.bindUI();
    }
  }

  bindUI() {
    this.modal = document.getElementById("locationMapModal");
    const openBtn = document.getElementById("openLiveLocationBtn");
    const closeBtn = document.getElementById("closeLocationModalBtn");
    const navBtn = document.getElementById("startNavigationBtn");
    const externalNavBtn = document.getElementById("openExternalMapsBtn");
    const copyCoordsBtn = document.getElementById("copyCoordsBtn");

    if (openBtn) openBtn.addEventListener("click", () => this.openModal());
    if (closeBtn) closeBtn.addEventListener("click", () => this.closeModal());
    if (navBtn) navBtn.addEventListener("click", () => this.toggleNavigation());
    if (externalNavBtn) externalNavBtn.addEventListener("click", () => this.openExternalNavigation());
    if (copyCoordsBtn) copyCoordsBtn.addEventListener("click", () => this.copyCoordinates());

    if (this.modal) {
      this.modal.addEventListener("click", (e) => {
        if (e.target === this.modal) this.closeModal();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.modal && this.modal.classList.contains("open")) {
        this.closeModal();
      }
    });
  }

  /**
   * Called automatically by telemetry-monitor.js on every ESP32 /api poll
   */
  updateWorkerLocation(lat, lng, fixValid, satellites = 0, zone = null) {
    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.satellites = satellites || 0;
    if (zone) this.workerZone = zone;

    const validNumbers = typeof lat === "number" && typeof lng === "number" && !isNaN(lat) && !isNaN(lng) && (lat !== 0 || lng !== 0);

    if (fixValid && validNumbers) {
      // Active confirmed GPS fix
      this.hasActiveFix = true;
      this.workerLat = lat;
      this.workerLng = lng;
      this.lastKnownLat = lat;
      this.lastKnownLng = lng;
      this.lastSeenTimestamp = `Live at ${nowStr}`;
    } else if (validNumbers) {
      // Coordinates reported, fix unconfirmed
      this.hasActiveFix = false;
      this.lastKnownLat = lat;
      this.lastKnownLng = lng;
      this.lastSeenTimestamp = `Last seen at ${nowStr}`;
    } else {
      // Retain last known coordinates
      this.hasActiveFix = false;
    }

    this.updateCoordinateDisplays();

    if (this.map && window.L) {
      this.refreshMapMarkers();
    }
  }

  updateCoordinateDisplays() {
    const latSpan = document.getElementById("modalWorkerLat");
    const lngSpan = document.getElementById("modalWorkerLng");
    const nameSpan = document.getElementById("modalWorkerName");
    const idSpan = document.getElementById("modalHelmetId");
    const zoneSpan = document.getElementById("modalWorkerZone");
    const statusPill = document.getElementById("modalGpsStatusPill");
    const lastSeenText = document.getElementById("modalLastSeenText");

    const displayLat = this.hasActiveFix ? this.workerLat : this.lastKnownLat;
    const displayLng = this.hasActiveFix ? this.workerLng : this.lastKnownLng;

    if (latSpan) latSpan.textContent = displayLat.toFixed(5);
    if (lngSpan) lngSpan.textContent = displayLng.toFixed(5);
    if (nameSpan) nameSpan.textContent = this.workerName;
    if (idSpan) idSpan.textContent = this.helmetId;
    if (zoneSpan) zoneSpan.textContent = this.workerZone;

    if (statusPill) {
      if (this.hasActiveFix) {
        statusPill.className = "status-badge status-normal";
        statusPill.innerHTML = `🟢 Live GPS (${this.satellites} Sats)`;
      } else {
        statusPill.className = "status-badge status-warning";
        statusPill.innerHTML = `🟡 Last Known Location`;
      }
    }

    if (lastSeenText) {
      lastSeenText.textContent = this.lastSeenTimestamp;
    }
  }

  openModal() {
    if (!this.modal) return;
    this.modal.classList.add("open");
    document.body.style.overflow = "hidden";

    this.updateCoordinateDisplays();
    this.ensureLeafletLoaded();

    setTimeout(() => {
      if (this.map) this.map.invalidateSize();
    }, 250);

    if (window.SmartGuardWifiMap) {
      window.SmartGuardWifiMap.workerName = this.workerName;
      window.SmartGuardWifiMap.helmetId = this.helmetId;
      window.SmartGuardWifiMap.workerZone = this.workerZone;
      if (window.SmartGuardWifiMap.activeTab === "wifi") {
        window.SmartGuardWifiMap.ensureWifiMap();
      }
    }
  }

  closeModal() {
    if (!this.modal) return;
    this.modal.classList.remove("open");
    document.body.style.overflow = "";

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.isNavigating = false;
    this.resetNavigationUI();

    if (window.SmartGuardWifiMap && window.SmartGuardWifiMap.isNavigating) {
      window.SmartGuardWifiMap.stopNavigation();
    }
  }

  ensureLeafletLoaded() {
    if (window.L) {
      this.renderMap();
      return;
    }

    if (this.loadingScript) return;
    this.loadingScript = true;

    // Load Leaflet CSS
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    // Load Leaflet JS
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.onload = () => {
      this.loadingScript = false;
      this.leafletLoaded = true;
      this.renderMap();
    };
    script.onerror = () => {
      this.loadingScript = false;
      console.error("Failed to load Leaflet library.");
    };
    document.head.appendChild(script);
  }

  renderMap() {
    const container = document.getElementById("smartguardGmap");
    if (!container || !window.L) return;

    const centerLat = this.hasActiveFix ? this.workerLat : this.lastKnownLat;
    const centerLng = this.hasActiveFix ? this.workerLng : this.lastKnownLng;

    if (!this.map) {
      container.innerHTML = "";

      this.map = L.map("smartguardGmap", {
        center: [centerLat, centerLng],
        zoom: 17,
        zoomControl: true
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
      }).addTo(this.map);

      setTimeout(() => {
        if (this.map) this.map.invalidateSize();
      }, 250);
    } else {
      this.map.invalidateSize();
      this.map.setView([centerLat, centerLng], this.map.getZoom());
    }

    this.refreshMapMarkers();
  }

  refreshMapMarkers() {
    if (!this.map || !window.L) return;

    const liveCoords = [this.workerLat, this.workerLng];
    const lastKnownCoords = [this.lastKnownLat, this.lastKnownLng];

    const liveIcon = L.divIcon({
      className: "sg-live-marker-wrapper",
      html: `
        <div style="position:relative; width:34px; height:34px;">
          <div style="position:absolute; width:34px; height:34px; border-radius:50%; background:rgba(16,185,129,0.35); animation:sgPulse 1.8s infinite;"></div>
          <div style="position:absolute; top:6px; left:6px; width:22px; height:22px; border-radius:50%; background:#059669; border:3px solid #ffffff; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px; font-weight:800;">⛑</div>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -18]
    });

    const lastKnownIcon = L.divIcon({
      className: "sg-last-marker-wrapper",
      html: `
        <div style="position:relative; width:30px; height:30px;">
          <div style="position:absolute; top:4px; left:4px; width:22px; height:22px; border-radius:50%; background:#d97706; border:3px solid #ffffff; box-shadow:0 2px 5px rgba(0,0,0,0.3); display:flex; align-items:center; justify-content:center; color:#fff; font-size:10px; font-weight:800;">📍</div>
        </div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -15]
    });

    if (this.hasActiveFix) {
      if (!this.liveMarker) {
        this.liveMarker = L.marker(liveCoords, { icon: liveIcon }).addTo(this.map);
      } else {
        this.liveMarker.setLatLng(liveCoords);
        this.liveMarker.setIcon(liveIcon);
      }

      this.liveMarker.bindPopup(`
        <div style="font-family:sans-serif; min-width:160px;">
          <div style="font-weight:700; color:#0f172a; font-size:13px;">${this.workerName} (${this.helmetId})</div>
          <div style="font-size:11px; color:#059669; font-weight:700; margin:3px 0;">🟢 Live Location Active</div>
          <div style="font-size:11px; color:#64748b;">${this.workerZone}</div>
          <div style="font-size:10px; color:#94a3b8; margin-top:4px;">Coords: ${this.workerLat.toFixed(5)}, ${this.workerLng.toFixed(5)}</div>
        </div>
      `);

      const dist = Math.hypot(this.workerLat - this.lastKnownLat, this.workerLng - this.lastKnownLng);
      if (dist > 0.0001) {
        if (!this.lastKnownMarker) {
          this.lastKnownMarker = L.marker(lastKnownCoords, { icon: lastKnownIcon }).addTo(this.map);
        } else {
          this.lastKnownMarker.setLatLng(lastKnownCoords);
        }
        this.lastKnownMarker.bindPopup(`<b>Last Known Location</b><br><span style="font-size:11px; color:#64748b;">${this.lastSeenTimestamp}</span>`);

        if (!this.trailLine) {
          this.trailLine = L.polyline([lastKnownCoords, liveCoords], {
            color: "#d97706",
            dashArray: "6, 6",
            weight: 3,
            opacity: 0.75
          }).addTo(this.map);
        } else {
          this.trailLine.setLatLngs([lastKnownCoords, liveCoords]);
        }
      } else {
        if (this.lastKnownMarker) {
          this.map.removeLayer(this.lastKnownMarker);
          this.lastKnownMarker = null;
        }
        if (this.trailLine) {
          this.map.removeLayer(this.trailLine);
          this.trailLine = null;
        }
      }
    } else {
      if (this.liveMarker) {
        this.map.removeLayer(this.liveMarker);
        this.liveMarker = null;
      }
      if (this.trailLine) {
        this.map.removeLayer(this.trailLine);
        this.trailLine = null;
      }

      if (!this.lastKnownMarker) {
        this.lastKnownMarker = L.marker(lastKnownCoords, { icon: lastKnownIcon }).addTo(this.map);
      } else {
        this.lastKnownMarker.setLatLng(lastKnownCoords);
        this.lastKnownMarker.setIcon(lastKnownIcon);
      }

      this.lastKnownMarker.bindPopup(`
        <div style="font-family:sans-serif; min-width:160px;">
          <div style="font-weight:700; color:#0f172a; font-size:13px;">${this.workerName} (${this.helmetId})</div>
          <div style="font-size:11px; color:#d97706; font-weight:700; margin:3px 0;">🟡 Last Known Location</div>
          <div style="font-size:11px; color:#64748b;">${this.lastSeenTimestamp}</div>
          <div style="font-size:10px; color:#94a3b8; margin-top:4px;">Coords: ${this.lastKnownLat.toFixed(5)}, ${this.lastKnownLng.toFixed(5)}</div>
        </div>
      `).openPopup();
    }
  }

  openExternalNavigation() {
    const targetLat = this.hasActiveFix ? this.workerLat : this.lastKnownLat;
    const targetLng = this.hasActiveFix ? this.workerLng : this.lastKnownLng;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${targetLat},${targetLng}&travelmode=walking`;
    window.open(url, "_blank");
  }

  toggleNavigation() {
    if (this.isNavigating) {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.isNavigating = false;
      this.resetNavigationUI();
      return;
    }

    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    const banner = document.getElementById("navStatusBanner");
    const navText = document.getElementById("navStatusText");
    const navBtn = document.getElementById("startNavigationBtn");

    if (banner) banner.style.display = "flex";
    if (navText) navText.textContent = "Acquiring your GPS location...";
    if (navBtn) navBtn.classList.add("nav-active");

    this.isNavigating = true;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onUserLocationUpdate(pos),
      (err) => {
        console.warn("Geolocation watch error:", err);
        if (navText) navText.textContent = "Unable to read device GPS. Check location permissions.";
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
  }

  onUserLocationUpdate(position) {
    this.userLat = position.coords.latitude;
    this.userLng = position.coords.longitude;

    if (!this.map || !window.L) return;

    const userIcon = L.divIcon({
      className: "sg-user-marker-wrapper",
      html: `
        <div style="position:relative; width:22px; height:22px;">
          <div style="position:absolute; width:22px; height:22px; border-radius:50%; background:rgba(37,99,235,0.3); animation:sgPulse 1.5s infinite;"></div>
          <div style="position:absolute; top:4px; left:4px; width:14px; height:14px; border-radius:50%; background:#2563eb; border:2.5px solid #ffffff; box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>
        </div>
      `,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    if (!this.userMarker) {
      this.userMarker = L.marker([this.userLat, this.userLng], { icon: userIcon }).addTo(this.map);
      this.userMarker.bindPopup("<b>Your Current Location</b>");
    } else {
      this.userMarker.setLatLng([this.userLat, this.userLng]);
    }

    const targetLat = this.hasActiveFix ? this.workerLat : this.lastKnownLat;
    const targetLng = this.hasActiveFix ? this.workerLng : this.lastKnownLng;

    if (!this.navLine) {
      this.navLine = L.polyline([[this.userLat, this.userLng], [targetLat, targetLng]], {
        color: "#2563eb",
        weight: 4,
        dashArray: "8, 8",
        opacity: 0.85
      }).addTo(this.map);
    } else {
      this.navLine.setLatLngs([[this.userLat, this.userLng], [targetLat, targetLng]]);
    }

    const distMeters = this.calculateDistance(this.userLat, this.userLng, targetLat, targetLng);
    const navText = document.getElementById("navStatusText");
    if (navText) {
      navText.textContent = `Direct Distance to Worker: ~${Math.round(distMeters)} meters.`;
    }
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  resetNavigationUI() {
    const banner = document.getElementById("navStatusBanner");
    const navBtn = document.getElementById("startNavigationBtn");
    if (banner) banner.style.display = "none";
    if (navBtn) navBtn.classList.remove("nav-active");

    if (this.userMarker && this.map) {
      this.map.removeLayer(this.userMarker);
      this.userMarker = null;
    }
    if (this.navLine && this.map) {
      this.map.removeLayer(this.navLine);
      this.navLine = null;
    }
  }

  copyCoordinates() {
    const targetLat = this.hasActiveFix ? this.workerLat : this.lastKnownLat;
    const targetLng = this.hasActiveFix ? this.workerLng : this.lastKnownLng;
    const text = `${targetLat.toFixed(5)}, ${targetLng.toFixed(5)}`;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("copyCoordsBtn");
      if (btn) {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1800);
      }
    });
  }
}

window.SmartGuardLiveMap = new SmartGuardLiveMap();
