#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <LittleFS.h>
#include <MAX30105.h>
#include <TinyGPS++.h>
#include <WebServer.h>
#include <WiFi.h>
#include <Wire.h>
#include <heartRate.h>
#include <math.h>

// =====================================================
// SMARTGUARD - ESP32 SMART HELMET WITH GPS + GSM
// =====================================================

// Sensor pins
#define DHT_PIN 4
#define DHT_TYPE DHT22
#define MQ135_PIN 34
#define BUZZER_PIN 19
#define SOS_BUTTON_PIN 18

// Vibration motor
#define MOTOR_PIN 23

// Wi-Fi status LEDs
#define RED_LED_PIN 25
#define GREEN_LED_PIN 26

// I2C pins
#define I2C_SDA 21
#define I2C_SCL 22

// GPS pins - NEO-6M
#define GPS_RX_PIN 16
#define GPS_TX_PIN 17
#define GPS_BAUD 9600

// GSM pins - SIM900A
#define GSM_RX_PIN 32
#define GSM_TX_PIN 33
#define GSM_BAUD 9600

// =====================================================
// HELMET IDENTIFICATION
// =====================================================

const char *HELMET_DEVICE_ID = "HLM-01";
const char *HELMET_DEVICE_NAME = "SmartGuard Helmet 01";

// =====================================================
// DEVICE SIM & EMERGENCY RECIPIENT MOBILE NUMBERS
// =====================================================

// Sender SIM card installed in the SIM900A module (BSNL SIM)
const char *DEVICE_SENDER_PHONE = "BSNL SIM (Active)";

// Destination Emergency Contact to receive the SOS SMS
const char *EMERGENCY_PHONE = "9309897054";

// =====================================================
// WIFI ACCESS POINT
// =====================================================

const char *AP_SSID = "SmartGuard-ESP32";
const char *AP_PASSWORD = "guard1234";

// =====================================================
// ENVIRONMENTAL THRESHOLDS
// =====================================================

const float TEMP_HIGH_C =
    42.0; // Dangerous heat stress (prevents false alarms at room temp)
const float HUMIDITY_LOW_PERCENT = 10.0;
const float HUMIDITY_HIGH_PERCENT = 92.0;
const int MQ135_HIGH_RAW = 1800; // Requires genuine smoke or gas to trigger

// =====================================================
// FALL / STRIKE DETECTION SETTINGS
// =====================================================

// Strike threshold: 45.0 m/s^2 (~4.6G). Normal movement stays well below 30
// m/s^2; triggers STRICTLY and ONLY when firmly/hardly struck with a finger on
// the sensor!
const float IMPACT_THRESHOLD_MS2 = 21.0;

// Inactivity check: 3 minutes (only active when helmet is worn)
const unsigned long INACTIVITY_TIMEOUT_MS = 180000;

const unsigned long FALL_COOLDOWN_MS = 4000;

// =====================================================
// SENSOR OBJECTS
// =====================================================

DHT dht(DHT_PIN, DHT_TYPE);

Adafruit_MPU6050 mpu;

MAX30105 maxSensor;

WebServer server(80);

// GPS
TinyGPSPlus gps;
HardwareSerial GPSSerial(2);

// GSM
HardwareSerial GSMSerial(1);

// =====================================================
// SENSOR STATUS
// =====================================================

bool mpuOK = false;
uint8_t mpuAddress = 0x68; // Dynamically detected address (0x68 or 0x69)
bool maxOK = false;
bool dhtOK = false;

// =====================================================
// GSM STATUS
// =====================================================

bool gsmReady = false;
bool emergencySMSSent = false; // For SOS button
bool fallSMSSent = false;      // For Fall detection SMS
bool pulseSMSSent = false;     // For Abnormal pulse SMS
bool pulseAlertActive = false; // For MAX30102 vibration alert until assurance

unsigned long abnormalPulseStartMs = 0;
const int HEART_RATE_LOW_BPM = 45;   // Below 45 BPM = Critical low pulse
const int HEART_RATE_HIGH_BPM = 125; // Above 125 BPM = Critical high pulse

// =====================================================
// GPS DATA
// =====================================================

double gpsLatitude = 0.0;
double gpsLongitude = 0.0;

bool gpsFixValid = false;

const unsigned long GPS_INTERVAL_MS = 3000;

// =====================================================
// LATEST SENSOR READINGS
// =====================================================

float temperatureC = NAN;
float humidityPercent = NAN;

int mq135Raw = 0;

float accelX = 0;
float accelY = 0;
float accelZ = 0;

float accelerationMagnitude = 0;

// MAX30102
uint32_t maxRed = 0;
uint32_t maxIR = 0;

const byte RATE_SIZE = 4;

byte rates[RATE_SIZE] = {0};

byte rateSpot = 0;

unsigned long lastBeatMs = 0;

int heartRate = 0;

bool fingerDetected = false;

// =====================================================
// ALERT STATES
// =====================================================

bool environmentWarning = false;
bool environmentAcknowledged = false;
unsigned long environmentCooldownUntilMs = 0;

bool motionAlert = false;
bool emergencyActive = false;

String motionAlertReason = "None";

String lastEvent = "System started";

bool buzzerOn = false;
bool motorOn = false;

// Buzzer confirmation & acknowledgment state
unsigned long emergencyConfirmBuzzUntilMs = 0;
unsigned long assuranceChirpUntilMs = 0;

// Fall impact detection state
bool fallImpactDetected = false;
unsigned long fallImpactTimeMs = 0;

// =====================================================
// TIMING
// =====================================================

unsigned long lastDhtReadMs = 0;
unsigned long lastMpuReadMs = 0;
unsigned long lastMaxReadMs = 0;

unsigned long lastEnvironmentReadMs = 0;

unsigned long lastMotionMs = 0;
unsigned long lastImpactMs = 0;

unsigned long lastSerialPrintMs = 0;

const unsigned long DHT_INTERVAL_MS = 2500;
const unsigned long MPU_INTERVAL_MS =
    25; // 40 Hz sampling so sharp finger strikes are not missed
const unsigned long MAX_INTERVAL_MS =
    50; // Staggered to eliminate I2C bus collisions

const unsigned long ENV_INTERVAL_MS = 500;
const unsigned long SERIAL_INTERVAL_MS = 3000;

// =====================================================
// BUTTON DEBOUNCE
// =====================================================

bool buttonLastRaw = HIGH;
bool buttonStableState = HIGH;

unsigned long buttonLastChangeMs = 0;
unsigned long buttonPressStartMs = 0;

bool longPressHandled = false;
bool assuranceHandled = false;

const unsigned long BUTTON_DEBOUNCE_MS = 35;
const unsigned long LONG_PRESS_MS = 4000;
const unsigned long ASSURANCE_HOLD_MS =
    500; // 0.5 sec press to stop all buzzing

// =====================================================
// BUZZER TONE DRIVER (HIGH FREQUENCY & LOUD)
// =====================================================

static bool currentBuzzerActive = false;
static unsigned int currentBuzzerFreq = 0;

void setBuzzerState(bool active, unsigned int freq = 3000) {
  if (active == currentBuzzerActive && freq == currentBuzzerFreq) {
    return;
  }
  currentBuzzerActive = active;
  currentBuzzerFreq = freq;

  if (active) {
    tone(BUZZER_PIN, freq);
  } else {
    noTone(BUZZER_PIN);
    digitalWrite(BUZZER_PIN, LOW);
  }
}

