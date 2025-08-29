#!/usr/bin/env python3

import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime
import sqlite3
import json

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, Response, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import time

from models import CameraSettings, ScheduledCapture, HistogramResponse
from camera_manager import CameraManager
from scheduler import CaptureScheduler


# Global instances
camera_manager = None
scheduler = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global camera_manager, scheduler
    try:
        camera_manager = CameraManager()
        scheduler = CaptureScheduler(camera_manager)
        
        # Start scheduler and recover any active schedules
        scheduler.start()
        scheduler.recover_schedules()
        
        print("Camera manager and scheduler initialized successfully")
    except Exception as e:
        print(f"Failed to initialize camera system: {e}")
        sys.exit(1)

    yield

    # Shutdown
    if scheduler:
        scheduler.stop()
    if camera_manager:
        camera_manager.cleanup()
        print("Camera system cleaned up")


app = FastAPI(
    title="ZWO ASI Camera API",
    description="FastAPI interface for ZWO ASI camera control and image capture",
    version="1.0.0",
    lifespan=lifespan
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def read_index():
    """Serve the main web interface"""
    return FileResponse('static/index.html')


# Camera Control Endpoints
@app.post("/camera/start")
async def start_capture():
    """Start continuous frame capture"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    try:
        camera_manager.start_capture()
        return {"status": "started", "message": "Frame capture started"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/camera/stop")
async def stop_capture():
    """Stop continuous frame capture"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    try:
        camera_manager.stop_capture()
        return {"status": "stopped", "message": "Frame capture stopped"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/camera/histogram", response_model=HistogramResponse)
async def get_histogram():
    """Get histogram of the latest captured frame"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    if not camera_manager.is_capturing:
        raise HTTPException(status_code=400, detail="Camera not capturing. Start capture first.")

    histogram = camera_manager.get_histogram()
    if not histogram:
        raise HTTPException(status_code=404, detail="No frame data available")

    return histogram


@app.get("/camera/settings", response_model=CameraSettings)
async def get_settings():
    """Get current camera settings"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    return camera_manager.get_settings()


@app.post("/camera/settings")
async def update_settings(settings: CameraSettings):
    """Update camera settings"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    try:
        # Check if we need to restart recording due to significant settings changes
        old_settings = camera_manager.current_settings
        needs_recording_restart = camera_manager._needs_recording_restart(old_settings, settings)

        # If recording and significant changes, stop recording temporarily
        was_recording = camera_manager.is_recording
        recording_dir = camera_manager.recording_directory

        if was_recording and needs_recording_restart:
            print("Settings changed - temporarily stopping recording to reconfigure")
            camera_manager.stop_recording()

        # Update settings
        camera_manager.update_settings(settings)

        # Restart recording if it was active and we stopped it
        if was_recording and needs_recording_restart:
            # Restore the same recording directory
            camera_manager.recording_directory = recording_dir
            camera_manager.is_recording = True
            camera_manager.frames_recorded = len(list(recording_dir.glob("*"))) if recording_dir.exists() else 0
            print("Resumed recording after settings change")

        return {"status": "updated", "settings": settings}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/camera/status")
async def get_status():
    """Get camera status information"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    return {
        "is_capturing": camera_manager.is_capturing,
        "is_connected": camera_manager.is_connected,
        "is_recording": camera_manager.is_recording,
        "frames_recorded": camera_manager.frames_recorded,
        "recording_directory": str(camera_manager.recording_directory) if camera_manager.recording_directory else None,
        "camera_model": camera_manager.camera_info.get('Name', 'Unknown') if camera_manager.camera_info else 'Unknown',
        "current_fps": camera_manager.get_current_fps() if camera_manager.is_capturing else 0.0,
        "current_settings": camera_manager.current_settings
    }


@app.get("/camera/info")
async def get_camera_info():
    """Get camera hardware information"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")
    if not camera_manager.camera_info:
        raise HTTPException(status_code=500, detail="Camera info not available")
    return {
        "name": camera_manager.camera_info.get('Name', 'Unknown'),
        "width": camera_manager.camera_info.get('MaxWidth', 0),
        "height": camera_manager.camera_info.get('MaxHeight', 0),
        "pixel_size": camera_manager.camera_info.get('PixelSize', 0),
        "is_color_cam": camera_manager.camera_info.get('IsColorCam', False)
    }


@app.get("/camera/image")
async def get_latest_image():
    """Get the latest captured frame as a JPEG image"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    if not camera_manager.is_capturing:
        raise HTTPException(status_code=400, detail="Camera not capturing. Start capture first.")

    jpeg_data = camera_manager.get_latest_image_jpeg()
    if not jpeg_data:
        raise HTTPException(status_code=404, detail="No frame data available")

    return Response(content=jpeg_data, media_type="image/jpeg")


# Recording Endpoints
@app.post("/camera/start_recording")
async def start_recording():
    """Start recording frames to disk"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    if not camera_manager.is_capturing:
        raise HTTPException(status_code=400, detail="Camera not capturing. Start capture first.")

    try:
        camera_manager.start_recording()
        return {"status": "started", "message": "Recording started"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/camera/stop_recording")
async def stop_recording():
    """Stop recording frames to disk"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    try:
        camera_manager.stop_recording()
        return {"status": "stopped", "message": "Recording stopped"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/camera/stream")
async def get_mjpeg_stream():
    """Get continuous MJPEG stream of captured frames"""
    if not camera_manager:
        raise HTTPException(status_code=500, detail="Camera not initialized")

    if not camera_manager.is_capturing:
        raise HTTPException(status_code=400, detail="Camera not capturing. Start capture first.")

    def generate_mjpeg():
        """Generator function for MJPEG stream"""
        boundary = "frame"
        last_frame_time = 0
        min_frame_interval = 1.0 / 30.0  # Limit to ~30 FPS for streaming

        while True:
            current_time = time.time()

            # Rate limiting - don't send frames faster than 30 FPS
            if current_time - last_frame_time < min_frame_interval:
                time.sleep(0.01)  # Small sleep to prevent busy waiting
                continue

            # Get latest JPEG frame
            jpeg_data = camera_manager.get_latest_image_jpeg()

            if jpeg_data:
                last_frame_time = current_time

                # MJPEG format with multipart boundary
                yield (b'--' + boundary.encode() + b'\r\n'
                       b'Content-Type: image/jpeg\r\n'
                       b'Content-Length: ' + str(len(jpeg_data)).encode() + b'\r\n'
                       b'\r\n' + jpeg_data + b'\r\n')
            else:
                # If no frame available, wait a bit
                time.sleep(0.05)

            # Check if camera is still capturing
            if not camera_manager.is_capturing:
                break

    return StreamingResponse(
        generate_mjpeg(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# Schedule Management Endpoints
@app.post("/schedule/create")
async def create_schedule(schedule: ScheduledCapture):
    """Create a new scheduled capture"""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")
    
    try:
        schedule_id = scheduler.create_schedule(schedule)
        return {"status": "created", "schedule_id": schedule_id, "message": f"Schedule '{schedule.name}' created successfully"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/schedule/list")
async def list_schedules():
    """List all scheduled captures"""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")
    
    return scheduler.get_schedules()


@app.delete("/schedule/{schedule_id}")
async def cancel_schedule(schedule_id: int):
    """Cancel a scheduled capture"""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")
    
    return scheduler.cancel_schedule(schedule_id)


@app.get("/schedule/status")
async def get_schedule_status():
    """Get current schedule status"""
    if not scheduler:
        raise HTTPException(status_code=500, detail="Scheduler not initialized")
    
    return scheduler.get_status()


if __name__ == "__main__":
    # Check for ZWO_ASI_LIB environment variable
    if not os.getenv('ZWO_ASI_LIB'):
        print("Error: ZWO_ASI_LIB environment variable not set")
        print("Example: export ZWO_ASI_LIB=/path/to/libASICamera2.so")
        sys.exit(1)

    uvicorn.run(app, host="0.0.0.0", port=8000)