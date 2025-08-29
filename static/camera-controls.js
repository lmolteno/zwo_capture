/**
 * CameraController - Handles camera operations, settings, and live preview
 */
class CameraController {
  constructor() {
    this.isCapturing = false;
    this.isRecording = false;
    this.cameraModel = "Unknown";
    this.histogramUpdateInterval = null;
    this.settingsRefreshInterval = null;
    this.currentROI = { x: 0, y: 0, width: 1, height: 1 }; // Normalized coordinates (0-1)
  }

  async init() {
    this.bindEvents();
    await this.loadCurrentSettings();
    this.startSettingsRefresh();
  }

  bindEvents() {
    // Capture control buttons
    document.getElementById("startBtn").addEventListener("click", () => this.startCapture());
    document.getElementById("stopBtn").addEventListener("click", () => this.stopCapture());

    // Recording control buttons
    document.getElementById("startRecordBtn").addEventListener("click", () => this.startRecording());
    document.getElementById("stopRecordBtn").addEventListener("click", () => this.stopRecording());

    // Slider events
    document.getElementById("exposureSlider").addEventListener("input", (e) => {
      this.updateExposureDisplay(e.target.value);
    });
    document.getElementById("exposureSlider").addEventListener("change", () => this.updateSettings());

    document.getElementById("gainSlider").addEventListener("input", (e) => {
      this.updateGainDisplay(e.target.value);
    });
    document.getElementById("gainSlider").addEventListener("change", () => this.updateSettings());

    // Input field events
    document.getElementById("exposureInput").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.parseExposureInput();
        this.updateSettings();
      }
    });
    document.getElementById("exposureInput").addEventListener("blur", () => {
      this.parseExposureInput();
      this.updateSettings();
    });

    document.getElementById("gainInput").addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        this.parseGainInput();
        this.updateSettings();
      }
    });
    document.getElementById("gainInput").addEventListener("blur", () => {
      this.parseGainInput();
      this.updateSettings();
    });

    // Other settings change events
    const settingsInputs = ["binning", "format", "bandwidth", "maxRecordingFps"];
    settingsInputs.forEach((id) => {
      const element = document.getElementById(id);
      element.addEventListener("change", () => this.updateSettings());
    });
  }

  async loadCurrentSettings() {
    try {
      const response = await fetch("/camera/settings");
      const settings = await response.json();

      this.updateSettingsDisplay(settings);

      // Check capture status
      const statusResponse = await fetch("/camera/status");
      const status = await statusResponse.json();
      this.cameraModel = status.camera_model;
      this.updateUI(status.is_capturing, status.is_connected, status.camera_model);
      this.updateFPS(status.current_fps);
      this.updateRecordingStatus(status.is_recording, status.frames_recorded, status.recording_directory);
    } catch (error) {
      console.error("Error loading settings:", error);
    }
  }

  updateSettingsDisplay(settings) {
    // Update slider positions and values from current settings
    this.setExposureFromMicroseconds(settings.exposure);
    this.setGainFromValue(settings.gain);

    // Update other form values
    document.getElementById("binning").value = settings.binning;
    document.getElementById("format").value = settings.format;
    document.getElementById("bandwidth").value = settings.bandwidth;
    document.getElementById("maxRecordingFps").value = settings.max_recording_fps || 30;
  }

  // Logarithmic exposure conversion functions
  sliderToExposure(sliderValue) {
    // Convert 0-100 slider to 1μs - 5s logarithmically
    const minLog = Math.log10(1); // 1μs
    const maxLog = Math.log10(5000000); // 5s in μs
    const logValue = minLog + (sliderValue / 100) * (maxLog - minLog);
    return Math.round(Math.pow(10, logValue));
  }

  exposureToSlider(exposureUs) {
    // Convert μs exposure to 0-100 slider position logarithmically
    const minLog = Math.log10(1);
    const maxLog = Math.log10(5000000);
    const logValue = Math.log10(Math.max(1, Math.min(5000000, exposureUs)));
    return Math.round(((logValue - minLog) / (maxLog - minLog)) * 100);
  }

  formatExposureDisplay(exposureUs) {
    if (exposureUs >= 1000000) {
      return (exposureUs / 1000000).toFixed(1) + "s";
    } else if (exposureUs >= 1000) {
      return (exposureUs / 1000).toFixed(1) + "ms";
    } else {
      return exposureUs + "μs";
    }
  }

  updateExposureDisplay(sliderValue) {
    const exposureUs = this.sliderToExposure(sliderValue);
    const displayValue = this.formatExposureDisplay(exposureUs);
    document.getElementById("exposureInput").value = displayValue;
  }

  setExposureFromMicroseconds(exposureUs) {
    const sliderValue = this.exposureToSlider(exposureUs);
    document.getElementById("exposureSlider").value = sliderValue;
    this.updateExposureDisplay(sliderValue);
  }

  parseExposureInput() {
    const input = document.getElementById("exposureInput").value.trim().toLowerCase();
    let exposureUs = 0;

    // Parse different formats: "10ms", "500μs", "2.5s", "1000" (assumes μs)
    const match = input.match(/^(\d*\.?\d+)\s*(μs|us|ms|s)?$/);

    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2] || "μs"; // default to μs if no unit

      switch (unit) {
        case "s":
          exposureUs = Math.round(value * 1000000);
          break;
        case "ms":
          exposureUs = Math.round(value * 1000);
          break;
        case "μs":
        case "us":
        default:
          exposureUs = Math.round(value);
          break;
      }

      // Clamp to valid range
      exposureUs = Math.max(1, Math.min(5000000, exposureUs));

      // Update slider and display
      this.setExposureFromMicroseconds(exposureUs);
    } else {
      // Invalid input, revert to current slider value
      this.updateExposureDisplay(document.getElementById("exposureSlider").value);
    }
  }

  // Linear gain conversion functions
  sliderToGain(sliderValue) {
    // Convert 0-100 slider to 0-600 gain linearly
    return Math.round((sliderValue / 100) * 600);
  }

  gainToSlider(gainValue) {
    // Convert 0-600 gain to 0-100 slider position
    return Math.round((gainValue / 600) * 100);
  }

  updateGainDisplay(sliderValue) {
    const gainValue = this.sliderToGain(sliderValue);
    document.getElementById("gainInput").value = gainValue;
  }

  setGainFromValue(gainValue) {
    const sliderValue = this.gainToSlider(gainValue);
    document.getElementById("gainSlider").value = sliderValue;
    this.updateGainDisplay(sliderValue);
  }

  parseGainInput() {
    const input = document.getElementById("gainInput").value.trim();
    const gainValue = parseInt(input);

    if (!isNaN(gainValue)) {
      // Clamp to valid range
      const clampedGain = Math.max(0, Math.min(600, gainValue));

      // Update slider and display
      this.setGainFromValue(clampedGain);
    } else {
      // Invalid input, revert to current slider value
      this.updateGainDisplay(document.getElementById("gainSlider").value);
    }
  }

  async startCapture() {
    try {
      const response = await fetch("/camera/start", { method: "POST" });

      if (response.ok) {
        this.isCapturing = true;
        this.updateUI(true);
        this.startLivePreview();
        this.startHistogramUpdates();
      } else {
        alert("Failed to start capture");
      }
    } catch (error) {
      console.error("Error starting capture:", error);
      alert("Error starting capture");
    }
  }

  async stopCapture() {
    try {
      const response = await fetch("/camera/stop", { method: "POST" });

      if (response.ok) {
        this.isCapturing = false;
        this.updateUI(false);
        this.stopLivePreview();
        this.stopHistogramUpdates();
      }
    } catch (error) {
      console.error("Error stopping capture:", error);
    }
  }

  updateUI(capturing, connected = true, cameraModel = "Unknown") {
    const status = document.getElementById("cameraStatus");
    const startBtn = document.getElementById("startBtn");
    const stopBtn = document.getElementById("stopBtn");
    const startRecordBtn = document.getElementById("startRecordBtn");
    const stopRecordBtn = document.getElementById("stopRecordBtn");

    if (!connected) {
      status.textContent = "🔌 Camera Disconnected";
      status.className = "status disconnected";
      startBtn.disabled = true;
      stopBtn.disabled = true;
      startRecordBtn.disabled = true;
      stopRecordBtn.disabled = true;
    } else if (capturing) {
      status.textContent = "🟢 Camera Capturing";
      status.className = "status capturing";
      startBtn.disabled = true;
      stopBtn.disabled = false;
      startRecordBtn.disabled = !capturing || this.isRecording;
      stopRecordBtn.disabled = !this.isRecording;
    } else {
      status.textContent = "🔴 Camera Stopped";
      status.className = "status stopped";
      startBtn.disabled = false;
      stopBtn.disabled = true;
      startRecordBtn.disabled = true;
      stopRecordBtn.disabled = true;
    }

    this.updateCameraInfo(connected, cameraModel);
  }

  updateCameraInfo(connected, cameraModel) {
    const cameraInfo = document.getElementById("cameraInfo");
    const cameraName = document.getElementById("cameraName");

    if (connected && cameraModel !== "Unknown") {
      cameraName.textContent = `📷 ${cameraModel}`;
      cameraInfo.className = "camera-info connected";
    } else if (connected) {
      cameraName.textContent = "📷 Camera Connected";
      cameraInfo.className = "camera-info connected";
    } else {
      cameraName.textContent = "❌ No Camera Connected";
      cameraInfo.className = "camera-info";
    }
  }

  updateFPS(fps) {
    const fpsValue = document.getElementById("fpsValue");
    const fpsDisplay = document.getElementById("fpsDisplay");

    if (fps > 0) {
      fpsValue.textContent = fps.toFixed(1);
      fpsDisplay.style.display = "inline-block";
    } else {
      fpsValue.textContent = "0.0";
      fpsDisplay.style.display = "none";
    }
  }

  async startRecording() {
    try {
      const response = await fetch("/camera/start_recording", { method: "POST" });

      if (response.ok) {
        this.isRecording = true;
        this.updateUI(this.isCapturing, true, this.cameraModel || "Unknown");
      } else {
        alert("Failed to start recording");
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      alert("Error starting recording");
    }
  }

  async stopRecording() {
    try {
      const response = await fetch("/camera/stop_recording", { method: "POST" });

      if (response.ok) {
        this.isRecording = false;
        this.updateUI(this.isCapturing, true, this.cameraModel || "Unknown");
      } else {
        alert("Failed to stop recording");
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      alert("Error stopping recording");
    }
  }

  updateRecordingStatus(isRecording, framesRecorded = 0, recordingDirectory = null) {
    const recordingInfo = document.getElementById("recordingInfo");
    const recordingStatus = document.getElementById("recordingStatus");

    this.isRecording = isRecording;

    if (isRecording) {
      recordingInfo.textContent = `Recording: ${framesRecorded} frames`;
      recordingStatus.className = "recording-status recording";
    } else {
      recordingInfo.textContent = "Not Recording";
      recordingStatus.className = "recording-status";
    }
  }

  startLivePreview() {
    const preview = document.getElementById("cameraPreview");
    preview.src = "/camera/stream?" + new Date().getTime();
    
    // Update ROI settings panel with current stream
    const roiImage = document.getElementById("roiSettingsImage");
    roiImage.src = "/camera/stream?" + new Date().getTime();
  }

  stopLivePreview() {
    const preview = document.getElementById("cameraPreview");
    preview.src = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIgZmlsbD0iI2Y4ZjlmYSIvPjx0ZXh0IHg9IjMwMCIgeT0iMjAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IiM2Yzc1N2QiPkNhbWVyYSBQcmV2aWV3PC90ZXh0Pjwvc3ZnPg==";
  }

  startHistogramUpdates() {
    this.histogramUpdateInterval = setInterval(() => {
      this.updateHistogram();
    }, 500); // Update every 500ms
  }

  stopHistogramUpdates() {
    if (this.histogramUpdateInterval) {
      clearInterval(this.histogramUpdateInterval);
      this.histogramUpdateInterval = null;
    }
    this.clearHistogram();
  }

  async updateHistogram() {
    try {
      const response = await fetch("/camera/histogram");
      if (response.ok) {
        const data = await response.json();
        this.drawHistogram(data);
      }
    } catch (error) {
      console.error("Error updating histogram:", error);
    }
  }

  drawHistogram(data) {
    const canvas = document.getElementById("histogramCanvas");
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    if (data.mono_histogram) {
      // Mono histogram
      this.drawSingleHistogram(ctx, data.mono_histogram, width, height, "#666666");
      this.updateLegend([{ color: "#666666", label: "Mono" }]);
    } else if (data.r_histogram && data.g_histogram && data.b_histogram) {
      // RGB histogram
      this.drawSingleHistogram(ctx, data.r_histogram, width, height, "#ff0000", 0.7);
      this.drawSingleHistogram(ctx, data.g_histogram, width, height, "#00ff00", 0.7);
      this.drawSingleHistogram(ctx, data.b_histogram, width, height, "#0000ff", 0.7);
      this.updateLegend([
        { color: "#ff0000", label: "Red" },
        { color: "#00ff00", label: "Green" },
        { color: "#0000ff", label: "Blue" },
      ]);
    }
  }

  drawSingleHistogram(ctx, histogram, width, height, color, alpha = 1.0) {
    const binWidth = width / 256;
    const maxValue = Math.max(...histogram);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;

    for (let i = 0; i < histogram.length; i++) {
      const barHeight = (histogram[i] / maxValue) * height;
      const x = i * binWidth;
      const y = height - barHeight;

      ctx.fillRect(x, y, binWidth, barHeight);
    }

    ctx.globalAlpha = 1.0;
  }

  updateLegend(items) {
    const legend = document.getElementById("histogramLegend");
    legend.innerHTML = "";

    items.forEach((item) => {
      const legendItem = document.createElement("div");
      legendItem.className = "legend-item";

      const color = document.createElement("div");
      color.className = "legend-color";
      color.style.backgroundColor = item.color;

      const label = document.createElement("span");
      label.textContent = item.label;

      legendItem.appendChild(color);
      legendItem.appendChild(label);
      legend.appendChild(legendItem);
    });
  }

  clearHistogram() {
    const canvas = document.getElementById("histogramCanvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const legend = document.getElementById("histogramLegend");
    legend.innerHTML = "";
  }

  async updateSettings() {
    const settings = {
      exposure: this.sliderToExposure(document.getElementById("exposureSlider").value),
      gain: this.sliderToGain(document.getElementById("gainSlider").value),
      binning: parseInt(document.getElementById("binning").value),
      format: document.getElementById("format").value,
      bandwidth: document.getElementById("bandwidth").value,
      roi_x: this.currentROI.x,
      roi_y: this.currentROI.y,
      roi_width: this.currentROI.width,
      roi_height: this.currentROI.height,
      max_recording_fps: parseFloat(document.getElementById("maxRecordingFps").value),
    };

    try {
      const response = await fetch("/camera/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        // After successful update, fetch and display the actual current settings
        const updatedResponse = await fetch("/camera/settings");
        const updatedSettings = await updatedResponse.json();
        this.updateSettingsDisplay(updatedSettings);
      } else {
        alert("Failed to update settings");
        // Reload current settings on failure to show actual values
        this.loadCurrentSettings();
      }
    } catch (error) {
      console.error("Error updating settings:", error);
      alert("Error updating settings");
      // Reload current settings on error to show actual values
      this.loadCurrentSettings();
    }
  }

  startSettingsRefresh() {
    // Periodically refresh settings to show actual camera state
    this.settingsRefreshInterval = setInterval(async () => {
      try {
        const response = await fetch("/camera/settings");
        if (response.ok) {
          const settings = await response.json();
          this.updateSettingsDisplay(settings);
        }

        // Also check status for connection updates
        const statusResponse = await fetch("/camera/status");
        if (statusResponse.ok) {
          const status = await statusResponse.json();
          this.cameraModel = status.camera_model;
          this.updateUI(status.is_capturing, status.is_connected, status.camera_model);
          this.updateFPS(status.current_fps);
          this.updateRecordingStatus(status.is_recording, status.frames_recorded, status.recording_directory);
        }
      } catch (error) {
        console.error("Error refreshing settings:", error);
        // If we can't reach the API, assume disconnected
        this.updateUI(false, false, "Unknown");
        this.updateFPS(0);
      }
    }, 2000); // Refresh every 2 seconds
  }

  stopSettingsRefresh() {
    if (this.settingsRefreshInterval) {
      clearInterval(this.settingsRefreshInterval);
      this.settingsRefreshInterval = null;
    }
  }

  // Method to update ROI from ROISelector
  updateROI(roi) {
    this.currentROI = roi;
  }
}