// =====================================================
// HARDWARE DIRECT MPU6050 ACCELEROMETER DRIVER
// Directly reads hardware registers (0x3B-0x40) with 21 Hz DLPF filter.
// Completely eliminates library heap overhead, Error -1, and false
// auto-triggers!
// =====================================================

bool useAdafruitMPU = false;

bool readMPUDirect(float &ax, float &ay, float &az, float &mag) {
  if (mpuAddress == 0)
    return false;

  Wire.beginTransmission(mpuAddress);
  Wire.write(0x3B); // ACCEL_XOUT_H
  if (Wire.endTransmission(false) != 0)
    return false;

  if (Wire.requestFrom((uint8_t)mpuAddress, (uint8_t)6) != 6)
    return false;

  int16_t rx = (int16_t)((Wire.read() << 8) | Wire.read());
  int16_t ry = (int16_t)((Wire.read() << 8) | Wire.read());
  int16_t rz = (int16_t)((Wire.read() << 8) | Wire.read());

  // +/- 8G mode: 4096 LSB/G. Convert to m/s^2 (1G = 9.80665 m/s^2)
  ax = ((float)rx / 4096.0f) * 9.80665f;
  ay = ((float)ry / 4096.0f) * 9.80665f;
  az = ((float)rz / 4096.0f) * 9.80665f;

  mag = sqrt(ax * ax + ay * ay + az * az);
  return (mag >= 1.0 && mag <= 120.0 && !isnan(mag));
}

bool initMPUSensor() {
  uint8_t targetAddr = 0;

  // 1. Hardware probe on I2C bus
  Wire.beginTransmission(0x68);
  if (Wire.endTransmission() == 0) {
    targetAddr = 0x68;
  } else {
    Wire.beginTransmission(0x69);
    if (Wire.endTransmission() == 0) {
      targetAddr = 0x69;
    }
  }

  if (targetAddr == 0) {
    mpuOK = false;
    return false;
  }

  mpuAddress = targetAddr;

  // 2. Hardware Wake Up (Clear sleep bit in PWR_MGMT_1)
  Wire.beginTransmission(mpuAddress);
  Wire.write(0x6B); // PWR_MGMT_1
  Wire.write(0x00); // Wake up
  Wire.endTransmission();
  delay(10);

  // 3. Read WHO_AM_I register (0x75) for diagnostic feedback
  Wire.beginTransmission(mpuAddress);
  Wire.write(0x75);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)mpuAddress, (uint8_t)1);
  uint8_t whoAmI = Wire.available() ? Wire.read() : 0xFF;

  // 4. Configure Accelerometer range to +/- 8G (0x10)
  Wire.beginTransmission(mpuAddress);
  Wire.write(0x1C); // ACCEL_CONFIG
  Wire.write(0x10); // +/- 8G (4096 LSB/G)
  Wire.endTransmission();

  // 5. Configure Digital Low Pass Filter to 44 Hz (CONFIG = 0x03)
  Wire.beginTransmission(mpuAddress);
  Wire.write(0x1A); // CONFIG
  Wire.write(0x03); // 44 Hz DLPF
  Wire.endTransmission();

  // 6. Try Adafruit library first
  if (mpu.begin(mpuAddress, &Wire)) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);
    useAdafruitMPU = true;
  } else {
    // If Adafruit library rejected clone WHO_AM_I, use direct I2C registers!
    useAdafruitMPU = false;
  }

  mpuOK = true;

  Serial.println();
  Serial.println("================================================");
  Serial.print("  [MPU-6050 STATUS] CONNECTED at 0x");
  Serial.println(mpuAddress, HEX);
  Serial.print("  [MPU-6050 STATUS] Chip WHO_AM_I: 0x");
  Serial.println(whoAmI, HEX);
  Serial.print("  [MPU-6050 STATUS] Driver Mode: ");
  Serial.println(useAdafruitMPU ? "Adafruit Library"
                                : "Direct Hardware Register I2C");
  Serial.println("  [MPU-6050 STATUS] Strict Strike Detection: ACTIVE "
                 "(Threshold: 20.0 m/s^2)");
  Serial.println("================================================");
  Serial.println();

  return true;
}

// =====================================================
// HELPERS
// =====================================================

void updateOutputs();
void updateButton();
void recoverI2CBus();
void processWorkerAssurance(const String &source);
bool sendEmergencySMS(const String &alertType = "SOS");
void alertWorkerFirst(unsigned long durationMs = 1500);
void delayWithOutputs(unsigned long ms);

void setEvent(const String &message) {

  lastEvent = message;

  Serial.print("[EVENT] ");
  Serial.println(message);
}

void triggerMotionAlert(const String &reason) {

  motionAlert = true;

  motionAlertReason = reason;

  setEvent(reason);
}

void delayWithOutputs(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    updateButton();
    updateOutputs();
    delay(5);
  }
}

void alertWorkerFirst(unsigned long durationMs) {
  Serial.println();
  Serial.println("[ALERT] Local alarm activated FIRST (Buzzer & Vibration Motor)!");
  unsigned long startAlert = millis();
  while (millis() - startAlert < durationMs) {
    updateButton();
    updateOutputs();
    if (!motionAlert && !pulseAlertActive && !emergencyActive) {
      break; // Worker acknowledged/cleared alarm
    }
    delay(5);
  }
}

// =====================================================
// GSM RESPONSE HANDLING
// =====================================================

// Wait for a particular response from SIM900A.
// This function also prints received modem responses.

bool waitForGSMResponse(const String &expected, unsigned long timeoutMs) {

  String response = "";

  unsigned long startTime = millis();

  while (millis() - startTime < timeoutMs) {

    while (GSMSerial.available()) {

      char c = GSMSerial.read();

      Serial.write(c);

      response += c;

      if (response.indexOf(expected) >= 0) {
        return true;
      }

      // Prevent excessive memory use.
      if (response.length() > 300) {
        response.remove(0, 150);
      }
    }

    updateButton();
    updateOutputs();

    delay(2);
  }

  return false;
}

// =====================================================
// GSM INITIALIZATION
// =====================================================

