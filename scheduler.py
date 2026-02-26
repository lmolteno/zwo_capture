#!/usr/bin/env python3

import threading
import sqlite3
import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING
from fastapi import HTTPException

from models import ScheduledCapture, ScheduleStatus, CameraSettings

if TYPE_CHECKING:
    from camera_manager import CameraManager


class CaptureScheduler:
    def __init__(self, camera_manager: 'CameraManager'):
        self.camera_manager = camera_manager
        self.scheduler_thread = None
        self.scheduler_stop_event = threading.Event()
        self.db_path = "/home/linus/zwo/camera_schedules.db"
        
        # Initialize database
        self.init_database()

    def init_database(self):
        """Initialize SQLite database for scheduling"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS scheduled_captures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    description TEXT,
                    settings TEXT,  -- JSON serialized camera settings
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    completed_at TEXT,
                    frames_captured INTEGER DEFAULT 0,
                    recording_directory TEXT
                )
            ''')
            
            # Create index for efficient time-based queries
            cursor.execute('''
                CREATE INDEX IF NOT EXISTS idx_schedule_times 
                ON scheduled_captures(start_time, end_time, status)
            ''')
            
            conn.commit()
            conn.close()
            print("Schedule database initialized successfully")
            
        except Exception as e:
            print(f"Failed to initialize schedule database: {e}")

    def start(self):
        """Start background scheduler thread"""
        if self.scheduler_thread and self.scheduler_thread.is_alive():
            return
            
        self.scheduler_stop_event.clear()
        self.scheduler_thread = threading.Thread(target=self._scheduler_loop)
        self.scheduler_thread.daemon = True
        self.scheduler_thread.start()
        print("Scheduler started")

    def stop(self):
        """Stop background scheduler thread"""
        if self.scheduler_thread:
            self.scheduler_stop_event.set()
            self.scheduler_thread.join(timeout=5.0)
            print("Scheduler stopped")

    def _scheduler_loop(self):
        """Main scheduler loop - runs every 30 seconds"""
        while not self.scheduler_stop_event.is_set():
            try:
                current_time = datetime.now()
                
                # Check for schedules that should start
                self._check_schedules_to_start(current_time)
                
                # Check for active schedules that should end
                self._check_schedules_to_end(current_time)
                
                # Sleep for 30 seconds before next check
                self.scheduler_stop_event.wait(30)
                
            except Exception as e:
                print(f"Error in scheduler loop: {e}")
                self.scheduler_stop_event.wait(30)

    def _check_schedules_to_start(self, current_time: datetime):
        """Check for pending schedules that should start now"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Find pending schedules that should start (within 1 minute tolerance)
            current_str = current_time.strftime("%Y-%m-%dT%H:%M:%S")
            future_str = (current_time + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S")
            
            cursor.execute('''
                SELECT id, name, start_time, settings FROM scheduled_captures
                WHERE status = 'pending' 
                AND start_time >= ? AND start_time <= ?
                ORDER BY start_time
            ''', (current_str, future_str))
            
            schedules_to_start = cursor.fetchall()
            conn.close()
            
            for schedule_id, name, start_time, settings_json in schedules_to_start:
                self._start_scheduled_capture(schedule_id, name, start_time, settings_json)
                
        except Exception as e:
            print(f"Error checking schedules to start: {e}")

    def _check_schedules_to_end(self, current_time: datetime):
        """Check for active schedules that should end now"""
        try:
            if not self.camera_manager.active_schedule_id:
                return
                
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Check if current active schedule should end
            cursor.execute('''
                SELECT id, name, end_time FROM scheduled_captures
                WHERE id = ? AND status = 'active'
            ''', (self.camera_manager.active_schedule_id,))
            
            result = cursor.fetchone()
            if result:
                schedule_id, name, end_time = result
                end_dt = datetime.fromisoformat(end_time)
                
                if current_time >= end_dt:
                    self._end_scheduled_capture(schedule_id, name)
            
            conn.close()
            
        except Exception as e:
            print(f"Error checking schedules to end: {e}")

    def _start_scheduled_capture(self, schedule_id: int, name: str, start_time: str, settings_json: str):
        """Start a scheduled capture session"""
        try:
            # Check for conflicts with manual recording
            if self.camera_manager.is_recording and not self.camera_manager.active_schedule_id:
                print(f"Cannot start scheduled capture '{name}' - manual recording is active")
                self._update_schedule_status(schedule_id, ScheduleStatus.FAILED, 
                                           "Conflict with manual recording")
                return
            
            # Stop any current manual recording
            if self.camera_manager.is_recording and not self.camera_manager.active_schedule_id:
                self.camera_manager.stop_recording()
                
            # Apply saved settings if provided
            if settings_json:
                try:
                    settings_dict = json.loads(settings_json)
                    settings = CameraSettings(**settings_dict)
                    self.camera_manager.update_settings(settings)
                except Exception as e:
                    print(f"Warning: Failed to apply saved settings for schedule '{name}': {e}")
            
            # Start capture if not already running
            if not self.camera_manager.is_capturing:
                self.camera_manager.start_capture()
            
            # Start recording with custom directory name
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).strip()
            self.camera_manager.recording_directory = Path("captures") / f"{timestamp}_{safe_name}"
            self.camera_manager.recording_directory.mkdir(parents=True, exist_ok=True)
            
            self.camera_manager.is_recording = True
            self.camera_manager.frames_recorded = 0
            self.camera_manager.last_recording_frame_time = 0.0
            self.camera_manager.active_schedule_id = schedule_id
            
            # Update database
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE scheduled_captures 
                SET status = 'active', started_at = ?, recording_directory = ?
                WHERE id = ?
            ''', (datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), 
                  str(self.camera_manager.recording_directory), schedule_id))
            conn.commit()
            conn.close()
            
            print(f"Started scheduled capture '{name}' (ID: {schedule_id}) - Recording to: {self.camera_manager.recording_directory}")
            
        except Exception as e:
            print(f"Error starting scheduled capture '{name}': {e}")
            self._update_schedule_status(schedule_id, ScheduleStatus.FAILED, str(e))

    def _end_scheduled_capture(self, schedule_id: int, name: str):
        """End a scheduled capture session"""
        try:
            frames_count = self.camera_manager.frames_recorded
            directory = self.camera_manager.recording_directory
            
            # Stop recording
            self.camera_manager.is_recording = False
            self.camera_manager.recording_directory = None
            self.camera_manager.frames_recorded = 0
            self.camera_manager.active_schedule_id = None
            
            # Update database
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE scheduled_captures 
                SET status = 'completed', completed_at = ?, frames_captured = ?
                WHERE id = ?
            ''', (datetime.now().strftime("%Y-%m-%dT%H:%M:%S"), frames_count, schedule_id))
            conn.commit()
            conn.close()
            
            print(f"Completed scheduled capture '{name}' (ID: {schedule_id}) - Saved {frames_count} frames to: {directory}")
            
        except Exception as e:
            print(f"Error ending scheduled capture '{name}': {e}")

    def _update_schedule_status(self, schedule_id: int, status: ScheduleStatus, error_msg: str = None):
        """Update schedule status in database"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            if status == ScheduleStatus.FAILED and error_msg:
                cursor.execute('''
                    UPDATE scheduled_captures 
                    SET status = ?, description = COALESCE(description, '') || ' [ERROR: ' || ? || ']'
                    WHERE id = ?
                ''', (status.value, error_msg, schedule_id))
            else:
                cursor.execute('''
                    UPDATE scheduled_captures SET status = ? WHERE id = ?
                ''', (status.value, schedule_id))
                
            conn.commit()
            conn.close()
            
        except Exception as e:
            print(f"Error updating schedule status: {e}")

    def recover_schedules(self):
        """Recover schedules after restart - check for any that should be active now"""
        try:
            current_time = datetime.now()
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Find schedules that were active or should be active now
            cursor.execute('''
                SELECT id, name, start_time, end_time, settings FROM scheduled_captures
                WHERE status = 'active' 
                OR (status = 'pending' AND start_time <= ? AND end_time > ?)
                ORDER BY start_time
            ''', (current_time.strftime("%Y-%m-%dT%H:%M:%S"), 
                  current_time.strftime("%Y-%m-%dT%H:%M:%S")))
            
            schedules = cursor.fetchall()
            conn.close()
            
            if schedules:
                # Take the first (earliest) schedule that should be active
                schedule_id, name, start_time, end_time, settings_json = schedules[0]
                print(f"Recovering schedule '{name}' (ID: {schedule_id})")
                self._start_scheduled_capture(schedule_id, name, start_time, settings_json)
                
        except Exception as e:
            print(f"Error recovering schedules: {e}")

    def create_schedule(self, schedule: ScheduledCapture) -> int:
        """Create a new scheduled capture"""
        try:
            # Validate times
            start_dt = datetime.fromisoformat(schedule.start_time)
            end_dt = datetime.fromisoformat(schedule.end_time)
            current_dt = datetime.now()
            
            if start_dt <= current_dt:
                raise ValueError("Start time must be in the future")
            if end_dt <= start_dt:
                raise ValueError("End time must be after start time")
            
            # Check for conflicts
            if self._has_schedule_conflict(start_dt, end_dt):
                raise ValueError("Schedule conflicts with existing schedule")
            
            # Save current settings
            settings_json = json.dumps({
                "exposure": self.camera_manager.current_settings.exposure,
                "gain": self.camera_manager.current_settings.gain,
                "binning": self.camera_manager.current_settings.binning,
                "format": self.camera_manager.current_settings.format,
                "bandwidth": self.camera_manager.current_settings.bandwidth,
                "roi_x": self.camera_manager.current_settings.roi_x,
                "roi_y": self.camera_manager.current_settings.roi_y,
                "roi_width": self.camera_manager.current_settings.roi_width,
                "roi_height": self.camera_manager.current_settings.roi_height,
                "max_recording_fps": self.camera_manager.current_settings.max_recording_fps
            })
            
            # Insert into database
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO scheduled_captures 
                (name, start_time, end_time, description, settings, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (schedule.name, schedule.start_time, schedule.end_time,
                  schedule.description, settings_json, 
                  datetime.now().strftime("%Y-%m-%dT%H:%M:%S")))
            
            schedule_id = cursor.lastrowid
            conn.commit()
            conn.close()
            
            print(f"Created schedule '{schedule.name}' (ID: {schedule_id}) from {schedule.start_time} to {schedule.end_time}")
            return schedule_id
            
        except Exception as e:
            print(f"Error creating schedule: {e}")
            raise HTTPException(status_code=400, detail=str(e))

    def _has_schedule_conflict(self, start_dt: datetime, end_dt: datetime) -> bool:
        """Check if proposed schedule conflicts with existing ones"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Check for overlapping schedules (excluding cancelled/failed ones)
            cursor.execute('''
                SELECT COUNT(*) FROM scheduled_captures
                WHERE status IN ('pending', 'active')
                AND (
                    (start_time < ? AND end_time > ?) OR  -- Existing schedule contains new start
                    (start_time < ? AND end_time > ?) OR  -- Existing schedule contains new end
                    (start_time >= ? AND end_time <= ?)   -- New schedule contains existing schedule
                )
            ''', (start_dt.strftime("%Y-%m-%dT%H:%M:%S"), start_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                  end_dt.strftime("%Y-%m-%dT%H:%M:%S"), end_dt.strftime("%Y-%m-%dT%H:%M:%S"),
                  start_dt.strftime("%Y-%m-%dT%H:%M:%S"), end_dt.strftime("%Y-%m-%dT%H:%M:%S")))
            
            count = cursor.fetchone()[0]
            conn.close()
            
            return count > 0
            
        except Exception as e:
            print(f"Error checking schedule conflicts: {e}")
            return False

    def cancel_schedule(self, schedule_id: int):
        """Cancel a scheduled capture"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            
            # Check if schedule exists and can be cancelled
            cursor.execute('SELECT status, name FROM scheduled_captures WHERE id = ?', (schedule_id,))
            result = cursor.fetchone()
            
            if not result:
                conn.close()
                raise HTTPException(status_code=404, detail="Schedule not found")
            
            status, name = result
            
            if status == 'completed':
                conn.close()
                raise HTTPException(status_code=400, detail="Cannot cancel completed schedule")
            
            if status == 'active':
                # If it's currently active, stop the recording
                if self.camera_manager.active_schedule_id == schedule_id:
                    self.camera_manager.is_recording = False
                    self.camera_manager.active_schedule_id = None
                    self.camera_manager.recording_directory = None
                    self.camera_manager.frames_recorded = 0
            
            # Update status to cancelled
            cursor.execute('''
                UPDATE scheduled_captures SET status = 'cancelled' WHERE id = ?
            ''', (schedule_id,))
            conn.commit()
            conn.close()
            
            print(f"Cancelled schedule '{name}' (ID: {schedule_id})")
            return {"status": "cancelled", "message": f"Schedule '{name}' cancelled successfully"}
            
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    def get_schedules(self):
        """Get all schedules"""
        try:
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                SELECT id, name, start_time, end_time, status, description, 
                       created_at, started_at, completed_at, frames_captured, settings
                FROM scheduled_captures
                ORDER BY start_time
            ''')
            
            schedules = []
            for row in cursor.fetchall():
                schedule_dict = {
                    "id": row[0],
                    "name": row[1],
                    "start_time": row[2],
                    "end_time": row[3],
                    "status": row[4],
                    "description": row[5],
                    "created_at": row[6],
                    "started_at": row[7],
                    "completed_at": row[8],
                    "frames_captured": row[9] or 0,
                    "settings": json.loads(row[10]) if row[10] else None
                }
                schedules.append(schedule_dict)
            
            conn.close()
            return {"schedules": schedules}
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    def get_status(self):
        """Get current schedule status"""
        try:
            current_time = datetime.now()
            
            # Get active schedule if any
            active_schedule = None
            if self.camera_manager.active_schedule_id:
                conn = sqlite3.connect(self.db_path)
                cursor = conn.cursor()
                cursor.execute('''
                    SELECT id, name, start_time, end_time, frames_captured 
                    FROM scheduled_captures 
                    WHERE id = ? AND status = 'active'
                ''', (self.camera_manager.active_schedule_id,))
                
                result = cursor.fetchone()
                if result:
                    active_schedule = {
                        "id": result[0],
                        "name": result[1],
                        "start_time": result[2],
                        "end_time": result[3],
                        "frames_captured": result[4] or self.camera_manager.frames_recorded
                    }
                conn.close()
            
            # Get next upcoming schedule
            next_schedule = None
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute('''
                SELECT id, name, start_time, end_time 
                FROM scheduled_captures 
                WHERE status = 'pending' AND start_time > ?
                ORDER BY start_time 
                LIMIT 1
            ''', (current_time.strftime("%Y-%m-%dT%H:%M:%S"),))
            
            result = cursor.fetchone()
            if result:
                next_schedule = {
                    "id": result[0],
                    "name": result[1],
                    "start_time": result[2],
                    "end_time": result[3]
                }
            conn.close()
            
            return {
                "current_time": current_time.strftime("%Y-%m-%dT%H:%M:%S"),
                "active_schedule": active_schedule,
                "next_schedule": next_schedule,
                "scheduler_running": self.scheduler_thread and self.scheduler_thread.is_alive()
            }
            
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
