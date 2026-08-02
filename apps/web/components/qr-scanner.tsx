'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Camera QR scanner for chapter check-in (Wave P6c). Uses getUserMedia plus
 * jsQR decoded from a plain canvas at ~4fps (torch off — low-end device and
 * battery friendly). jsQR is dynamically imported so it only ships with this
 * route's chunk.
 *
 * Availability and permission failures surface via `onUnavailable` so the
 * caller can fall back to the paste-in code flow.
 */

export type ScannerStatus = 'starting' | 'active' | 'unavailable';

/** True when this browser can attempt camera capture at all. */
export function isCameraSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

const SCAN_INTERVAL_MS = 250; // ~4fps

export function QrCameraScanner({
  onScan,
  onUnavailable
}: {
  onScan: (value: string) => void;
  onUnavailable: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<ScannerStatus>('starting');

  useEffect(() => {
    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setStatus('unavailable');
      onUnavailable('This device or browser does not support camera access.');
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    // Captured once so the cleanup never reads a stale ref.
    const videoEl = videoRef.current;

    const start = async () => {
      let jsQR: typeof import('jsqr').default;
      try {
        jsQR = (await import('jsqr')).default;
      } catch {
        if (!cancelled) {
          setStatus('unavailable');
          onUnavailable('The scanner module could not be loaded.');
        }
        return;
      }

      try {
        // Torch stays off; modest resolution keeps decode cheap at 4fps.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false
        });
      } catch {
        if (!cancelled) {
          setStatus('unavailable');
          onUnavailable('Camera permission was denied or no camera is available.');
        }
        return;
      }

      const video = videoEl;
      if (cancelled || !video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay policies can reject play(); frames may still arrive.
      }
      setStatus('active');

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        setStatus('unavailable');
        onUnavailable('Canvas is not available in this browser.');
        return;
      }

      interval = setInterval(() => {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width === 0 || height === 0) return;
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const frame = context.getImageData(0, 0, width, height);
        const decoded = jsQR(frame.data, width, height, { inversionAttempts: 'dontInvert' });
        if (decoded && decoded.data.trim() !== '') {
          onScan(decoded.data);
        }
      }, SCAN_INTERVAL_MS);
    };

    void start();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (videoEl) videoEl.srcObject = null;
    };
  }, [onScan, onUnavailable]);

  return (
    <div className="qr-scanner" data-status={status}>
      {/* Muted + playsInline are required for autoplay on mobile browsers. */}
      <video ref={videoRef} className="qr-video" muted playsInline aria-label="Camera preview for QR scanning" />
      <p className="small muted" role="status">
        {status === 'starting' ? 'Starting the camera…' : 'Point the camera at the attendance QR code.'}
      </p>
    </div>
  );
}