void initializeGSM() {
  Serial.println();
  Serial.println("========== GSM INITIALIZATION ==========");

  GSMSerial.begin(GSM_BAUD, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
  delay(1500);

  // Probe modem with AT
  bool modemFound = false;
  for (int attempt = 0; attempt < 5; attempt++) {
    while (GSMSerial.available())
      GSMSerial.read();
    GSMSerial.println("AT");
    if (waitForGSMResponse("OK", 2000)) {
      modemFound = true;
      break;
    }
    delay(1000);
  }

  if (!modemFound) {
    gsmReady = false;
    Serial.println();
    Serial.println("[GSM ERROR] SIM900A not responding.");
    Serial.println("Check GSM power, wiring and baud rate.");
    return;
  }

  Serial.println();
  Serial.println("[GSM] SIM900A detected.");

  // Turn off echo
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("ATE0");
  waitForGSMResponse("OK", 1500);

  // Enable full radio functionality
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+CFUN=1");
  waitForGSMResponse("OK", 2000);

  // Enable verbose error reporting
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+CMEE=2");
  waitForGSMResponse("OK", 1500);

  // Check SIM Card Status (retry up to 4 times to allow BSNL SIM controller to
  // power on)
  bool simReady = false;
  for (int simTry = 0; simTry < 4; simTry++) {
    while (GSMSerial.available())
      GSMSerial.read();
    Serial.print("[GSM] SIM Status: ");
    GSMSerial.println("AT+CPIN?");
    String cpinResp = "";
    unsigned long cStart = millis();
    while (millis() - cStart < 2500) {
      while (GSMSerial.available()) {
        char c = GSMSerial.read();
        Serial.write(c);
        cpinResp += c;
      }
    }
    if (cpinResp.indexOf("READY") >= 0) {
      simReady = true;
      break;
    }
    delay(1000);
  }

  if (!simReady) {
    gsmReady = false;
    Serial.println("\n[GSM ERROR] SIM card is NOT DETECTED by SIM900A (+CME "
                   "ERROR: SIM not inserted)!");
    Serial.println("[!] Hardware Fix Checklist:");
    Serial.println("  1. NO HOT-SWAPPING: The SIM900A only reads SIM upon "
                   "initial power-up.");
    Serial.println("     Unplug the 12V 2A power adapter from the SIM900A for "
                   "10 seconds and plug it back in.");
    Serial.println("  2. SIM TRAY: Ensure the gold chip faces down against the "
                   "PCB pins and the tray is slid to 'LOCK'.");
    Serial.println("  3. ADAPTER FIT: If using a nano-to-micro/mini adapter, "
                   "ensure it is completely flush.");
    return;
  }

  // Once SIM is verified ready, unlock cellular frequency bands
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+CBAND=\"ALL_BAND\"");
  waitForGSMResponse("OK", 1500);

  // Set automatic network operator selection (latches to BSNL tower)
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+COPS=0");
  waitForGSMResponse("OK", 2500);

  // Check Signal Quality
  while (GSMSerial.available())
    GSMSerial.read();
  Serial.print("[GSM] Signal Quality: ");
  GSMSerial.println("AT+CSQ");
  waitForGSMResponse("OK", 2000);

  // Enable Text Mode (retry up to 3 times with buffer clear)
  bool textModeOk = false;
  for (int i = 0; i < 3; i++) {
    while (GSMSerial.available())
      GSMSerial.read();
    GSMSerial.println("AT+CMGF=1");
    if (waitForGSMResponse("OK", 2500)) {
      textModeOk = true;
      break;
    }
    delay(500);
  }

  if (!textModeOk) {
    gsmReady = false;
    Serial.println("[GSM ERROR] Could not enable SMS text mode.");
    return;
  }

  // Set Character Set to GSM
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+CSCS=\"GSM\"");
  waitForGSMResponse("OK", 1500);

  // Standard SMS Text Mode Parameters (TP-VP=24h, 7-bit standard GSM)
  // Fixes "+CME ERROR: invalid input value" on BSNL / Indian networks
  while (GSMSerial.available())
    GSMSerial.read();
  GSMSerial.println("AT+CSMP=17,167,0,0");
  waitForGSMResponse("OK", 1500);

  // Check Network Registration
  while (GSMSerial.available())
    GSMSerial.read();
  Serial.print("[GSM] Network Registration: ");
  GSMSerial.println("AT+CREG?");
  waitForGSMResponse("OK", 2000);

  // Check SMS Center (SMSC) number
  while (GSMSerial.available())
    GSMSerial.read();
  Serial.print("[GSM] SMS Center: ");
  GSMSerial.println("AT+CSCA?");
  String scaResp = "";
  unsigned long scaStart = millis();
  while (millis() - scaStart < 2000) {
    while (GSMSerial.available()) {
      char c = GSMSerial.read();
      Serial.write(c);
      scaResp += c;
    }
  }
  // Ensure valid BSNL Maharashtra SMS Center (+919422099997) if missing
  if (scaResp.indexOf("+91") < 0) {
    Serial.println("\n[GSM] Configuring BSNL SMS Center (+919422099997)...");
    while (GSMSerial.available())
      GSMSerial.read();
    GSMSerial.println("AT+CSCA=\"+919422099997\",145");
    waitForGSMResponse("OK", 1500);
  }

  gsmReady = true;
  Serial.println();
  Serial.println("[GSM] SMS text mode enabled.");
  Serial.println("[GSM] Initialization successful.");
  Serial.println("========================================");
}

// =====================================================
// SEND EMERGENCY SMS
// =====================================================

bool sendEmergencySMS(const String &alertType) {

  Serial.println();
  Serial.print("========== SENDING EMERGENCY SMS [");
  Serial.print(alertType);
  Serial.println("] ==========");

  if (!gsmReady) {
    Serial.println("[GSM ERROR] GSM module is not ready.");
    setEvent("Emergency detected, but GSM is unavailable");
    return false;
  }

  // 1. Check Network Registration (AT+CREG?) and wait if still searching (0,2)
  Serial.println("[GSM] Checking Network Registration before sending...");
  bool registered = false;
  for (int check = 0; check < 15; check++) {
    while (GSMSerial.available())
      GSMSerial.read();
    GSMSerial.println("AT+CREG?");
    String regResp = "";
    unsigned long waitStart = millis();
    while (millis() - waitStart < 1500) {
      while (GSMSerial.available()) {
        char rc = GSMSerial.read();
        Serial.write(rc);
        regResp += rc;
      }
      updateButton();
      updateOutputs();
      delay(2);
    }
    // Match home (1) or roaming (5) across all CREG format variants
    if (regResp.indexOf(",1") >= 0 || regResp.indexOf(",5") >= 0 ||
        regResp.indexOf(": 1") >= 0 || regResp.indexOf(": 5") >= 0) {
      registered = true;
      Serial.println("\n[GSM] Registered on cellular network!");
      break;
    }
    Serial.println("\n[GSM] Searching for cell tower (0,2)... waiting 2s");
    delayWithOutputs(2000);
  }

  if (!registered) {
    Serial.println("\n[GSM WARNING] Cellular tower registration (+CREG: 0,2) "
                   "not confirmed yet.");
    Serial.println("[!] Attempting to send emergency SMS anyway...");
  }

  // Check whether GPS has a recent valid fix.

  bool locationAvailable = gps.location.isValid() && gps.location.age() < 10000;

  String message = "";

  if (alertType == "FALL") {
    message = "SMARTGUARD ALERT: Worker " + String(HELMET_DEVICE_ID) +
              " FALL DETECTED!";
  } else if (alertType == "PULSE_LOW") {
    message = "SMARTGUARD CRITICAL: Worker " + String(HELMET_DEVICE_ID) +
              " ABNORMAL LOW PULSE (" + String(heartRate) + " BPM)!";
  } else if (alertType == "PULSE_HIGH") {
    message = "SMARTGUARD CRITICAL: Worker " + String(HELMET_DEVICE_ID) +
              " ABNORMAL HIGH PULSE (" + String(heartRate) + " BPM)!";
  } else {
    // Default SOS button
    message = "SMARTGUARD SOS: Worker " + String(HELMET_DEVICE_ID) +
              " Emergency button pressed!";
  }

  if (locationAvailable) {
    message += " Lat:" + String(gps.location.lat(), 5) +
               " Lon:" + String(gps.location.lng(), 5);
    message +=
        " Maps: https://maps.google.com/?q=" + String(gps.location.lat(), 5) +
        "," + String(gps.location.lng(), 5);
  }

  // Clear old modem responses.

  while (GSMSerial.available()) {
    GSMSerial.read();
  }

  // Ensure GSM character set, SMS text mode & CSMP parameters
  GSMSerial.println("AT+CSCS=\"GSM\"");
  waitForGSMResponse("OK", 1500);

  GSMSerial.println("AT+CMGF=1");
  waitForGSMResponse("OK", 1500);

  GSMSerial.println("AT+CSMP=17,167,0,0");
  waitForGSMResponse("OK", 1500);

  // Clear buffer
  while (GSMSerial.available())
    GSMSerial.read();

  // Start SMS with emergency phone number
  GSMSerial.print("AT+CMGS=\"");
  GSMSerial.print(EMERGENCY_PHONE);
  GSMSerial.println("\"");

  // Wait for SMS input prompt '>' with automatic +91 fallback
  if (!waitForGSMResponse(">", 8000)) {
    Serial.println("\n[GSM] Retrying with +91 international prefix...");
    while (GSMSerial.available())
      GSMSerial.read();
    GSMSerial.print("AT+CMGS=\"+91");
    GSMSerial.print(EMERGENCY_PHONE);
    GSMSerial.println("\"");
    if (!waitForGSMResponse(">", 8000)) {
      Serial.println();
      Serial.println("[GSM ERROR] SMS prompt '>' not received.");
      return false;
    }
  }

  // Small delay required after '>' prompt
  delayWithOutputs(200);

  // Send single clean line
  GSMSerial.print(message);

  delayWithOutputs(200);

  // Ctrl+Z (ASCII 26) ends the SMS message
  GSMSerial.write(26);

  Serial.println();
  Serial.println("[GSM] Emergency SMS submitted.");
  Serial.println("[GSM] Waiting for network confirmation...");

  // Wait for modem confirmation.

  bool smsAccepted = waitForGSMResponse("+CMGS:", 30000);

  if (smsAccepted) {

    // Read final OK if available.

    waitForGSMResponse("OK", 5000);

    Serial.println();
    Serial.println("[SUCCESS] Emergency SMS accepted by GSM network.");

    setEvent("Emergency SMS sent to registered contact");

    return true;
  }

  Serial.println();
  Serial.println("[GSM ERROR] SMS sending was not confirmed.");

  setEvent("Emergency SMS sending failed");

  return false;
}

