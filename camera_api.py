#!/usr/bin/env python3

import os
import sys
import time
import threading
from typing import Optional, Dict, Any, List
from pathlib import Path
import asyncio
from contextlib import asynccontextmanager

import zwoasi as asi
import numpy as np
from PIL import Image
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import io


class CameraSettings(BaseModel):
    exposure: int = 10000  # microseconds
    gain: int = 100
    binning: int = 1
    format: str = "raw8"  # raw8, raw16, rgb24
    bandwidth: str = "max"  # min, max
    
class HistogramResponse(BaseModel):
    r_histogram: Optional[List[int]] = None
    g_histogram: Optional[List[int]] = None 
    b_histogram: Optional[List[int]] = None
    mono_histogram: Optional[List[int]] = None
    width: int
    height: int
    format: str


class CameraManager:
    def __init__(self):
        self.camera = None
        self.camera_info = None
        self.is_capturing = False
        self.current_settings = CameraSettings()
        self.latest_frame_buffer = None
        self.frame_lock = threading.Lock()
        self.capture_thread = None
        self.stop_capture_event = threading.Event()
        
        # Initialize SDK
        env_filename = os.getenv('ZWO_ASI_LIB')
        if not env_filename:
            raise RuntimeError("ZWO_ASI_LIB environment variable not set")
        
        try:
            asi.init(env_filename)
        except Exception as e:
            raise RuntimeError(f"Failed to initialize ASI SDK: {e}")
        
        # Find and connect to camera
        num_cameras = asi.get_num_cameras()
        if num_cameras == 0:
            raise RuntimeError("No cameras found")
        
        cameras_found = asi.list_cameras()
        print(f"Found cameras: {cameras_found}")
        
        # Use first camera
        self.camera = asi.Camera(0)
        self.camera_info = self.camera.get_camera_property()
        print(f"Connected to: {cameras_found[0]}")
        
        # Stop any ongoing capture
        try:
            self.camera.stop_video_capture()
            self.camera.stop_exposure()
        except:
            pass
            
        # Apply initial configuration
        self._configure_camera()
    
    def _configure_camera(self):
        """Configure camera with current settings"""
        if not self.camera:
            return
            
        # Basic configuration
        self.camera.disable_dark_subtract()
        
        # Set USB bandwidth
        bandwidth_controls = self.camera.get_controls()['BandWidth']
        if self.current_settings.bandwidth == "max":
            bandwidth_value = bandwidth_controls['MaxValue']
        else:
            bandwidth_value = bandwidth_controls['MinValue']
        self.camera.set_control_value(asi.ASI_BANDWIDTHOVERLOAD, bandwidth_value)
        
        # Set exposure and gain
        self.camera.set_control_value(asi.ASI_GAIN, self.current_settings.gain)
        self.camera.set_control_value(asi.ASI_EXPOSURE, self.current_settings.exposure)
        
        # Set other controls for speed
        self.camera.set_control_value(asi.ASI_GAMMA, 50)
        self.camera.set_control_value(asi.ASI_BRIGHTNESS, 50)
        self.camera.set_control_value(asi.ASI_FLIP, 0)
        
        # Set image format
        format_map = {
            'raw8': asi.ASI_IMG_RAW8,
            'raw16': asi.ASI_IMG_RAW16,
            'rgb24': asi.ASI_IMG_RGB24
        }
        
        # Check if RGB24 is supported
        if self.current_settings.format == 'rgb24' and not self.camera_info['IsColorCam']:
            print('Warning: RGB24 format requested but camera is mono. Using RAW8 instead.')
            self.current_settings.format = 'raw8'
        
        self.camera.set_image_type(format_map[self.current_settings.format])
        
        # Set binning
        if self.current_settings.binning > 1:
            try:
                max_width = self.camera_info['MaxWidth']
                max_height = self.camera_info['MaxHeight']
                binned_width = max_width // self.current_settings.binning
                binned_height = max_height // self.current_settings.binning
                
                # Ensure width is multiple of 8, height multiple of 2
                binned_width = (binned_width // 8) * 8
                binned_height = (binned_height // 2) * 2
                
                self.camera.set_roi_format(binned_width, binned_height, 
                                         bins=self.current_settings.binning, 
                                         image_type=format_map[self.current_settings.format])
                print(f'Set binning to {self.current_settings.binning}x{self.current_settings.binning}')
            except Exception as e:
                print(f'Warning: Failed to set binning: {e}')
        
        # Set timeout
        exposure_ms = self.camera.get_control_value(asi.ASI_EXPOSURE)[0] / 1000
        timeout = max(exposure_ms * 1.5 + 100, 200)
        self.camera.default_timeout = timeout
        
        # Pre-allocate buffer for optimal performance
        self._setup_buffer()
    
    def _setup_buffer(self):
        """Setup pre-allocated buffer for frame capture"""
        if not self.camera:
            return
            
        roi_format = self.camera.get_roi_format()
        width, height, bins, img_type = roi_format
        
        buffer_size = width * height
        if img_type == asi.ASI_IMG_RGB24:
            buffer_size *= 3
        elif img_type == asi.ASI_IMG_RAW16:
            buffer_size *= 2
            
        self.reusable_buffer = bytearray(buffer_size)
        self.frame_width = width
        self.frame_height = height
        self.frame_type = img_type
    
    def start_capture(self):
        """Start continuous frame capture"""
        if self.is_capturing:
            return
            
        if not self.camera:
            raise RuntimeError("Camera not initialized")
        
        self.camera.start_video_capture()
        self.is_capturing = True
        self.stop_capture_event.clear()
        
        # Start capture thread
        print("Starting capture thread")
        self.capture_thread = threading.Thread(target=self._capture_loop)
        self.capture_thread.daemon = True
        self.capture_thread.start()
    
    def stop_capture(self):
        """Stop continuous frame capture"""
        if not self.is_capturing:
            return
            
        self.is_capturing = False
        self.stop_capture_event.set()
        
        if self.capture_thread:
            self.capture_thread.join(timeout=2.0)
            
        if self.camera:
            self.camera.stop_video_capture()
    
    def _capture_loop(self):
        """Continuous capture loop running in background thread"""
        while not self.stop_capture_event.is_set():
            try:
                # Use pre-allocated buffer for optimal performance
                frame_data = self.camera.capture_video_frame(buffer_=self.reusable_buffer)
                
                # Store latest frame (thread-safe)
                with self.frame_lock:
                    self.latest_frame_buffer = bytes(frame_data)  # Make a copy
                    
            except Exception as e:
                if not self.stop_capture_event.is_set():
                    print(f"Capture error: {e}")
                if str(e) != "Timeout":
                    break
    
    def get_histogram(self) -> Optional[HistogramResponse]:
        """Get histogram of latest captured frame"""
        with self.frame_lock:
            if not self.latest_frame_buffer:
                return None
            
            frame_data = self.latest_frame_buffer
        
        try:
            # Convert frame data to PIL Image
            if self.frame_type == asi.ASI_IMG_RGB24:
                # RGB24 format
                img_array = np.frombuffer(frame_data, dtype=np.uint8)
                img_array = img_array.reshape((self.frame_height, self.frame_width, 3))
                img = Image.fromarray(img_array, 'RGB')
                
                # Calculate RGB histograms
                r, g, b = img.split()
                r_hist = r.histogram()
                g_hist = g.histogram()
                b_hist = b.histogram()
                
                return HistogramResponse(
                    r_histogram=r_hist,
                    g_histogram=g_hist,
                    b_histogram=b_hist,
                    width=self.frame_width,
                    height=self.frame_height,
                    format=self.current_settings.format
                )
                
            else:
                # RAW8/RAW16 format (mono)
                if self.frame_type == asi.ASI_IMG_RAW16:
                    img_array = np.frombuffer(frame_data, dtype=np.uint16)
                    # Convert to 8-bit for histogram
                    img_array = (img_array >> 8).astype(np.uint8)
                else:
                    img_array = np.frombuffer(frame_data, dtype=np.uint8)
                
                img_array = img_array.reshape((self.frame_height, self.frame_width))
                img = Image.fromarray(img_array, 'L')
                
                mono_hist = img.histogram()
                
                return HistogramResponse(
                    mono_histogram=mono_hist,
                    width=self.frame_width,
                    height=self.frame_height,
                    format=self.current_settings.format
                )
                
        except Exception as e:
            print(f"Histogram calculation error: {e}")
            return None
    
    def get_latest_image_jpeg(self) -> Optional[bytes]:
        """Get latest frame as JPEG bytes"""
        with self.frame_lock:
            if not self.latest_frame_buffer:
                return None
            
            frame_data = self.latest_frame_buffer
        
        try:
            # Convert frame data to PIL Image
            if self.frame_type == asi.ASI_IMG_RGB24:
                # RGB24 format
                img_array = np.frombuffer(frame_data, dtype=np.uint8)
                img_array = img_array.reshape((self.frame_height, self.frame_width, 3))
                img = Image.fromarray(img_array, 'RGB')
                
            else:
                # RAW8/RAW16 format (mono)
                if self.frame_type == asi.ASI_IMG_RAW16:
                    img_array = np.frombuffer(frame_data, dtype=np.uint16)
                    # Convert to 8-bit for JPEG
                    img_array = (img_array >> 8).astype(np.uint8)
                else:
                    img_array = np.frombuffer(frame_data, dtype=np.uint8)
                
                img_array = img_array.reshape((self.frame_height, self.frame_width))
                img = Image.fromarray(img_array, 'L')
            
            # Convert to JPEG
            jpeg_buffer = io.BytesIO()
            img.save(jpeg_buffer, format='JPEG', quality=85, optimize=True)
            return jpeg_buffer.getvalue()
            
        except Exception as e:
            print(f"JPEG conversion error: {e}")
            return None
    
    def update_settings(self, settings: CameraSettings):
        """Update camera settings"""
        was_capturing = self.is_capturing
        
        if was_capturing:
            self.stop_capture()
        
        self.current_settings = settings
        self._configure_camera()
        
        if was_capturing:
            self.start_capture()
    
    def get_settings(self) -> CameraSettings:
        """Get current camera settings"""
        return self.current_settings
    
    def cleanup(self):
        """Cleanup resources"""
        self.stop_capture()
        if self.camera:
            try:
                self.camera.stop_video_capture()
                self.camera.stop_exposure()
            except:
                pass


# Global camera manager instance
camera_manager: Optional[CameraManager] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    global camera_manager
    try:
        camera_manager = CameraManager()
        print("Camera manager initialized successfully")
    except Exception as e:
        print(f"Failed to initialize camera: {e}")
        sys.exit(1)
    
    yield
    
    # Shutdown
    if camera_manager:
        camera_manager.cleanup()
        print("Camera manager cleaned up")


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
    from fastapi.responses import FileResponse
    return FileResponse('static/index.html')


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
        camera_manager.update_settings(settings)
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
        "camera_model": camera_manager.camera_info.get('Name', 'Unknown') if camera_manager.camera_info else 'Unknown',
        "current_settings": camera_manager.current_settings
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


if __name__ == "__main__":
    # Check for ZWO_ASI_LIB environment variable
    if not os.getenv('ZWO_ASI_LIB'):
        print("Error: ZWO_ASI_LIB environment variable not set")
        print("Example: export ZWO_ASI_LIB=/path/to/libASICamera2.so")
        sys.exit(1)
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
