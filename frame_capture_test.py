#!/usr/bin/env python3

import os
import sys
import time
import argparse
import zwoasi as asi
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Test frame capture speed from ZWOASI camera')
    parser.add_argument('--frames', type=int, default=100, help='Number of frames to capture (default: 100)')
    parser.add_argument('--output-dir', type=str, default='frames', help='Output directory for frames')
    parser.add_argument('--exposure', type=int, default=10000, help='Exposure time in microseconds (default: 10000)')
    parser.add_argument('--gain', type=int, default=100, help='Gain value (default: 100)')
    parser.add_argument('--format', choices=['raw8', 'raw16', 'rgb24'], default='raw8', help='Image format')
    parser.add_argument('--binning', type=int, choices=[1, 2, 4], default=1, help='Binning factor (1, 2, or 4)')
    parser.add_argument('--no-save', action='store_true', help='Skip saving files (test capture speed only)')
    parser.add_argument('--max-bandwidth', action='store_true', help='Use maximum USB bandwidth instead of minimum')
    parser.add_argument('--disable-whitebalance', action='store_true', help='Disable white balance controls for speed')
    parser.add_argument('--lib', type=str, help='SDK library path (overrides ZWO_ASI_LIB env var)')
    args = parser.parse_args()

    # Initialize SDK
    env_filename = os.getenv('ZWO_ASI_LIB')
    if args.lib:
        asi.init(args.lib)
    elif env_filename:
        asi.init(env_filename)
    else:
        print('Error: SDK library path required. Set ZWO_ASI_LIB environment variable or use --lib option')
        sys.exit(1)

    # Check for cameras
    num_cameras = asi.get_num_cameras()
    if num_cameras == 0:
        print('No cameras found')
        sys.exit(1)

    # Use first camera
    camera_id = 0
    cameras_found = asi.list_cameras()
    print(f'Using camera: {cameras_found[camera_id]}')

    camera = asi.Camera(camera_id)
    camera_info = camera.get_camera_property()

    # Create output directory
    output_dir = Path(args.output_dir)
    output_dir.mkdir(exist_ok=True)

    try:
        # Stop any ongoing capture
        camera.stop_video_capture()
        camera.stop_exposure()
    except:
        pass

    # Configure camera
    camera.disable_dark_subtract()
    
    # Set USB bandwidth (max for speed, min for stability)
    bandwidth_controls = camera.get_controls()['BandWidth']
    if args.max_bandwidth:
        bandwidth_value = bandwidth_controls['MaxValue']
        print(f'Using maximum USB bandwidth: {bandwidth_value}')
    else:
        bandwidth_value = bandwidth_controls['MinValue']
        print(f'Using minimum USB bandwidth: {bandwidth_value}')
    camera.set_control_value(asi.ASI_BANDWIDTHOVERLOAD, bandwidth_value)
    
    camera.set_control_value(asi.ASI_GAIN, args.gain)
    camera.set_control_value(asi.ASI_EXPOSURE, args.exposure)
    
    if not args.disable_whitebalance:
        camera.set_control_value(asi.ASI_WB_B, 99)
        camera.set_control_value(asi.ASI_WB_R, 75)
    
    # Minimize processing for speed
    camera.set_control_value(asi.ASI_GAMMA, 50)
    camera.set_control_value(asi.ASI_BRIGHTNESS, 50)
    camera.set_control_value(asi.ASI_FLIP, 0)

    # Set image format
    format_map = {
        'raw8': asi.ASI_IMG_RAW8,
        'raw16': asi.ASI_IMG_RAW16,
        'rgb24': asi.ASI_IMG_RGB24
    }
    
    if args.format == 'rgb24' and not camera_info['IsColorCam']:
        print('Warning: RGB24 format requested but camera is mono. Using RAW8 instead.')
        args.format = 'raw8'
    
    camera.set_image_type(format_map[args.format])

    # Set binning if supported
    if args.binning > 1:
        try:
            # Get current image dimensions
            max_width = camera_info['MaxWidth']
            max_height = camera_info['MaxHeight']
            binned_width = max_width // args.binning
            binned_height = max_height // args.binning
            
            # Ensure width is multiple of 8
            binned_width = (binned_width // 8) * 8
            # Ensure height is multiple of 2 (common requirement)
            binned_height = (binned_height // 2) * 2
            
            camera.set_roi_format(binned_width, binned_height, bins=args.binning, image_type=format_map[args.format])
            print(f'Set binning to {args.binning}x{args.binning} (resolution: {binned_width}x{binned_height})')
        except Exception as e:
            print(f'Warning: Failed to set binning to {args.binning}x{args.binning}: {e}')

    # Start video capture mode
    camera.start_video_capture()

    # Set timeout - reduce for faster polling
    exposure_ms = camera.get_control_value(asi.ASI_EXPOSURE)[0] / 1000
    timeout = max(exposure_ms * 1.5 + 100, 200)  # Shorter timeout for faster frames
    camera.default_timeout = timeout
    print(f'Camera timeout set to: {timeout:.0f}ms')

    print(f'Starting capture of {args.frames} frames...')
    print(f'Format: {args.format}, Exposure: {args.exposure}μs, Gain: {args.gain}, Binning: {args.binning}x{args.binning}')
    print(f'Output directory: {output_dir}')
    
    # Pre-allocate buffer for reuse
    roi_format = camera.get_roi_format()
    width, height, bins, img_type = roi_format
    
    buffer_size = width * height
    if img_type == asi.ASI_IMG_RGB24:
        buffer_size *= 3
    elif img_type == asi.ASI_IMG_RAW16:
        buffer_size *= 2
        
    reusable_buffer = bytearray(buffer_size)
    print(f'Pre-allocated buffer: {width}x{height}, size: {buffer_size} bytes')
    
    # Capture frames and measure performance
    start_time = time.time()
    successful_frames = 0
    total_capture_time = 0
    total_save_time = 0
    
    for i in range(args.frames):
        try:
            # Generate filename with frame number
            ext = 'tiff' if args.format == 'raw16' else 'jpg'
            filename = output_dir / f'frame_{i:06d}.{ext}'
            
            frame_start = time.time()
            
            # Capture frame data using pre-allocated buffer
            capture_start = time.time()
            img_data = camera.capture_video_frame(buffer_=reusable_buffer)
            capture_time = time.time() - capture_start
            
            # Save to file (if not skipped)
            save_start = time.time()
            if not args.no_save:
                with open(filename, 'wb') as f:
                    f.write(img_data)
            save_time = time.time() - save_start
            
            frame_time = time.time() - frame_start
            total_capture_time += capture_time
            total_save_time += save_time
            
            successful_frames += 1
            
            if i % 10 == 0:  # Progress update every 10 frames
                print(f'Frame {i+1:4d}/{args.frames}: total={frame_time*1000:.1f}ms, capture={capture_time*1000:.1f}ms, save={save_time*1000:.1f}ms')
                
        except Exception as e:
            print(f'Failed to capture frame {i}: {e}')
            continue

    total_time = time.time() - start_time
    
    # Stop capture
    camera.stop_video_capture()

    # Print performance statistics
    print(f'\nCapture completed!')
    print(f'Total time: {total_time:.2f} seconds')
    print(f'Successful frames: {successful_frames}/{args.frames}')
    print(f'Average FPS: {successful_frames/total_time:.2f}')
    print(f'Average time per frame: {(total_time/successful_frames)*1000:.1f}ms')
    print(f'Average capture time: {(total_capture_time/successful_frames)*1000:.1f}ms')
    print(f'Average save time: {(total_save_time/successful_frames)*1000:.1f}ms')
    print(f'Time breakdown: {(total_capture_time/total_time)*100:.1f}% capture, {(total_save_time/total_time)*100:.1f}% save')
    
    if successful_frames < args.frames:
        print(f'Failed frames: {args.frames - successful_frames}')


if __name__ == '__main__':
    main()