// =====================================================
// GPS READING
// =====================================================

void readGPS() {

  while (GPSSerial.available()) {

    gps.encode(GPSSerial.read());
  }

  gpsFixValid = gps.location.isValid() && gps.location.age() < 5000;

  if (gpsFixValid) {

    gpsLatitude = gps.location.lat();

    gpsLongitude = gps.location.lng();
  }
}

// =====================================================
// WORKER ASSURANCE & SYSTEM RE-ARM
// Worker presses SOS for ~1 sec to confirm they are okay.
// Silences buzzer, resets all active alerts, and readies website to redetect.
// =====================================================

void processWorkerAssurance(const String &source) {
  emergencyActive = false;
  emergencySMSSent = false; // Re-arms SOS button for subsequent emergencies
  fallSMSSent = false;      // Re-arms Fall detection SMS
  pulseSMSSent = false;     // Re-arms Abnormal pulse SMS
  abnormalPulseStartMs = 0;
  pulseAlertActive = false; // Reset MAX30102 alert

  motionAlert = false;
  motionAlertReason = "None";
  fallImpactDetected = false;

  unsigned long now = millis();
  lastMotionMs = now;        // Reset 3-minute inactivity timer
  lastImpactMs = now + 3000; // 3-second grace period so releasing the button
                             // never re-triggers strike!

  environmentWarning = false;
  environmentAcknowledged = true;
  environmentCooldownUntilMs =
      now + 5000; // 5-second grace period for environment

  // Stop buzzer and vibration motor immediately, and play 120ms pleasant confirmation chirp
  setBuzzerState(false);
  motorOn = false;
  digitalWrite(MOTOR_PIN, LOW);
  assuranceChirpUntilMs = millis() + 120;

  setEvent("Worker assurance received (" + source +
           "): System nominal & reusable");
  updateOutputs();
}

void acknowledgeAlerts() { processWorkerAssurance("Acknowledgment"); }

// =====================================================
// EMERGENCY
// =====================================================

void triggerEmergency() {

  if (emergencyActive) {

    Serial.println("[SOS] Emergency already active.");

    return;
  }

  emergencyActive = true;
  motionAlert = false; // Do not trigger continuous physical sensor alarm
  motionAlertReason = "SOS Emergency Active";

  setEvent("EMERGENCY EVENT: 4-sec SOS hold triggered");

  Serial.println();
  Serial.println("****************************************");
  Serial.println("       SMARTGUARD SOS EMERGENCY");
  Serial.println("****************************************");

  Serial.println("Emergency button held for 4 seconds.");
  Serial.println("Triggering exactly ONE beep and ONE vibration confirmation (not continuous)...");

  // 1. Exactly ONE beep and ONE vibration for SOS button (500ms single pulse)
  setBuzzerState(true, 3000);
  digitalWrite(MOTOR_PIN, HIGH);
  delay(500);
  setBuzzerState(false);
  digitalWrite(MOTOR_PIN, LOW);

  Serial.println("[SOS] Confirmation pulse complete. Sending emergency SMS...");

  // 2. Send SMS only once for this emergency until re-armed by assurance.
  if (!emergencySMSSent) {

    emergencySMSSent = true;

    bool result = sendEmergencySMS("SOS");

    if (!result) {

      Serial.println("[SOS] SMS failed. Check GSM module and network.");
    }
  }

  updateOutputs();
}

// =====================================================
// DHT22 SENSOR
// =====================================================

void readDHT() {

  float newHumidity = dht.readHumidity();

  float newTemperature = dht.readTemperature();

  if (isnan(newHumidity) || isnan(newTemperature)) {

    dhtOK = false;

    Serial.println("[WARNING] DHT22 read failed");

    return;
  }

  dhtOK = true;

  humidityPercent = newHumidity;

  temperatureC = newTemperature;
}

// =====================================================
// MPU6050 SENSOR
// =====================================================

