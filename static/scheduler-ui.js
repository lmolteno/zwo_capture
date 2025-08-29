/**
 * SchedulerUI - Handles scheduling interface and operations
 */
class SchedulerUI {
  constructor() {
    this.scheduleRefreshInterval = null;
  }

  init() {
    this.bindEvents();
    this.initScheduling();
  }

  bindEvents() {
    // Schedule control buttons
    document.getElementById("createScheduleBtn").addEventListener("click", () => this.createSchedule());
    document.getElementById("refreshSchedulesBtn").addEventListener("click", () => this.loadSchedules());
  }

  initScheduling() {
    // Set default datetime values (30 minutes from now, 2 hours duration)
    const now = new Date();
    const startTime = new Date(now.getTime() + 30 * 60000); // 30 minutes from now
    const endTime = new Date(startTime.getTime() + 2 * 60 * 60000); // 2 hours later
    
    document.getElementById("startDateTime").value = this.formatDateTimeLocal(startTime);
    document.getElementById("endDateTime").value = this.formatDateTimeLocal(endTime);
    
    // Load existing schedules
    this.loadSchedules();
    this.loadScheduleStatus();
    
    // Start periodic refresh
    this.startScheduleRefresh();
  }

  formatDateTimeLocal(date) {
    // Format date for datetime-local input (YYYY-MM-DDTHH:MM)
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  formatDateTimeDisplay(isoString) {
    // Format ISO datetime for display
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  async createSchedule() {
    try {
      const name = document.getElementById("scheduleName").value.trim();
      const description = document.getElementById("scheduleDescription").value.trim();
      const startTime = document.getElementById("startDateTime").value;
      const endTime = document.getElementById("endDateTime").value;

      if (!name) {
        alert("Please enter a session name");
        return;
      }

      if (!startTime || !endTime) {
        alert("Please select start and end times");
        return;
      }

      // Validate time range
      const startDate = new Date(startTime);
      const endDate = new Date(endTime);
      const now = new Date();

      if (startDate <= now) {
        alert("Start time must be in the future");
        return;
      }

      if (endDate <= startDate) {
        alert("End time must be after start time");
        return;
      }

      // Convert to ISO format for API
      const startISO = startDate.toISOString().slice(0, 19);
      const endISO = endDate.toISOString().slice(0, 19);

      const schedule = {
        name: name,
        start_time: startISO,
        end_time: endISO,
        description: description || null
      };

      const response = await fetch("/schedule/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });

      if (response.ok) {
        const result = await response.json();
        alert(`Schedule "${name}" created successfully!`);
        
        // Clear form
        document.getElementById("scheduleName").value = "";
        document.getElementById("scheduleDescription").value = "";
        
        // Set new default times (current end time becomes new start time)
        const newStartTime = endDate;
        const newEndTime = new Date(newStartTime.getTime() + 2 * 60 * 60000); // 2 hours later
        document.getElementById("startDateTime").value = this.formatDateTimeLocal(newStartTime);
        document.getElementById("endDateTime").value = this.formatDateTimeLocal(newEndTime);
        
        // Refresh list
        this.loadSchedules();
        this.loadScheduleStatus();
      } else {
        const error = await response.json();
        alert(`Failed to create schedule: ${error.detail}`);
      }
    } catch (error) {
      console.error("Error creating schedule:", error);
      alert("Error creating schedule");
    }
  }

  async loadSchedules() {
    try {
      const response = await fetch("/schedule/list");
      if (response.ok) {
        const data = await response.json();
        this.displaySchedules(data.schedules);
      } else {
        console.error("Failed to load schedules");
      }
    } catch (error) {
      console.error("Error loading schedules:", error);
    }
  }

  displaySchedules(schedules) {
    const container = document.getElementById("schedulesList");
    
    if (!schedules || schedules.length === 0) {
      container.innerHTML = '<p class="no-schedules">No scheduled captures</p>';
      return;
    }

    // Sort schedules by start time
    schedules.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

    let html = '';
    schedules.forEach(schedule => {
      const statusClass = `status-${schedule.status}`;
      const startTime = this.formatDateTimeDisplay(schedule.start_time);
      const endTime = this.formatDateTimeDisplay(schedule.end_time);
      
      // Calculate duration
      const duration = this.calculateDuration(schedule.start_time, schedule.end_time);
      
      html += `
        <div class="schedule-item ${statusClass}" data-schedule-id="${schedule.id}">
          <div class="schedule-header">
            <h5 class="schedule-name">${this.escapeHtml(schedule.name)}</h5>
            <span class="schedule-status">${schedule.status.toUpperCase()}</span>
          </div>
          <div class="schedule-details">
            <div class="schedule-time">
              <strong>Start:</strong> ${startTime}
            </div>
            <div class="schedule-time">
              <strong>End:</strong> ${endTime}
            </div>
            <div class="schedule-duration">
              <strong>Duration:</strong> ${duration}
            </div>
            ${schedule.description ? `<div class="schedule-description">${this.escapeHtml(schedule.description)}</div>` : ''}
            <div class="schedule-info">
              <span>Frames: ${schedule.frames_captured || 0}</span>
              ${schedule.started_at ? `<span>Started: ${this.formatDateTimeDisplay(schedule.started_at)}</span>` : ''}
              ${schedule.completed_at ? `<span>Completed: ${this.formatDateTimeDisplay(schedule.completed_at)}</span>` : ''}
            </div>
          </div>
          <div class="schedule-actions">
            ${schedule.status === 'pending' || schedule.status === 'active' ? 
              `<button class="btn btn-danger btn-small" onclick="schedulerUI.cancelSchedule(${schedule.id}, '${this.escapeHtml(schedule.name).replace(/'/g, "\\'")}')">Cancel</button>` : 
              ''}
          </div>
        </div>
      `;
    });
    
    container.innerHTML = html;
  }

  calculateDuration(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    const durationMs = end - start;
    
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    } else {
      return `${minutes}m`;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async cancelSchedule(scheduleId, scheduleName) {
    if (!confirm(`Are you sure you want to cancel the scheduled capture "${scheduleName}"?`)) {
      return;
    }

    try {
      const response = await fetch(`/schedule/${scheduleId}`, {
        method: "DELETE"
      });

      if (response.ok) {
        const result = await response.json();
        alert(result.message);
        this.loadSchedules();
        this.loadScheduleStatus();
      } else {
        const error = await response.json();
        alert(`Failed to cancel schedule: ${error.detail}`);
      }
    } catch (error) {
      console.error("Error canceling schedule:", error);
      alert("Error canceling schedule");
    }
  }

  async loadScheduleStatus() {
    try {
      const response = await fetch("/schedule/status");
      if (response.ok) {
        const status = await response.json();
        this.updateScheduleStatus(status);
      }
    } catch (error) {
      console.error("Error loading schedule status:", error);
    }
  }

  updateScheduleStatus(status) {
    const activeElement = document.getElementById("activeSchedule");
    const nextElement = document.getElementById("nextSchedule");

    if (status.active_schedule) {
      const active = status.active_schedule;
      const endTime = this.formatDateTimeDisplay(active.end_time);
      const timeRemaining = this.calculateTimeRemaining(active.end_time);
      activeElement.innerHTML = `
        <strong>${this.escapeHtml(active.name)}</strong><br>
        <small>Ends: ${endTime} (${timeRemaining})</small><br>
        <small>Frames: ${active.frames_captured || 0}</small>
      `;
      activeElement.className = "active-schedule";
    } else {
      activeElement.innerHTML = "None";
      activeElement.className = "";
    }

    if (status.next_schedule) {
      const next = status.next_schedule;
      const startTime = this.formatDateTimeDisplay(next.start_time);
      const timeUntilStart = this.calculateTimeUntilStart(next.start_time);
      nextElement.innerHTML = `
        <strong>${this.escapeHtml(next.name)}</strong><br>
        <small>Starts: ${startTime} (${timeUntilStart})</small>
      `;
      nextElement.className = "next-schedule";
    } else {
      nextElement.innerHTML = "None";
      nextElement.className = "";
    }
  }

  calculateTimeRemaining(endTime) {
    const now = new Date();
    const end = new Date(endTime);
    const diffMs = end - now;
    
    if (diffMs <= 0) {
      return "ending soon";
    }
    
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `${hours}h ${minutes}m remaining`;
    } else if (minutes > 0) {
      return `${minutes}m remaining`;
    } else {
      return "< 1m remaining";
    }
  }

  calculateTimeUntilStart(startTime) {
    const now = new Date();
    const start = new Date(startTime);
    const diffMs = start - now;
    
    if (diffMs <= 0) {
      return "starting soon";
    }
    
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) {
      return `in ${days}d ${hours}h`;
    } else if (hours > 0) {
      return `in ${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `in ${minutes}m`;
    } else {
      return "in < 1m";
    }
  }

  startScheduleRefresh() {
    // Refresh schedules and status every 30 seconds
    this.scheduleRefreshInterval = setInterval(() => {
      this.loadSchedules();
      this.loadScheduleStatus();
    }, 30000);
  }

  stopScheduleRefresh() {
    if (this.scheduleRefreshInterval) {
      clearInterval(this.scheduleRefreshInterval);
      this.scheduleRefreshInterval = null;
    }
  }

  // Method to create a quick schedule for common astronomical events
  createQuickSchedule(name, hoursFromNow, durationHours, description = "") {
    const now = new Date();
    const startTime = new Date(now.getTime() + hoursFromNow * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + durationHours * 60 * 60 * 1000);
    
    document.getElementById("scheduleName").value = name;
    document.getElementById("scheduleDescription").value = description;
    document.getElementById("startDateTime").value = this.formatDateTimeLocal(startTime);
    document.getElementById("endDateTime").value = this.formatDateTimeLocal(endTime);
  }

  // Utility method to add common presets (could be called from UI buttons)
  addCommonPresets() {
    // This could be extended to add preset buttons for common scenarios:
    // - Tonight (sunset to sunrise)
    // - All night (8 PM to 6 AM)
    // - Transit window (specific object transit times)
    // - etc.
  }
}