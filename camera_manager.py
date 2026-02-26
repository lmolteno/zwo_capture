#!/usr/bin/env python3

import os
import time
import threading
from typing import Optional, Dict, Any
from pathlib import Path
from datetime import datetime
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import zwoasi as asi
import io

from models import CameraSettings, HistogramResponse


class CameraManager:
    def __init__(self):
        self.camera = None
        self.camera_info = None
        self.is_capturing = False
        self.is_connected = False
        self.current_settings = CameraSettings()
        self.latest_frame_buffer = None
        self.frame_lock = threading.Lock()
        self.capture_thread = None
        self.stop_capture_event = threading.Event()
        self.connection_check_thread = None
        self.connection_check_event = threading.Event()
        self.last_connection_check = 0

        # FPS tracking
        self.frame_timestamps = []
        self.current_fps = 0.0
        self.fps_lock = threading.Lock()

        # Recording state
        self.is_recording = False
        self.recording_directory = None
        self.recording_lock = threading.Lock()
        self.frames_recorded = 0
        self.last_recording_frame_time = 0.0  # Timestamp of last recorded frame
        
        # Scheduling state (will be managed by scheduler)
        self.active_schedule_id = None

        # Initialize SDK
        env_filename = os.getenv('ZWO_ASI_LIB')
        if not env_filename:
            raise RuntimeError("ZWO_ASI_LIB environment variable not set")

        try:
            asi.init(env_filename)
        except Exception as e:
            raise RuntimeError(f"Failed to initialize ASI SDK: {e}")

        # Try to connect to camera
        self.connect_camera()

        # Start connection monitoring
        self.start_connection_monitoring()

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
        # self.camera.set_control_value(asi.ASI_GAMMA, 50)
        # self.camera.set_control_value(asi.ASI_BRIGHTNESS, 50)
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

        # Calculate ROI dimensions
        max_width = self.camera_info['MaxWidth']
        max_height = self.camera_info['MaxHeight']

        # Apply ROI selection
        roi_start_x = int(self.current_settings.roi_x * max_width)
        roi_start_y = int(self.current_settings.roi_y * max_height)
        roi_width = int(self.current_settings.roi_width * max_width)
        roi_height = int(self.current_settings.roi_height * max_height)

        # Apply binning to ROI dimensions
        if self.current_settings.binning > 1:
            roi_width = roi_width // self.current_settings.binning
            roi_height = roi_height // self.current_settings.binning

            roi_start_x = roi_start_x // self.current_settings.binning
            roi_start_y = roi_start_y // self.current_settings.binning

        # Ensure width is multiple of 8, height multiple of 2 (camera requirements)
        roi_width = (roi_width // 8) * 8
        roi_height = (roi_height // 2) * 2

        # Minimum size constraints
        roi_width = max(roi_width, 64)  # Minimum 64px width
        roi_height = max(roi_height, 32)  # Minimum 32px height

        try:
            # First set the ROI size and binning
            self.camera.set_roi_format(roi_width, roi_height,
                                     bins=self.current_settings.binning,
                                     image_type=format_map[self.current_settings.format])

            # Then set the ROI start position
            self.camera.set_roi_start_position(roi_start_x, roi_start_y)

            if self.current_settings.binning > 1:
                print(f'Set ROI: {roi_width}x{roi_height} at ({roi_start_x},{roi_start_y}) with {self.current_settings.binning}x{self.current_settings.binning} binning')
            else:
                print(f'Set ROI: {roi_width}x{roi_height} at ({roi_start_x},{roi_start_y})')

        except Exception as e:
            print(f'Warning: Failed to set ROI: {e}')
            # Fall back to full frame
            try:
                binned_width = max_width // self.current_settings.binning
                binned_height = max_height // self.current_settings.binning
                binned_width = (binned_width // 8) * 8
                binned_height = (binned_height // 2) * 2

                self.camera.set_roi_format(binned_width, binned_height,
                                         bins=self.current_settings.binning,
                                         image_type=format_map[self.current_settings.format])
                # Reset to default start position for full frame
                self.camera.set_roi_start_position(0, 0)
                print(f'Fell back to full frame with {self.current_settings.binning}x{self.current_settings.binning} binning')
            except Exception as e2:
                print(f'Warning: Failed to set fallback ROI: {e2}')

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

    def _update_roi_position(self):
        """Update only the ROI position without full reconfiguration"""
        if not self.camera or not self.camera_info:
            return

        # Calculate ROI dimensions
        max_width = self.camera_info['MaxWidth']
        max_height = self.camera_info['MaxHeight']

        # Apply ROI selection
        roi_start_x = int(self.current_settings.roi_x * max_width)
        roi_start_y = int(self.current_settings.roi_y * max_height)

        # Apply binning to ROI start position
        if self.current_settings.binning > 1:
            roi_start_x = roi_start_x // self.current_settings.binning
            roi_start_y = roi_start_y // self.current_settings.binning

        try:
            # Update only the ROI start position
            self.camera.set_roi_start_position(roi_start_x, roi_start_y)
            print(f'Updated ROI position to ({roi_start_x},{roi_start_y})')
        except Exception as e:
            print(f'Warning: Failed to update ROI position: {e}')
            # If this fails, fall back to full reconfiguration
            self._configure_camera()

    def connect_camera(self):
        """Try to connect to camera"""
        try:
            # Find cameras
            num_cameras = asi.get_num_cameras()
            if num_cameras == 0:
                print("No cameras found")
                self.is_connected = False
                return False

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
            self.is_connected = True

            # If capture loop was running, restart video capture
            if self.is_capturing:
                try:
                    self.camera.start_video_capture()
                    print("Restarted video capture after reconnection")

                    # If recording was active, continue with the same directory
                    if self.is_recording and self.recording_directory:
                        print(f"Continuing recording to: {self.recording_directory}")
                        # Update frame count from existing files
                        if self.recording_directory.exists():
                            self.frames_recorded = len(list(self.recording_directory.glob("*")))

                except Exception as e:
                    print(f"Warning: Failed to restart video capture: {e}")

            return True

        except Exception as e:
            print(f"Failed to connect to camera: {e}")
            self.camera = None
            self.camera_info = None
            self.is_connected = False
            return False

    def disconnect_camera(self):
        """Safely disconnect camera"""
        try:
            if self.is_capturing:
                self.stop_capture()

            if self.camera:
                try:
                    self.camera.stop_video_capture()
                    self.camera.stop_exposure()
                except:
                    pass

            self.camera = None
            self.camera_info = None
            self.is_connected = False
            print("Camera disconnected")

        except Exception as e:
            print(f"Error during camera disconnect: {e}")

    def check_camera_connection(self):
        """Check if camera is still connected"""
        if not self.camera:
            return False

        try:
            # Try to get camera controls - this will fail if camera is disconnected
            cameras = asi.get_num_cameras()
            if cameras == 0:
                return False
            return True
        except Exception as e:
            print(f"Camera connection lost: {e}")
            return False

    def start_connection_monitoring(self):
        """Start background thread to monitor camera connection"""
        self.connection_check_event.clear()
        self.connection_check_thread = threading.Thread(target=self._connection_monitor_loop)
        self.connection_check_thread.daemon = True
        self.connection_check_thread.start()

    def stop_connection_monitoring(self):
        """Stop connection monitoring"""
        if self.connection_check_thread:
            self.connection_check_event.set()
            self.connection_check_thread.join(timeout=1.0)

    def _connection_monitor_loop(self):
        """Background loop to monitor camera connection"""
        while not self.connection_check_event.is_set():
            try:
                current_time = time.time()

                # Check connection every 5 seconds
                if current_time - self.last_connection_check > 1.0:
                    self.last_connection_check = current_time

                    if self.is_connected:
                        # If we think we're connected, verify it
                        if not self.check_camera_connection():
                            self.is_connected = False;
                            print("Camera disconnected, attempting reconnection...")
                    else:
                        # If we're not connected, try to reconnect
                        print("Attempting to reconnect camera...")
                        if self.connect_camera():
                            print("Camera reconnected successfully!")

                # Sleep for 1 second before next check
                self.connection_check_event.wait(0.5)

            except Exception as e:
                print(f"Error in connection monitor: {e}")
                self.connection_check_event.wait(0.5)

    def start_capture(self):
        """Start continuous frame capture"""
        if self.is_capturing:
            return

        if not self.camera or not self.is_connected:
            raise RuntimeError("Camera not connected")

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
                if not self.camera or not self.is_connected:
                    # Camera not connected, wait for reconnection
                    self.stop_capture_event.wait(1.0)  # Wait 1 second before checking again
                    continue

                # Use pre-allocated buffer for optimal performance
                frame_data = self.camera.capture_video_frame(buffer_=self.reusable_buffer)

                # Store latest frame (thread-safe)
                with self.frame_lock:
                    self.latest_frame_buffer = bytes(frame_data)  # Make a copy

                # Save frame to disk if recording (with rate limiting)
                if self.is_recording:
                    self._save_frame_to_disk_with_rate_limiting(frame_data)

                # Update FPS tracking
                self._update_fps_tracking()

            except Exception as e:
                if not self.stop_capture_event.is_set():
                    print(f"Capture error: {e}")
                    # Check if this is a connection error
                    if "timeout" not in str(e).lower():
                        # Likely a connection error, mark as disconnected
                        print("Camera appears to be disconnected, waiting for reconnection...")
                        self.is_connected = False
                        self.camera = None
                    # Don't break - continue the loop to wait for reconnection
                    self.stop_capture_event.wait(0.5)  # Brief pause before retrying

    def _update_fps_tracking(self):
        """Update FPS calculation based on frame timestamps"""
        current_time = time.time()

        with self.fps_lock:
            # Add current timestamp
            self.frame_timestamps.append(current_time)

            # Keep only the last 2 seconds of timestamps for accurate FPS calculation
            cutoff_time = current_time - 2.0
            self.frame_timestamps = [t for t in self.frame_timestamps if t > cutoff_time]

            # Calculate FPS based on frame count in the last 2 seconds
            if len(self.frame_timestamps) > 1:
                time_span = self.frame_timestamps[-1] - self.frame_timestamps[0]
                if time_span > 0:
                    self.current_fps = (len(self.frame_timestamps) - 1) / time_span
                else:
                    self.current_fps = 0.0
            else:
                self.current_fps = 0.0

    def get_current_fps(self) -> float:
        """Get the current capture FPS"""
        with self.fps_lock:
            return round(self.current_fps, 1)

    def start_recording(self):
        """Start recording frames to disk"""
        with self.recording_lock:
            if self.is_recording:
                return

            # Create recording directory with timestamp
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self.recording_directory = Path("/home/linus/zwo/captures") / timestamp
            self.recording_directory.mkdir(parents=True, exist_ok=True)

            self.is_recording = True
            self.frames_recorded = 0
            self.last_recording_frame_time = 0.0  # Reset rate limiting timestamp
            print(f"Started recording to: {self.recording_directory}")

    def stop_recording(self):
        """Stop recording frames to disk"""
        with self.recording_lock:
            if not self.is_recording:
                return

            self.is_recording = False
            frames_count = self.frames_recorded
            directory = self.recording_directory
            self.recording_directory = None
            self.frames_recorded = 0
            print(f"Stopped recording. Saved {frames_count} frames to: {directory}")

    def _save_frame_to_disk_with_rate_limiting(self, frame_data: bytes):
        """Save a frame to disk with FPS rate limiting"""
        if not self.is_recording or not self.recording_directory:
            return

        # Check if rate limiting is enabled
        if self.current_settings.max_recording_fps > 0:
            current_time = time.time()
            min_interval = 1.0 / self.current_settings.max_recording_fps
            
            # Check if enough time has passed since the last recorded frame
            if current_time - self.last_recording_frame_time < min_interval:
                return  # Skip this frame to maintain the target FPS
            
            self.last_recording_frame_time = current_time
        
        # Save the frame
        self._save_frame_to_disk(frame_data)

    def _save_frame_to_disk(self, frame_data: bytes):
        """Save a frame to disk with lossless compression and metadata"""
        if not self.is_recording or not self.recording_directory:
            return

        try:
            # Generate timestamp and filename
            capture_time = datetime.now()
            timestamp = capture_time.strftime("%Y%m%d_%H%M%S_%f")[:-3]  # Remove last 3 digits for ms precision
            
            # Get camera name
            camera_name = self.camera_info.get('Name', 'Unknown Camera') if self.camera_info else 'Unknown Camera'
            
            # Prepare metadata
            metadata = self._create_image_metadata(capture_time, camera_name)

            # Convert frame data to image for saving
            if self.frame_type == asi.ASI_IMG_RGB24:
                # RGB24 format
                img_array = np.frombuffer(frame_data, dtype=np.uint8)
                img_array = img_array.reshape((self.frame_height, self.frame_width, 3))
                img_array_rgb = img_array[:, :, ::-1]
                img = Image.fromarray(img_array_rgb, 'RGB')
                filename = self.recording_directory / f"{timestamp}.png"
            else:
                # RAW8/RAW16 format (mono)
                if self.frame_type == asi.ASI_IMG_RAW16:
                    img_array = np.frombuffer(frame_data, dtype=np.uint16)
                    img_array = img_array.reshape((self.frame_height, self.frame_width))  # Reshape to 2D
                    img = Image.fromarray(img_array, 'I;16')  # 16-bit grayscale
                    filename = self.recording_directory / f"{timestamp}.tif"  # TIFF for 16-bit
                else:
                    img_array = np.frombuffer(frame_data, dtype=np.uint8)
                    img_array = img_array.reshape((self.frame_height, self.frame_width))
                    img = Image.fromarray(img_array, 'L')  # 8-bit grayscale
                    filename = self.recording_directory / f"{timestamp}.png"

            # Save with lossless compression and metadata
            if filename.suffix == '.tif':
                img.save(filename, format='TIFF', compression='lzw', 
                        tiffinfo=metadata['tiff'])
            else:
                img.save(filename, format='PNG', compress_level=1, 
                        pnginfo=metadata['png'])

            self.frames_recorded += 1

        except Exception as e:
            print(f"Error saving frame to disk: {e}")

    def _create_image_metadata(self, capture_time: datetime, camera_name: str) -> Dict[str, Any]:
        """Create metadata for image files"""
        # Convert to UTC for proper ISO timestamp
        capture_time_utc = capture_time.utctimetuple()
        capture_time_utc_dt = datetime(*capture_time_utc[:6], capture_time.microsecond)
        
        # Format timestamps for metadata
        timestamp_iso = capture_time_utc_dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        timestamp_readable = capture_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " (local)"
        timestamp_readable_utc = capture_time_utc_dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3] + " (UTC)"
        
        # Get current camera settings
        exposure_us = self.current_settings.exposure
        gain = self.current_settings.gain
        binning = self.current_settings.binning
        image_format = self.current_settings.format
        
        # Convert exposure to readable format
        if exposure_us >= 1000000:
            exposure_str = f"{exposure_us / 1000000:.3f}s"
        elif exposure_us >= 1000:
            exposure_str = f"{exposure_us / 1000:.1f}ms"
        else:
            exposure_str = f"{exposure_us}μs"

        # Create PNG metadata
        png_info = PngInfo()
        png_info.add_text("Camera", camera_name)
        png_info.add_text("Capture Time Local", timestamp_readable)
        png_info.add_text("Capture Time UTC", timestamp_readable_utc)
        png_info.add_text("Capture Time ISO", timestamp_iso)
        png_info.add_text("Exposure", exposure_str)
        png_info.add_text("Exposure Microseconds", str(exposure_us))
        png_info.add_text("Gain", str(gain))
        png_info.add_text("Binning", f"{binning}x{binning}")
        png_info.add_text("Image Format", image_format)
        png_info.add_text("Width", str(self.frame_width))
        png_info.add_text("Height", str(self.frame_height))
        png_info.add_text("Software", "ZWO ASI Camera Controller")
        
        # Create TIFF metadata dictionary
        tiff_info = {}
        tiff_info[270] = f"Camera: {camera_name}, Exposure: {exposure_str}, Gain: {gain}, Binning: {binning}x{binning}, Captured: {timestamp_readable}, UTC: {timestamp_readable_utc}"  # ImageDescription
        tiff_info[271] = camera_name  # Make
        tiff_info[305] = "ZWO ASI Camera Controller"  # Software
        tiff_info[306] = timestamp_iso  # DateTime (ISO format with proper UTC)
        tiff_info[33432] = f"Exposure={exposure_us}μs;Gain={gain};Binning={binning};Format={image_format}"  # Copyright field repurposed for settings
        
        return {
            'png': png_info,
            'tiff': tiff_info
        }

    def _needs_recording_restart(self, old_settings: CameraSettings, new_settings: CameraSettings) -> bool:
        """Check if settings changes require recording restart"""
        # Only ROI position changes (roi_x, roi_y) should NOT restart recording
        # Everything else should restart recording to ensure consistent capture

        # Compare all settings except ROI position
        significant_changes = (
            old_settings.exposure != new_settings.exposure or
            old_settings.gain != new_settings.gain or
            old_settings.binning != new_settings.binning or
            old_settings.format != new_settings.format or
            old_settings.bandwidth != new_settings.bandwidth or
            old_settings.roi_width != new_settings.roi_width or
            old_settings.roi_height != new_settings.roi_height
        )

        return significant_changes

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

                # Calculate RGB histograms (image is BGR)
                b, g, r = img.split()
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
                img_array_rgb = img_array[:, :, ::-1]
                img = Image.fromarray(img_array_rgb, 'RGB')

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

            # Resize for streaming if image is larger than 512x512
            original_width, original_height = img.size
            if original_width > 512 or original_height > 512:
                # Calculate half resolution
                new_width = original_width // 2
                new_height = original_height // 2
                img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)

            # Convert to JPEG
            jpeg_buffer = io.BytesIO()
            img.save(jpeg_buffer, format='JPEG', quality=85, optimize=True)
            return jpeg_buffer.getvalue()

        except Exception as e:
            print(f"JPEG conversion error: {e}")
            return None

    def update_settings(self, settings: CameraSettings):
        """Update camera settings"""
        old_settings = self.current_settings
        
        # Check if only ROI position changed
        only_roi_position_changed = (
            old_settings.exposure == settings.exposure and
            old_settings.gain == settings.gain and
            old_settings.binning == settings.binning and
            old_settings.format == settings.format and
            old_settings.bandwidth == settings.bandwidth and
            old_settings.roi_width == settings.roi_width and
            old_settings.roi_height == settings.roi_height and
            (old_settings.roi_x != settings.roi_x or old_settings.roi_y != settings.roi_y)
        )
        
        if only_roi_position_changed and self.camera and self.is_connected:
            # Update only ROI position without restarting capture
            self.current_settings = settings
            self._update_roi_position()
        else:
            # Full reconfiguration needed
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
        self.stop_connection_monitoring()
        if self.camera:
            try:
                self.camera.stop_video_capture()
                self.camera.stop_exposure()
            except:
                pass