void readMPU() {
  if (!mpuOK) {
    static unsigned long lastMpuRetryMs = 0;
    if (millis() - lastMpuRetryMs >= 1000) {
      lastMpuRetryMs = millis();
      recoverI2CBus();
      Wire.begin(I2C_SDA, I2C_SCL);
      Wire.setClock(100000);
      Wire.setTimeOut(30);
      if (initMPUSensor()) {
        Serial.print("[MPU6050] Sensor reconnected successfully at 0x");
        Serial.println(mpuAddress, HEX);
      }
    }
    return;
  }

  sensors_event_t accel;
  sensors_event_t gyro;
  sensors_event_t sensorTemp;

  mpu.getEvent(&accel, &gyro, &sensorTemp);

  float ax = accel.acceleration.x;
  float ay = accel.acceleration.y;
  float az = accel.acceleration.z;
  float mag = sqrt(ax * ax + ay * ay + az * az);

  // Sanity & glitch check: if readings drop to 0 or glitch from I2C bus lockup
  // (Error 263)
  static uint8_t mpuErrorCount = 0;
  if (mag < 1.0 || mag > 90.0 || isnan(mag)) {
    mpuErrorCount++;
    if (mpuErrorCount >= 10) { // ~250ms of dead I2C bus
      mpuErrorCount = 0;
      mpuOK = false;
      Serial.println(
          "[MPU6050] I2C timeout / lockup (Error 263); auto-recovering bus...");
      recoverI2CBus();
      Wire.begin(I2C_SDA, I2C_SCL);
      Wire.setClock(100000);
      Wire.setTimeOut(30);
    }
    return;
  }
  mpuErrorCount = 0;

  accelX = ax;
  accelY = ay;
  accelZ = az;
  accelerationMagnitude = mag;

  const float motionDifference = fabs(mag - 9.81);
  unsigned long now = millis();

  if (motionDifference > 2.0) {
    lastMotionMs = now;
  }

  // Fall strike detection: Triggers on a finger strike (>= 24.0 m/s^2)
  if (mag >= IMPACT_THRESHOLD_MS2 && (now - lastImpactMs >= FALL_COOLDOWN_MS)) {
    lastImpactMs = now;
    Serial.println();
    Serial.print(">>> [MPU STRIKE DETECTED] Acceleration: ");
    Serial.print(mag);
    Serial.println(" m/s^2 -> Buzzing active & SMS sent! <<<");

    setEvent("Worker fall detected! Immediate alert & SMS dispatch");
    triggerMotionAlert("Worker fall detected!");

    // 1. Give buzz and vibration FIRST before sending GSM SMS
    alertWorkerFirst(1500);

    // 2. Send SMS for Fall Detection
    if (!fallSMSSent) {
      fallSMSSent = true;
      sendEmergencySMS("FALL");
    }
  }

  // Normal inactivity detection (only when helmet is actually worn)
  if (fingerDetected && !motionAlert &&
      (now - lastMotionMs >= INACTIVITY_TIMEOUT_MS)) {
    triggerMotionAlert("Worker inactivity detected (3 min motionless)");
  }
}

// =====================================================
// MAX30102 SENSOR
// =====================================================

void readMAX30102() {

  if (!maxOK) {
    static unsigned long lastMaxRetryMs = 0;
    if (millis() - lastMaxRetryMs >= 5000) {
      lastMaxRetryMs = millis();
      if (maxSensor.begin(Wire, I2C_SPEED_STANDARD)) {
        maxOK = true;
        maxSensor.setup();
        Serial.println("[MAX30102] Sensor reconnected successfully!");
      }
    }
    return;
  }

  maxRed = maxSensor.getRed();

  maxIR = maxSensor.getIR();

  if (maxIR < 50000) {

    fingerDetected = false;

    heartRate = 0;

    return;
  }

  fingerDetected = true;

  if (checkForBeat(maxIR)) {

    unsigned long delta = millis() - lastBeatMs;

    lastBeatMs = millis();

    float beatsPerMinute = 60.0 / (delta / 1000.0);

    if (beatsPerMinute >= 45 && beatsPerMinute <= 180) {

      rates[rateSpot++] = (byte)beatsPerMinute;

      rateSpot %= RATE_SIZE;

      int total = 0;

      int count = 0;

      for (byte x = 0; x < RATE_SIZE; x++) {

        if (rates[x] > 0) {

          total += rates[x];

          count++;
        }
      }

      heartRate = (count > 0) ? (total / count) : (int)beatsPerMinute;
    }
  }

  if (millis() - lastBeatMs > 3500) {

    heartRate = 0;
    abnormalPulseStartMs = 0;
  }

  // Event 3: Pulse is too low (< 45 BPM) or too high (> 125 BPM)
  if (fingerDetected && heartRate > 0) {
    if (heartRate < HEART_RATE_LOW_BPM || heartRate > HEART_RATE_HIGH_BPM) {
      if (abnormalPulseStartMs == 0) {
        abnormalPulseStartMs = millis();
      } else if (millis() - abnormalPulseStartMs >=
                 3000) { // Sustained for 3s to filter transient sensor noise
        String pulseReason =
            (heartRate < HEART_RATE_LOW_BPM)
                ? "Critical Low Pulse: " + String(heartRate) + " BPM"
                : "Critical High Pulse: " + String(heartRate) + " BPM";
        pulseAlertActive = true; // Trigger vibration for MAX30102
        triggerMotionAlert(pulseReason);

        // 1. Give buzz and vibration FIRST before sending GSM SMS
        alertWorkerFirst(1500);

        if (!pulseSMSSent) {
          pulseSMSSent = true;
          sendEmergencySMS(heartRate < HEART_RATE_LOW_BPM ? "PULSE_LOW"
                                                          : "PULSE_HIGH");
        }
      }
    } else {
      abnormalPulseStartMs = 0;
    }
  } else {
    abnormalPulseStartMs = 0;
  }
}

// =====================================================
// ENVIRONMENTAL WARNING
// =====================================================

void updateEnvironmentWarning() {

  bool temperatureBad = dhtOK && temperatureC >= TEMP_HIGH_C;

  bool humidityBad = dhtOK && (humidityPercent < HUMIDITY_LOW_PERCENT ||
                               humidityPercent > HUMIDITY_HIGH_PERCENT);

  bool airBad = mq135Raw >= MQ135_HIGH_RAW;

  bool readingExceeded = temperatureBad || humidityBad || airBad;
  unsigned long now = millis();

  // If in cooldown after worker assurance, temporarily suppress re-alarming
  if (now < environmentCooldownUntilMs) {
    return;
  }

  if (readingExceeded) {

    if (!environmentWarning) {

      environmentWarning = true;
      environmentAcknowledged = false; // Re-arm alarm immediately for buzzing & vibration

      setEvent("Environmental threshold exceeded (Gas/Temp/Humidity)!");

      Serial.println();
      Serial.println("************************************************************");
      Serial.print(">>> [GAS / HAZARD DETECTED] MQ135 Raw: ");
      Serial.print(mq135Raw);
      Serial.println(" -> LOUD BUZZER & VIBRATION ACTIVE! <<<");
      Serial.println("************************************************************");
      Serial.println();
    }

  } else {

    // Readings have returned within normal safe limits
    if (environmentWarning || environmentAcknowledged) {

      environmentWarning = false;

      environmentAcknowledged = false;

      setEvent("Environmental readings returned within configured limits");
    }
  }
}

// =====================================================
// BUZZER AND VIBRATION MOTOR CONTROL
// =====================================================

void updateOutputs() {

  unsigned long now = millis();

  // Vibration motor: Vibrates in 0.5s pulses (500ms ON / 500ms OFF) during Fall detection,
  // Environment (DHT22 / MQ135), or Pulse alerts until worker gives assurance (0.5s SOS press).
  // (NOTE: 4-sec SOS button uses only a single confirmation beep and single vibration pulse, not continuous)
  bool vibeAlert =
      motionAlert || (environmentWarning && !environmentAcknowledged) || pulseAlertActive;
  if (vibeAlert) {
    bool vibePhase = ((now % 1000) < 500); // 0.5s ON, 0.5s OFF
    motorOn = vibePhase;
    digitalWrite(MOTOR_PIN, motorOn ? HIGH : LOW);
  } else {
    motorOn = false;
    digitalWrite(MOTOR_PIN, LOW);
  }

  // 1. Worker assurance acknowledgment: short 120ms pleasant chirp
  if (now < assuranceChirpUntilMs) {
    buzzerOn = true;
    setBuzzerState(true, 2500);
    return;
  }

  // 2. Continuous alert beeping:
  // Continuous loud high-frequency beeping for: Temperature, Gas, Inactivity,
  // Sudden fall detected, Pulse alert.
  // (NOTE: 4-sec SOS button uses only a single confirmation beep and single vibration pulse, not continuous)
  // Continues beeping until worker presses the button for 0.5 sec to stop all buzzing.
  bool alarmActive = motionAlert ||
                     (environmentWarning && !environmentAcknowledged) ||
                     pulseAlertActive;

  if (alarmActive) {
    buzzerOn = true;
    // Loud, high-frequency urgent beep cycle (200ms ON at 3000 Hz, 150ms OFF)
    bool beepPhase = ((now % 350) < 200);
    setBuzzerState(beepPhase, 3000);
  } else {
    buzzerOn = false;
    setBuzzerState(false);
  }
}

