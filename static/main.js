/**
 * Main Application Entry Point
 * Coordinates all camera controller components
 */

// Global instances for cross-module communication
let cameraController = null;
let roiManager = null;
let schedulerUI = null;

/**
 * Application class that orchestrates all components
 */
class CameraApplication {
  constructor() {
    this.cameraController = null;
    this.roiManager = null;
    this.schedulerUI = null;
  }

  async init() {
    try {
      console.log("Initializing Camera Application...");

      // Initialize core camera controller
      this.cameraController = new CameraController();
      const roi = await this.cameraController.init();

      // Initialize ROI manager
      this.roiManager = new ROIManager(this.cameraController, roi);
      this.roiManager.init();

      // Initialize scheduler UI
      this.schedulerUI = new SchedulerUI();
      this.schedulerUI.init();

      // Set up cross-component communication
      this.setupCommunication();

      // Store global references for onclick handlers
      cameraController = this.cameraController;
      roiManager = this.roiManager;
      schedulerUI = this.schedulerUI;

      console.log("Camera Application initialized successfully");

      // Perform initial data load
      await this.loadInitialData();
    } catch (error) {
      console.error("Failed to initialize Camera Application:", error);
      this.showError(
        "Failed to initialize the camera application. Please refresh the page.",
      );
    }
  }

  setupCommunication() {
    // Enhance camera controller to notify ROI manager of preview changes
    const originalStartLivePreview = this.cameraController.startLivePreview;
    const originalStopLivePreview = this.cameraController.stopLivePreview;

    this.cameraController.startLivePreview = () => {
      originalStartLivePreview.call(this.cameraController);
      this.roiManager.onLivePreviewStart();
    };

    this.cameraController.stopLivePreview = () => {
      originalStopLivePreview.call(this.cameraController);
      this.roiManager.onLivePreviewStop();
    };
  }

  async loadInitialData() {
    // Load all initial data in parallel for faster startup
    const promises = [
      this.cameraController.loadCurrentSettings(),
      this.schedulerUI.loadSchedules(),
      this.schedulerUI.loadScheduleStatus(),
    ];

    try {
      await Promise.all(promises);
    } catch (error) {
      console.error("Error loading initial data:", error);
    }
  }

  showError(message) {
    // Create a simple error display
    const errorDiv = document.createElement("div");
    errorDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #dc3545;
      color: white;
      padding: 15px 20px;
      border-radius: 5px;
      z-index: 10000;
      max-width: 400px;
      box-shadow: 0 4px 8px rgba(0,0,0,0.2);
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);

    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (errorDiv.parentNode) {
        errorDiv.parentNode.removeChild(errorDiv);
      }
    }, 10000);
  }

  // Cleanup method for proper shutdown
  cleanup() {
    if (this.cameraController) {
      this.cameraController.stopSettingsRefresh();
      this.cameraController.stopHistogramUpdates();
    }

    if (this.schedulerUI) {
      this.schedulerUI.stopScheduleRefresh();
    }
  }

  // Utility methods for component access
  getCameraController() {
    return this.cameraController;
  }

  getROIManager() {
    return this.roiManager;
  }

  getSchedulerUI() {
    return this.schedulerUI;
  }
}

// Application instance
let app = null;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", async () => {
  app = new CameraApplication();
  await app.init();
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  if (app) {
    app.cleanup();
  }
});

// Global error handler
window.addEventListener("error", (event) => {
  console.error("Global error:", event.error);
});

// Global unhandled promise rejection handler
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  event.preventDefault(); // Prevent default browser error handling
});

// Export for external access if needed
window.CameraApp = {
  getInstance: () => app,
  getCameraController: () => cameraController,
  getROIManager: () => roiManager,
  getSchedulerUI: () => schedulerUI,
};
