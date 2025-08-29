#!/usr/bin/env python3

from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from enum import Enum


class ScheduleStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active" 
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class CameraSettings(BaseModel):
    exposure: int = 10000  # microseconds
    gain: int = 100
    binning: int = 1
    format: str = "raw8"  # raw8, raw16, rgb24
    bandwidth: str = "max"  # min, max
    roi_x: float = 0.0  # ROI x position (0-1, normalized)
    roi_y: float = 0.0  # ROI y position (0-1, normalized)
    roi_width: float = 1.0  # ROI width (0-1, normalized)
    roi_height: float = 1.0  # ROI height (0-1, normalized)
    max_recording_fps: float = 30.0  # Maximum FPS for recording (0 = unlimited)


class ScheduledCapture(BaseModel):
    name: str
    start_time: str  # ISO format: "2024-01-15T20:30:00"
    end_time: str    # ISO format: "2024-01-15T23:30:00"
    description: Optional[str] = None


class ScheduleResponse(BaseModel):
    id: int
    name: str
    start_time: str
    end_time: str
    status: ScheduleStatus
    description: Optional[str]
    settings: Optional[Dict[str, Any]]
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    frames_captured: int = 0


class HistogramResponse(BaseModel):
    r_histogram: Optional[List[int]] = None
    g_histogram: Optional[List[int]] = None
    b_histogram: Optional[List[int]] = None
    mono_histogram: Optional[List[int]] = None
    width: int
    height: int
    format: str