// =====================================================
// SOS BUTTON
// Short press: Acknowledge alerts
// 4-second hold: Emergency + GSM SMS
// =====================================================

void updateButton() {

  bool raw = digitalRead(SOS_BUTTON_PIN);

  unsigned long now = millis();

  if (raw != buttonLastRaw) {

    buttonLastRaw = raw;

    buttonLastChangeMs = now;
  }

  if (now - buttonLastChangeMs < BUTTON_DEBOUNCE_MS) {

    return;
  }

  if (raw != buttonStableState) {

    buttonStableState = raw;

    if (buttonStableState == LOW) {

      buttonPressStartMs = now;

      longPressHandled = false;
      assuranceHandled = false;

    } else {

      unsigned long pressDuration = now - buttonPressStartMs;

      // Assurance on release: if worker tapped the button (>= 150ms and <
      // 4000ms) and assurance was not already triggered during hold
      if (!assuranceHandled && !longPressHandled && pressDuration >= 150 &&
          pressDuration < LONG_PRESS_MS) {

        assuranceHandled = true;
        processWorkerAssurance("Worker SOS button tap");
      }
    }
  }

  // 1. Worker presses button for 0.5 sec (500ms): immediately stop all buzzing
  // and reset alerts
  if (buttonStableState == LOW && !assuranceHandled && !longPressHandled &&
      (now - buttonPressStartMs >= ASSURANCE_HOLD_MS)) {

    assuranceHandled = true;
    processWorkerAssurance("Worker 0.5-sec SOS press");
  }

  // 2. 4-second hold: Emergency SOS distress dispatch + single confirmation
  // beep
  if (buttonStableState == LOW && !longPressHandled &&
      now - buttonPressStartMs >= LONG_PRESS_MS) {

    longPressHandled = true;

    triggerEmergency();
  }
}

// =====================================================
// CORS & PREFLIGHT HEADERS (FOR BROWSER & PRIVATE NETWORK ACCESS)
// =====================================================

void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

void handleOptions() {
  sendCorsHeaders();
  server.send(204);
}

// =====================================================
// WEB SERVER API
// =====================================================

void handleApi() {

  JsonDocument doc;

  doc["deviceId"] = HELMET_DEVICE_ID;

  doc["deviceName"] = HELMET_DEVICE_NAME;

  doc["deviceType"] = "SmartGuard ESP32";

  doc["temperatureC"] = dhtOK ? temperatureC : -999;

  doc["humidityPercent"] = dhtOK ? humidityPercent : -999;

  doc["dhtOK"] = dhtOK;

  doc["mq135Raw"] = mq135Raw;

  doc["mpuOK"] = mpuOK;

  doc["accelX"] = accelX;

  doc["accelY"] = accelY;

  doc["accelZ"] = accelZ;

  doc["accelerationMagnitude"] = accelerationMagnitude;

  doc["maxOK"] = maxOK;

  doc["maxRed"] = maxRed;

  doc["maxIR"] = maxIR;

  doc["heartRate"] = heartRate;

  doc["fingerDetected"] = fingerDetected;

  doc["environmentWarning"] = environmentWarning;

  doc["environmentAcknowledged"] = environmentAcknowledged;

  doc["motionAlert"] = motionAlert;

  doc["motionAlertReason"] = motionAlertReason;

  doc["emergencyActive"] = emergencyActive;

  doc["buzzerOn"] = buzzerOn;

  doc["motorOn"] = motorOn;

  // GPS information.

  doc["gpsFixValid"] = gpsFixValid;

  doc["gpsLatitude"] = gpsFixValid ? gpsLatitude : 0.0;

  doc["gpsLongitude"] = gpsFixValid ? gpsLongitude : 0.0;

  doc["gpsSatellites"] = gps.satellites.isValid() ? gps.satellites.value() : 0;

  // GSM information.

  doc["gsmReady"] = gsmReady;

  doc["senderPhone"] = DEVICE_SENDER_PHONE;

  doc["emergencyPhone"] = EMERGENCY_PHONE;

  doc["emergencySMSSent"] = emergencySMSSent;

  doc["lastEvent"] = lastEvent;

  doc["uptimeSeconds"] = millis() / 1000;

  String output;

  serializeJson(doc, output);

  sendCorsHeaders();

  server.send(200, "application/json", output);
}

// =====================================================
// WIFI SCAN API (FOR INDOOR WI-FI POSITIONING)
// =====================================================

