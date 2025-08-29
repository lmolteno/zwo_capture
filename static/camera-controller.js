class CameraController {
  constructor() {
    this.isCapturing = false;
    this.isRecording = false;
    this.cameraModel = "Unknown";
    this.histogramUpdateInterval = null;
    this.settingsRefreshInterval = null;
    this.roiSelector = null;
    this.currentROI = { x: 0, y: 0, width: 1, height: 1 }; // Normalized coordinates (0-1)
    this.init();
  }

  init() {
    this.bindEvents();
    this.loadCurrentSettings();
    this.startSettingsRefresh();
    this.initROISelector();
    this.updateROISettingsPreview(); // Initialize ROI preview
  }

  bindEvents() {
    // Capture control buttons
    document
      .getElementById("startBtn")
      .addEventListener("click", () => this.startCapture());
    document
      .getElementById("stopBtn")
      .addEventListener("click", () => this.stopCapture());

    // Recording control buttons
    document
      .getElementById("startRecordBtn")
      .addEventListener("click", () => this.startRecording());
    document
      .getElementById("stopRecordBtn")
      .addEventListener("click", () => this.stopRecording());

    // Slider events
    document.getElementById("exposureSlider").addEventListener("input", (e) => {
      this.updateExposureDisplay(e.target.value);
    });
    document
      .getElementById("exposureSlider")
      .addEventListener("change", () => this.updateSettings());

    document.getElementById("gainSlider").addEventListener("input", (e) => {
      this.updateGainDisplay(e.target.value);
    });
    document
      .getElementById("gainSlider")
      .addEventListener("change", () => this.updateSettings());

    // Input field events
    document
      .getElementById("exposureInput")
      .addEventListener("keypress", (e) => {
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
    const settingsInputs = ["binning", "format", "bandwidth"];
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
      this.updateUI(
        status.is_capturing,
        status.is_connected,
        status.camera_model,
      );
      this.updateFPS(status.current_fps);
      this.updateRecordingStatus(
        status.is_recording,
        status.frames_recorded,
        status.recording_directory,
      );
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
    const input = document
      .getElementById("exposureInput")
      .value.trim()
      .toLowerCase();
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
      this.updateExposureDisplay(
        document.getElementById("exposureSlider").value,
      );
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
      const response = await fetch("/camera/start", {
        method: "POST",
      });

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
      const response = await fetch("/camera/stop", {
        method: "POST",
      });

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
      const response = await fetch("/camera/start_recording", {
        method: "POST",
      });

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
      const response = await fetch("/camera/stop_recording", {
        method: "POST",
      });

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

  updateRecordingStatus(
    isRecording,
    framesRecorded = 0,
    recordingDirectory = null,
  ) {
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
    // Clear any ROI overlay when starting capture since preview now shows ROI content
    if (this.roiSelector) {
      this.roiSelector.clearROIDisplay();
    }

    // Update ROI settings panel with current stream
    const roiImage = document.getElementById("roiSettingsImage");
    roiImage.src = "/camera/stream?" + new Date().getTime();
  }

  stopLivePreview() {
    const preview = document.getElementById("cameraPreview");
    preview.src =
      "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjAwIiBoZWlnaHQ9IjQwMCIgZmlsbD0iI2Y4ZjlmYSIvPjx0ZXh0IHg9IjMwMCIgeT0iMjAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IiM2Yzc1N2QiPkNhbWVyYSBQcmV2aWV3PC90ZXh0Pjwvc3ZnPg==";
    // Show ROI overlay again when stopped so user can make selections
    if (this.roiSelector) {
      this.roiSelector.drawROI();
    }

    // Update ROI settings panel with current ROI
    this.updateROISettingsPreview();
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
      this.drawSingleHistogram(
        ctx,
        data.mono_histogram,
        width,
        height,
        "#666666",
      );
      this.updateLegend([{ color: "#666666", label: "Mono" }]);
    } else if (data.r_histogram && data.g_histogram && data.b_histogram) {
      // RGB histogram
      this.drawSingleHistogram(
        ctx,
        data.r_histogram,
        width,
        height,
        "#ff0000",
        0.7,
      );
      this.drawSingleHistogram(
        ctx,
        data.g_histogram,
        width,
        height,
        "#00ff00",
        0.7,
      );
      this.drawSingleHistogram(
        ctx,
        data.b_histogram,
        width,
        height,
        "#0000ff",
        0.7,
      );
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
      exposure: this.sliderToExposure(
        document.getElementById("exposureSlider").value,
      ),
      gain: this.sliderToGain(document.getElementById("gainSlider").value),
      binning: parseInt(document.getElementById("binning").value),
      format: document.getElementById("format").value,
      bandwidth: document.getElementById("bandwidth").value,
      roi_x: this.currentROI.x,
      roi_y: this.currentROI.y,
      roi_width: this.currentROI.width,
      roi_height: this.currentROI.height,
    };

    this.updateROIDisplay();

    try {
      const response = await fetch("/camera/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
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
          this.updateUI(
            status.is_capturing,
            status.is_connected,
            status.camera_model,
          );
          this.updateFPS(status.current_fps);
          this.updateRecordingStatus(
            status.is_recording,
            status.frames_recorded,
            status.recording_directory,
          );
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

  initROISelector() {
    this.roiSelector = new ROISelector("cameraPreview", "roiOverlay", (roi) => {
      this.currentROI = roi;
      this.updateROIDisplay();
      // Update camera settings with new ROI if capturing
      if (this.isCapturing) {
        this.updateSettings();
        // Clear the ROI overlay since the main preview now shows only the ROI content
        this.roiSelector.clearROIDisplay();
      }
    });

    // Bind reset button
    document.getElementById("resetROIBtn").addEventListener("click", () => {
      this.roiSelector.resetROI();
    });
  }

  updateROIDisplay() {
    this.updateROIPixelCoordinates();
    this.updateROISettingsPreview();
  }

  async updateROIPixelCoordinates() {
    try {
      // Get current camera settings to determine full image dimensions
      const response = await fetch("/camera/settings");
      const settings = await response.json();

      // Get camera info for actual sensor dimensions
      const infoResponse = await fetch("/camera/info");
      const info = await infoResponse.json();

      // Calculate actual pixel coordinates based on current binning
      const fullWidth = Math.floor(info.width / settings.binning);
      const fullHeight = Math.floor(info.height / settings.binning);

      const pixelX = Math.round(this.currentROI.x * fullWidth);
      const pixelY = Math.round(this.currentROI.y * fullHeight);
      const pixelWidth = Math.round(this.currentROI.width * fullWidth);
      const pixelHeight = Math.round(this.currentROI.height * fullHeight);

      // Update display
      const positionElement = document.getElementById("roiPosition");
      const sizeElement = document.getElementById("roiSize");

      if (
        this.currentROI.width === 1 &&
        this.currentROI.height === 1 &&
        this.currentROI.x === 0 &&
        this.currentROI.y === 0
      ) {
        positionElement.textContent = "0, 0";
        sizeElement.textContent = "Full Image";
      } else {
        positionElement.textContent = `${pixelX}, ${pixelY}`;
        sizeElement.textContent = `${pixelWidth} × ${pixelHeight}`;
      }
    } catch (error) {
      console.error("Error updating ROI pixel coordinates:", error);
      // Fallback display
      document.getElementById("roiPosition").textContent = "N/A";
      document.getElementById("roiSize").textContent = "N/A";
    }
  }

  updateROISettingsPreview() {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const width = 200;
    const height = 133;

    canvas.width = width;
    canvas.height = height;

    // Fill with black background
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);

    // Draw ROI rectangle if not full image
    if (
      !(
        this.currentROI.width === 1 &&
        this.currentROI.height === 1 &&
        this.currentROI.x === 0 &&
        this.currentROI.y === 0
      )
    ) {
      const roiX = this.currentROI.x * width;
      const roiY = this.currentROI.y * height;
      const roiWidth = this.currentROI.width * width;
      const roiHeight = this.currentROI.height * height;

      // Draw ROI rectangle with red border and semi-transparent fill
      ctx.fillStyle = "rgba(231, 76, 60, 0.3)";
      ctx.fillRect(roiX, roiY, roiWidth, roiHeight);

      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = 2;
      ctx.strokeRect(roiX, roiY, roiWidth, roiHeight);
    }

    // Update the settings panel image
    const roiImage = document.getElementById("roiSettingsImage");
    roiImage.src = canvas.toDataURL("image/png");

    // Setup dragging on the settings overlay if not already done
    this.setupROISettingsDrag();
  }

  setupROISettingsDrag() {
    const overlay = document.getElementById("roiSettingsOverlay");

    // Remove existing event listeners to avoid duplicates
    overlay.onmousedown = null;
    overlay.onmousemove = null;
    overlay.onmouseup = null;
    overlay.ontouchstart = null;
    overlay.ontouchmove = null;
    overlay.ontouchend = null;

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let originalROI = null;

    const getOverlayCoordinates = (event) => {
      const rect = overlay.getBoundingClientRect();
      const clientX =
        event.clientX || (event.touches && event.touches[0].clientX);
      const clientY =
        event.clientY || (event.touches && event.touches[0].clientY);
      return {
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
      };
    };

    const isInsideROI = (x, y) => {
      return (
        x >= this.currentROI.x &&
        x <= this.currentROI.x + this.currentROI.width &&
        y >= this.currentROI.y &&
        y <= this.currentROI.y + this.currentROI.height
      );
    };

    const startDrag = (event) => {
      const coords = getOverlayCoordinates(event);

      // Only start dragging if clicking inside the ROI and ROI is not full image
      if (this.currentROI.width < 1 || this.currentROI.height < 1) {
        if (isInsideROI(coords.x, coords.y)) {
          isDragging = true;
          dragStartX = coords.x;
          dragStartY = coords.y;
          originalROI = { ...this.currentROI };
          overlay.style.cursor = "move";
          event.preventDefault();
        }
      }
    };

    const doDrag = (event) => {
      if (!isDragging) return;

      const coords = getOverlayCoordinates(event);
      const deltaX = coords.x - dragStartX;
      const deltaY = coords.y - dragStartY;

      // Calculate new position
      let newX = originalROI.x + deltaX;
      let newY = originalROI.y + deltaY;

      // Constrain to bounds
      newX = Math.max(0, Math.min(1 - this.currentROI.width, newX));
      newY = Math.max(0, Math.min(1 - this.currentROI.height, newY));

      // Update ROI position
      this.currentROI.x = newX;
      this.currentROI.y = newY;

      // Update displays
      // this.updateROIDisplay();
      this.updateROISettingsPreview();

      event.preventDefault();
    };

    const endDrag = (event) => {
      if (isDragging) {
        isDragging = false;
        this.updateSettings();
        overlay.style.cursor = "default";
        event.preventDefault();
      }
    };

    // Add hover effect
    const onHover = (event) => {
      if (!isDragging) {
        const coords = getOverlayCoordinates(event);
        if (this.currentROI.width < 1 || this.currentROI.height < 1) {
          if (isInsideROI(coords.x, coords.y)) {
            overlay.style.cursor = "move";
          } else {
            overlay.style.cursor = "default";
          }
        } else {
          overlay.style.cursor = "default";
        }
      }
    };

    // Mouse events
    overlay.addEventListener("mousedown", startDrag);
    overlay.addEventListener("mousemove", (event) => {
      doDrag(event);
      onHover(event);
    });
    overlay.addEventListener("mouseup", endDrag);
    overlay.addEventListener("mouseleave", endDrag);

    // Touch events
    overlay.addEventListener("touchstart", startDrag);
    overlay.addEventListener("touchmove", doDrag);
    overlay.addEventListener("touchend", endDrag);
  }
}

class ROISelector {
  constructor(imageId, canvasId, onROIChange) {
    this.image = document.getElementById(imageId);
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext("2d");
    this.onROIChange = onROIChange;

    this.isSelecting = false;
    this.isDragging = false;
    this.dragMode = null; // 'create', 'move', 'resize'
    this.startX = 0;
    this.startY = 0;
    this.currentX = 0;
    this.currentY = 0;
    this.dragStartROI = null; // Store original ROI when dragging starts

    this.roi = { x: 0, y: 0, width: 1, height: 1 }; // Default to full image

    this.init();
  }

  init() {
    // Initial canvas setup
    this.resizeCanvas();

    // Listen for image changes
    this.image.addEventListener("load", () => this.resizeCanvas());

    // Listen for window resize
    window.addEventListener("resize", () => this.resizeCanvas());

    // Mouse events
    this.canvas.addEventListener("mousedown", (e) => this.startSelection(e));
    this.canvas.addEventListener("mousemove", (e) => this.updateSelection(e));
    this.canvas.addEventListener("mouseup", (e) => this.endSelection(e));

    // Touch events for mobile
    this.canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent("mousedown", {
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
      this.startSelection(mouseEvent);
    });

    this.canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const mouseEvent = new MouseEvent("mousemove", {
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
      this.updateSelection(mouseEvent);
    });

    this.canvas.addEventListener("touchend", (e) => {
      e.preventDefault();
      this.endSelection();
    });

    // Double-click/tap to reset to full image
    this.canvas.addEventListener("dblclick", () => this.resetROI());
  }

  resizeCanvas() {
    // Wait a bit for image to fully load/resize
    setTimeout(() => {
      const rect = this.image.getBoundingClientRect();
      const canvas = this.canvas;

      // Account for the border (2px on each side)
      canvas.width = rect.width - 4;
      canvas.height = rect.height - 4;

      // Set the canvas display size to match the image exactly
      canvas.style.width = rect.width - 4 + "px";
      canvas.style.height = rect.height - 4 + "px";

      self.drawROI();
    }, 10);
  }

  getCanvasCoordinates(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  isInsideROI(x, y) {
    return (
      x >= this.roi.x &&
      x <= this.roi.x + this.roi.width &&
      y >= this.roi.y &&
      y <= this.roi.y + this.roi.height
    );
  }

  getDragMode(x, y) {
    // If no ROI set, create new one
    if (
      this.roi.width === 1 &&
      this.roi.height === 1 &&
      this.roi.x === 0 &&
      this.roi.y === 0
    ) {
      return "create";
    }

    // Check if click is inside existing ROI (for dragging)
    if (this.isInsideROI(x, y)) {
      return "move";
    }

    // Otherwise, create new ROI
    return "create";
  }

  startSelection(event) {
    const coords = this.getCanvasCoordinates(event);
    this.isSelecting = true;
    this.startX = coords.x;
    this.startY = coords.y;
    this.currentX = coords.x;
    this.currentY = coords.y;

    this.canvas.style.cursor = "crosshair";
  }

  updateSelection(event) {
    if (!this.isSelecting) return;

    const coords = this.getCanvasCoordinates(event);
    this.currentX = Math.max(0, Math.min(1, coords.x));
    this.currentY = Math.max(0, Math.min(1, coords.y));

    this.drawROI();
  }

  endSelection(event) {
    if (!this.isSelecting) return;

    this.isSelecting = false;
    this.canvas.style.cursor = "default";

    // Calculate final ROI
    const left = Math.min(this.startX, this.currentX);
    const top = Math.min(this.startY, this.currentY);
    const right = Math.max(this.startX, this.currentX);
    const bottom = Math.max(this.startY, this.currentY);

    // Only update if selection is large enough
    const minSize = 0.05; // 5% minimum
    if (right - left >= minSize && bottom - top >= minSize) {
      this.roi = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };

      this.onROIChange(this.roi);
    }

    this.drawROI();
  }

  resetROI() {
    this.roi = { x: 0, y: 0, width: 1, height: 1 };
    this.onROIChange(this.roi);
    this.drawROI();
  }

  drawROI() {
    console.log("Drawing ROI");
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw current selection if selecting
    if (this.isSelecting) {
      const left = Math.min(this.startX, this.currentX) * this.canvas.width;
      const top = Math.min(this.startY, this.currentY) * this.canvas.height;
      const width = Math.abs(this.currentX - this.startX) * this.canvas.width;
      const height = Math.abs(this.currentY - this.startY) * this.canvas.height;

      // Semi-transparent overlay
      this.ctx.fillStyle = "rgba(52, 152, 219, 0.3)";
      this.ctx.fillRect(left, top, width, height);

      // Border
      this.ctx.strokeStyle = "#3498db";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(left, top, width, height);
    }

    // Draw current ROI if not full image
    if (
      !(
        this.roi.width === 1 &&
        this.roi.height === 1 &&
        this.roi.x === 0 &&
        this.roi.y === 0
      )
    ) {
      const x = this.roi.x * this.canvas.width;
      const y = this.roi.y * this.canvas.height;
      const width = this.roi.width * this.canvas.width;
      const height = this.roi.height * this.canvas.height;

      // Dim the area outside ROI
      this.ctx.fillStyle = "rgba(0, 0, 0, 0.4)";

      // Top
      this.ctx.fillRect(0, 0, this.canvas.width, y);
      // Bottom
      this.ctx.fillRect(
        0,
        y + height,
        this.canvas.width,
        this.canvas.height - y - height,
      );
      // Left
      this.ctx.fillRect(0, y, x, height);
      // Right
      this.ctx.fillRect(x + width, y, this.canvas.width - x - width, height);

      // ROI border
      this.ctx.strokeStyle = "#e74c3c";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(x, y, width, height);

      // Corner handles
      const handleSize = 8;
      this.ctx.fillStyle = "#e74c3c";
      // Top-left
      this.ctx.fillRect(
        x - handleSize / 2,
        y - handleSize / 2,
        handleSize,
        handleSize,
      );
      // Top-right
      this.ctx.fillRect(
        x + width - handleSize / 2,
        y - handleSize / 2,
        handleSize,
        handleSize,
      );
      // Bottom-left
      this.ctx.fillRect(
        x - handleSize / 2,
        y + height - handleSize / 2,
        handleSize,
        handleSize,
      );
      // Bottom-right
      this.ctx.fillRect(
        x + width - handleSize / 2,
        y + height - handleSize / 2,
        handleSize,
        handleSize,
      );
    }
  }

  clearROIDisplay() {
    // Clear the canvas overlay - used when camera is showing ROI content
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

// Initialize the camera controller when page loads
document.addEventListener("DOMContentLoaded", () => {
  new CameraController();
});
