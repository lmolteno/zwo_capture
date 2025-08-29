/**
 * ROISelector - Handles Region of Interest selection and display
 */
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

      this.drawROI();
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

/**
 * ROIManager - Manages ROI display and pixel coordinate calculation
 */
class ROIManager {
  constructor(cameraController) {
    this.cameraController = cameraController;
    this.roiSelector = null;
    this.currentROI = { x: 0, y: 0, width: 1, height: 1 };
  }

  init() {
    this.initROISelector();
    this.updateROISettingsPreview();
    
    // Bind reset button
    document.getElementById("resetROIBtn").addEventListener("click", () => {
      this.roiSelector.resetROI();
    });
  }

  initROISelector() {
    this.roiSelector = new ROISelector("cameraPreview", "roiOverlay", (roi) => {
      this.currentROI = roi;
      this.updateROIDisplay();
      this.cameraController.updateROI(roi);
      
      // Update camera settings with new ROI if capturing
      if (this.cameraController.isCapturing) {
        this.cameraController.updateSettings();
        // Clear the ROI overlay since the main preview now shows only the ROI content
        this.roiSelector.clearROIDisplay();
      }
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
      this.updateROISettingsPreview();
      this.cameraController.updateROI(this.currentROI);

      event.preventDefault();
    };

    const endDrag = (event) => {
      if (isDragging) {
        isDragging = false;
        this.cameraController.updateSettings();
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

  // Method to handle live preview changes
  onLivePreviewStart() {
    if (this.roiSelector) {
      this.roiSelector.clearROIDisplay();
    }
  }

  onLivePreviewStop() {
    if (this.roiSelector) {
      this.roiSelector.drawROI();
    }
    this.updateROISettingsPreview();
  }
}