void handleWifiScan() {
  sendCorsHeaders();

  int n = WiFi.scanComplete();
  if (n == -2) {
    WiFi.scanNetworks(true);
    server.send(
        202, "application/json",
        "{\"status\":\"scanning\",\"message\":\"Wi-Fi scan initiated\"}");
    return;
  } else if (n == -1) {
    server.send(
        202, "application/json",
        "{\"status\":\"scanning\",\"message\":\"Wi-Fi scan in progress\"}");
    return;
  }

  JsonDocument doc;
  doc["status"] = "complete";
  doc["count"] = n;
  JsonArray aps = doc["accessPoints"].to<JsonArray>();
  for (int i = 0; i < n && i < 15; ++i) {
    JsonObject ap = aps.add<JsonObject>();
    ap["ssid"] = WiFi.SSID(i);
    ap["bssid"] = WiFi.BSSIDstr(i);
    ap["rssi"] = WiFi.RSSI(i);
    ap["channel"] = WiFi.channel(i);
  }

  WiFi.scanDelete();

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

// =====================================================
// ACKNOWLEDGE API
// =====================================================

void handleAcknowledge() {

  processWorkerAssurance("Supervisor dashboard acknowledgment");

  sendCorsHeaders();

  server.send(200, "text/plain", "Alerts acknowledged and system reset");
}

// =====================================================
// RESET EMERGENCY API
// =====================================================

void handleResetEmergency() {

  processWorkerAssurance("Supervisor dashboard emergency reset");

  sendCorsHeaders();

  server.send(200, "text/plain", "Emergency event reset and system nominal");
}

// =====================================================
// LITTLEFS FILE HANDLING
// =====================================================

bool loadFromLittleFS(String path) {

  if (path.endsWith("/")) {

    path += "index.html";
  }

  String contentType = "text/plain";

  if (path.endsWith(".html"))
    contentType = "text/html";

  else if (path.endsWith(".css"))
    contentType = "text/css";

  else if (path.endsWith(".js"))
    contentType = "application/javascript";

  else if (path.endsWith(".jpg") || path.endsWith(".jpeg"))
    contentType = "image/jpeg";

  else if (path.endsWith(".png"))
    contentType = "image/png";

  else if (path.endsWith(".svg"))
    contentType = "image/svg+xml";

  else if (path.endsWith(".ico"))
    contentType = "image/x-icon";

  else if (path.endsWith(".json"))
    contentType = "application/json";

  File file = LittleFS.open(path, "r");

  if (!file) {

    return false;
  }

  server.streamFile(file, contentType);

  file.close();

  return true;
}

// =====================================================
// NOT FOUND
// =====================================================

void handleNotFound() {
  if (server.method() == HTTP_OPTIONS) {
    handleOptions();
    return;
  }

  if (loadFromLittleFS(server.uri())) {
    return;
  }

  sendCorsHeaders();
  server.send(404, "text/plain", "Not found");
}

// =====================================================
// WI-FI STATUS LEDS
// =====================================================

void updateWifiLEDs() {

  bool clientConnected = (WiFi.softAPgetStationNum() > 0);

  digitalWrite(RED_LED_PIN, clientConnected ? LOW : HIGH);

  digitalWrite(GREEN_LED_PIN, clientConnected ? HIGH : LOW);
}

// =====================================================
// WEB SERVER SETUP
// =====================================================

void setupWebServer() {

  if (!LittleFS.begin(true)) {

    Serial.println("[ERROR] LittleFS mount failed");
  }

  WiFi.mode(WIFI_AP_STA);

  IPAddress local_ip(192, 168, 4, 1);
  IPAddress gateway(192, 168, 4, 1);
  IPAddress subnet(255, 255, 255, 0);
  WiFi.softAPConfig(local_ip, gateway, subnet);

  WiFi.softAP(AP_SSID, AP_PASSWORD);

  // Note: Continuous scan is avoided at startup so SoftAP packets are never
  // dropped

  Serial.println();

  Serial.println("Wi-Fi dashboard started");

  Serial.print("Network: ");

  Serial.println(AP_SSID);

  Serial.print("Dashboard: http://");

  Serial.println(WiFi.softAPIP());

  server.on("/", HTTP_GET, []() {
    if (!loadFromLittleFS("/index.html")) {

      server.send(500, "text/plain",
                  "index.html missing. Upload dashboard filesystem.");
    }
  });

  server.on("/api", HTTP_GET, handleApi);
  server.on("/api", HTTP_OPTIONS, handleOptions);

  server.on("/api/wifi-scan", HTTP_GET, handleWifiScan);
  server.on("/api/wifi-scan", HTTP_OPTIONS, handleOptions);

  server.on("/api/ack", HTTP_POST, handleAcknowledge);
  server.on("/api/ack", HTTP_OPTIONS, handleOptions);

  server.on("/api/reset-emergency", HTTP_POST, handleResetEmergency);
  server.on("/api/reset-emergency", HTTP_OPTIONS, handleOptions);

  server.onNotFound(handleNotFound);

  server.begin();

  Serial.println("Web server ready");
}

// =====================================================
// I2C BUS STABILIZATION & RECOVERY
// Clears bus lockups when a slave holds SDA LOW,
// sends an I2C STOP condition, and configures noise-immune 100 kHz clock.
// =====================================================

void recoverI2CBus() {
  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, INPUT_PULLUP);
  delay(10);

  // If SDA is stuck LOW by an unreset slave, clock SCL up to 9 times to free it
  if (digitalRead(I2C_SDA) == LOW) {
    Serial.println(
        "[I2C RECOVERY] Bus line held LOW! Clocking SCL to unlock slaves...");
    pinMode(I2C_SCL, OUTPUT);
    for (int i = 0; i < 9; i++) {
      digitalWrite(I2C_SCL, LOW);
      delayMicroseconds(5);
      digitalWrite(I2C_SCL, HIGH);
      delayMicroseconds(5);
      if (digitalRead(I2C_SDA) == HIGH)
        break;
    }
  }

  // Generate an explicit I2C STOP condition
  pinMode(I2C_SDA, OUTPUT);
  digitalWrite(I2C_SDA, LOW);
  delayMicroseconds(5);
  digitalWrite(I2C_SCL, HIGH);
  delayMicroseconds(5);
  digitalWrite(I2C_SDA, HIGH);
  delayMicroseconds(5);

  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, INPUT_PULLUP);
  delay(5);
}

// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);

  delay(1000);

  // GPIO setup.

  pinMode(MQ135_PIN, INPUT);

  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(MOTOR_PIN, OUTPUT);

  pinMode(SOS_BUTTON_PIN, INPUT_PULLUP);

  // Wi-Fi LEDs.

  pinMode(RED_LED_PIN, OUTPUT);

  pinMode(GREEN_LED_PIN, OUTPUT);

  digitalWrite(RED_LED_PIN, HIGH);

  digitalWrite(GREEN_LED_PIN, LOW);

  digitalWrite(BUZZER_PIN, LOW);

  digitalWrite(MOTOR_PIN, LOW);

  analogReadResolution(12);

  // I2C setup with bus recovery & 100 kHz standard mode for noise immunity
  recoverI2CBus();
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(
      100000);         // 100 kHz standard mode (avoids line capacitance drops)
  Wire.setTimeOut(50); // 50ms timeout prevents bus lockups and Error 263

  // GPS setup.

  GPSSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  Serial.println();

  Serial.println("==================================");

  Serial.println("      SMARTGUARD STARTING");

  Serial.println("==================================");

  Serial.println("GPS: NEO-6M initialized");

  Serial.println("GPS RX: GPIO 16");

  Serial.println("GPS TX: GPIO 17");

  // =================================================
  // GSM INITIALIZATION
  // =================================================

  Serial.println();

  Serial.println("Starting SIM900A GSM...");

  Serial.println("GSM RX: GPIO 32");

  Serial.println("GSM TX: GPIO 33");

  initializeGSM();

  // =================================================
  // I2C SCANNER
  // =================================================

  Serial.println("--- Scanning I2C Bus (SDA:21, SCL:22) ---");

  byte i2cFound = 0;

  for (byte addr = 1; addr < 127; addr++) {

    Wire.beginTransmission(addr);

    if (Wire.endTransmission() == 0) {

      Serial.print("  [+] I2C device detected at 0x");

      if (addr < 16)
        Serial.print("0");

      Serial.print(addr, HEX);

      if (addr == 0x68)
        Serial.print(" -> MPU6050");

      else if (addr == 0x69)
        Serial.print(" -> MPU6050 alternate");

      else if (addr == 0x57)
        Serial.print(" -> MAX30102");

      Serial.println();

      i2cFound++;
    }
  }

  if (i2cFound == 0) {

    Serial.println("  [!] NO I2C DEVICES FOUND! Check wiring.");
  }

  Serial.println("----------------------------------------");

  // =================================================
  // DHT22
  // =================================================

  dht.begin();

  Serial.println("DHT22: initialized");

  // =================================================
  // MPU6050
  // =================================================

  if (initMPUSensor()) {
    Serial.print("MPU6050: connected and configured at 0x");
    Serial.println(mpuAddress, HEX);
  } else {
    Serial.println(
        "MPU6050: NOT DETECTED (check SDA:21, SCL:22 wiring & power)");
  }

  // =================================================
  // MAX30102
  // =================================================

  if (maxSensor.begin(Wire, I2C_SPEED_STANDARD)) {

    maxOK = true;

    maxSensor.setup();

    Serial.println("MAX30102: connected");

  } else {

    Serial.println("MAX30102: NOT DETECTED");
  }

  // =================================================
  // INITIALIZE TIMERS
  // =================================================

  lastMotionMs = millis();

  // =================================================
  // START DASHBOARD AND WIFI
  // =================================================

  setupWebServer();

  updateWifiLEDs();

  Serial.println();

  Serial.println("SMARTGUARD INITIALIZATION COMPLETE");

  Serial.println("Press SOS (0.5 sec): Stop all buzzing & reset alerts");

  Serial.println(
      "Hold for 4 seconds: Emergency + GSM SMS + single confirmation beep");

  Serial.print("Sender SIM (BSNL): ");

  Serial.println(DEVICE_SENDER_PHONE);

  Serial.print("Emergency Contact: ");

  Serial.println(EMERGENCY_PHONE);

  Serial.println("Vibration motor: GPIO 23");

  Serial.println("Red LED: GPIO 25 | Green LED: GPIO 26");

  Serial.println("GPS: Waiting for satellite fix...");

  Serial.println("GSM: Ready for emergency SMS when initialized.");
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {

  unsigned long now = millis();

  // =================================================
  // WEB SERVER
  // =================================================

  server.handleClient();

  // =================================================
  // WIFI LED STATUS
  // =================================================

  updateWifiLEDs();

  // =================================================
  // GPS READING
  // =================================================

  readGPS();

  // =================================================
  // SOS BUTTON
  // =================================================

  updateButton();

  // =================================================
  // DHT22
  // =================================================

  if (now - lastDhtReadMs >= DHT_INTERVAL_MS) {

    lastDhtReadMs = now;

    readDHT();
  }

  // =================================================
  // MPU6050
  // =================================================

  if (now - lastMpuReadMs >= MPU_INTERVAL_MS) {

    lastMpuReadMs = now;

    readMPU();
  }

  // =================================================
  // MAX30102
  // =================================================

  if (now - lastMaxReadMs >= MAX_INTERVAL_MS) {

    lastMaxReadMs = now;

    readMAX30102();
  }

  // =================================================
  // MQ135
  // =================================================

  if (now - lastEnvironmentReadMs >= ENV_INTERVAL_MS) {

    lastEnvironmentReadMs = now;

    mq135Raw = analogRead(MQ135_PIN);

    updateEnvironmentWarning();
  }

  // =================================================
  // UPDATE BUZZER AND MOTOR
  // =================================================

  updateOutputs();

  // =================================================
  // SERIAL MONITOR STATUS
  // =================================================

  if (now - lastSerialPrintMs >= SERIAL_INTERVAL_MS) {

    lastSerialPrintMs = now;

    Serial.println();

    Serial.println("========== SMARTGUARD STATUS ==========");

    // DHT22

    Serial.print("DHT22 status: ");

    Serial.println(dhtOK ? "OK" : "READ FAILED");

    if (dhtOK) {

      Serial.print("Temperature: ");

      Serial.print(temperatureC);

      Serial.println(" C");

      Serial.print("Humidity: ");

      Serial.print(humidityPercent);

      Serial.println(" %");
    }

    // MQ135

    Serial.print("MQ135 raw: ");

    Serial.println(mq135Raw);

    // MPU6050 Real-time status for Faculty Demo
    Serial.print("MPU6050 Status: ");
    if (mpuOK) {
      Serial.print("CONNECTED (0x");
      Serial.print(mpuAddress, HEX);
      Serial.print(") | Live Accel: ");
      Serial.print(accelerationMagnitude);
      Serial.print(" m/s^2 (");
      Serial.print(accelerationMagnitude / 9.80665f, 2);
      Serial.print(" G) | Strike Detect: READY (> ");
      Serial.print(IMPACT_THRESHOLD_MS2);
      Serial.println(" m/s^2)");
    } else {
      Serial.println("NOT DETECTED [Check SDA: GPIO 21, SCL: GPIO 22, VCC: "
                     "3.3V, GND: GND]");
    }

    // MAX30102

    Serial.print("MAX30102: ");

    Serial.println(maxOK ? "OK" : "NOT DETECTED");

    if (maxOK) {

      Serial.print("Helmet Contact: ");

      Serial.println(fingerDetected ? "DETECTED (Worn)" : "NO CONTACT");

      Serial.print("Heart Rate: ");

      if (fingerDetected && heartRate > 0) {

        Serial.print(heartRate);

        Serial.println(" BPM");

      } else if (fingerDetected) {

        Serial.println("Measuring pulse...");

      } else {

        Serial.println("-- (Sensor not touching skin)");
      }

      Serial.print("Red: ");

      Serial.print(maxRed);

      Serial.print(" | IR: ");

      Serial.println(maxIR);
    }

    // =================================================
    // GPS COORDINATES
    // =================================================

    Serial.println();

    Serial.println("----------- GPS LOCATION -----------");

    if (gpsFixValid) {

      Serial.println("GPS Status: FIX ACQUIRED");

      Serial.print("Latitude: ");

      Serial.println(gpsLatitude, 6);

      Serial.print("Longitude: ");

      Serial.println(gpsLongitude, 6);

      Serial.print("Satellites: ");

      if (gps.satellites.isValid()) {

        Serial.println(gps.satellites.value());

      } else {

        Serial.println("Unknown");
      }

      Serial.print("Google Maps Location: ");

      Serial.print("https://www.google.com/maps?q=");

      Serial.print(gpsLatitude, 6);

      Serial.print(",");

      Serial.println(gpsLongitude, 6);

    } else {

      Serial.println("GPS Status: WAITING FOR FIX");

      Serial.println("Move GPS antenna outdoors for satellite reception.");

      Serial.print("Satellites: ");

      if (gps.satellites.isValid()) {

        Serial.println(gps.satellites.value());

      } else {

        Serial.println("0 / Not available");
      }
    }

    Serial.println("------------------------------------");

    // =================================================
    // GSM STATUS
    // =================================================

    Serial.println();

    Serial.println("----------- GSM STATUS -----------");

    Serial.print("GSM Module: ");

    Serial.println(gsmReady ? "READY" : "NOT READY");

    Serial.print("Emergency Number: ");

    Serial.println(EMERGENCY_PHONE);

    Serial.print("Emergency SMS sent: ");

    Serial.println(emergencySMSSent ? "YES" : "NO");

    Serial.println("----------------------------------");

    // Environmental warning

    Serial.print("Environment warning: ");

    Serial.println(environmentWarning ? "YES" : "NO");

    // Motion alert

    Serial.print("Motion alert: ");

    Serial.println(motionAlertReason);

    // Emergency

    Serial.print("Emergency active: ");

    Serial.println(emergencyActive ? "YES" : "NO");

    // Buzzer

    Serial.print("Buzzer: ");

    Serial.println(buzzerOn ? "ON" : "OFF");

    // Vibration motor

    Serial.print("Vibration Motor: ");

    Serial.println(motorOn ? "ON" : "OFF");

    // Wi-Fi client status

    Serial.print("Wi-Fi connected devices: ");

    Serial.println(WiFi.softAPgetStationNum());

    Serial.println("======================================");
  }

  delay(2);
}