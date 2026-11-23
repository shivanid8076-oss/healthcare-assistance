"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Place } from "@/lib/api";
import type { NavOrigin } from "./PatientNavigation";

interface RouteMapProps {
  origin?: NavOrigin | null;
  destination?: Place | null;
  geometry?: [number, number][]; // GeoJSON [lng, lat] pairs
  isFallback?: boolean;
  fallbackReason?: string | null;
  userLocation?: { lat: number; lng: number } | null;
  className?: string;
  height?: number | string;
}

// Slippy map projection math (EPSG:3857 Web Mercator)
function lngToTileX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    Math.pow(2, zoom)
  );
}

function tileXToLng(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

// In-memory tile cache to prevent repeated network requests during pan/zoom
const tileCache = new Map<string, HTMLImageElement>();

export function RouteMap({
  origin,
  destination,
  geometry = [],
  isFallback = false,
  fallbackReason = null,
  userLocation = null,
  className = "",
  height = 380,
}: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Map viewport state: center coordinates and zoom level (1..18)
  const [center, setCenter] = useState<{ lat: number; lng: number }>({
    lat: 28.6129,
    lng: 77.2295, // Default center: Delhi NCR
  });
  const [zoom, setZoom] = useState<number>(13);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [pinchDist, setPinchDist] = useState<number | null>(null);

  // Store active center & zoom in refs for high-frequency animation frames
  const viewRef = useRef({ center, zoom });
  viewRef.current = { center, zoom };

  // Calculate and fit bounds to encompass origin, destination, and geometry
  const fitBounds = useCallback(() => {
    const points: [number, number][] = [];
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
      points.push([origin.lat, origin.lng]);
    }
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      points.push([destination.lat, destination.lng]);
    }
    if (geometry && geometry.length > 0) {
      for (const [lng, lat] of geometry) {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          points.push([lat, lng]);
        }
      }
    }

    if (points.length === 0) return;

    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;

    for (const [lat, lng] of points) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    const cLat = (minLat + maxLat) / 2;
    const cLng = (minLng + maxLng) / 2;

    const canvas = canvasRef.current;
    const w = canvas ? canvas.clientWidth : 600;
    const h = canvas ? canvas.clientHeight : 380;
    const pad = 60; // padding in pixels

    // Calculate required zoom level
    let targetZoom = 14;
    for (let z = 18; z >= 3; z--) {
      const x1 = lngToTileX(minLng, z) * 256;
      const x2 = lngToTileX(maxLng, z) * 256;
      const y1 = latToTileY(maxLat, z) * 256;
      const y2 = latToTileY(minLat, z) * 256;

      const spanX = Math.abs(x2 - x1);
      const spanY = Math.abs(y2 - y1);

      if (spanX <= w - pad * 2 && spanY <= h - pad * 2) {
        targetZoom = z;
        break;
      }
    }

    // Clamp zoom to reasonable urban levels
    targetZoom = Math.min(16, Math.max(10, targetZoom));

    setCenter({ lat: cLat, lng: cLng });
    setZoom(targetZoom);
  }, [origin, destination, geometry]);

  // Automatically fit bounds whenever origin, destination, or geometry changes
  useEffect(() => {
    fitBounds();
  }, [fitBounds]);

  // Main Canvas Render Loop
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    const { center: currentCenter, zoom: currentZoom } = viewRef.current;

    // Background fill (Warm ivory matching RaktDoot palette)
    ctx.fillStyle = "#faf6ea";
    ctx.fillRect(0, 0, width, height);

    // World pixel coordinate calculations
    const centerTileX = lngToTileX(currentCenter.lng, currentZoom);
    const centerTileY = latToTileY(currentCenter.lat, currentZoom);
    const centerPixelX = centerTileX * 256;
    const centerPixelY = centerTileY * 256;

    const screenToWorld = (screenX: number, screenY: number) => {
      const worldX = centerPixelX + (screenX - width / 2);
      const worldY = centerPixelY + (screenY - height / 2);
      return { worldX, worldY };
    };

    const worldToScreen = (worldX: number, worldY: number) => {
      const screenX = width / 2 + (worldX - centerPixelX);
      const screenY = height / 2 + (worldY - centerPixelY);
      return { screenX, screenY };
    };

    const coordToScreen = (lat: number, lng: number) => {
      const tileX = lngToTileX(lng, currentZoom);
      const tileY = latToTileY(lat, currentZoom);
      return worldToScreen(tileX * 256, tileY * 256);
    };

    // Calculate visible slippy tile range
    const intZoom = Math.floor(currentZoom);
    const scaleFactor = Math.pow(2, currentZoom - intZoom);

    const leftWorld = screenToWorld(0, 0).worldX;
    const rightWorld = screenToWorld(width, 0).worldX;
    const topWorld = screenToWorld(0, 0).worldY;
    const bottomWorld = screenToWorld(0, height).worldY;

    const numTiles = Math.pow(2, intZoom);
    const minTileX = Math.floor((leftWorld / 256) / scaleFactor);
    const maxTileX = Math.floor((rightWorld / 256) / scaleFactor);
    const minTileY = Math.floor((topWorld / 256) / scaleFactor);
    const maxTileY = Math.floor((bottomWorld / 256) / scaleFactor);

    // 1. Render OpenStreetMap Raster Tiles
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        if (ty < 0 || ty >= numTiles) continue;
        const normalizedTx = ((tx % numTiles) + numTiles) % numTiles;
        const tileKey = `${intZoom}/${normalizedTx}/${ty}`;
        const tileUrl = `https://tile.openstreetmap.org/${intZoom}/${normalizedTx}/${ty}.png`;

        const tileWorldX = tx * 256 * scaleFactor;
        const tileWorldY = ty * 256 * scaleFactor;
        const { screenX, screenY } = worldToScreen(tileWorldX, tileWorldY);
        const tileSize = 256 * scaleFactor;

        let img = tileCache.get(tileKey);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous";
          img.src = tileUrl;
          img.onload = () => requestAnimationFrame(render);
          img.onerror = () => {
            // Keep going gracefully on tile load errors
          };
          tileCache.set(tileKey, img);
        }

        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, screenX, screenY, tileSize, tileSize);
        } else {
          // Subtle grid outline while tile loads
          ctx.strokeStyle = "#e8e1cd";
          ctx.lineWidth = 1;
          ctx.strokeRect(screenX, screenY, tileSize, tileSize);
        }
      }
    }

    // 2. Draw Route Polyline
    if (geometry && geometry.length > 1) {
      const screenPoints = geometry.map(([lng, lat]) => coordToScreen(lat, lng));

      // Outer Casing (Clean high-contrast boundary)
      ctx.beginPath();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = isFallback ? 6 : 7;
      ctx.strokeStyle = "#ffffff";
      screenPoints.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.screenX, pt.screenY);
        else ctx.lineTo(pt.screenX, pt.screenY);
      });
      ctx.stroke();

      // Inner Route Line
      ctx.beginPath();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (isFallback) {
        // Fallback: Dashed amber line to visually indicate estimated corridor
        ctx.setLineDash([10, 7]);
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#c97f18";
      } else {
        // Live OSRM Road Route: Solid rich burgundy
        ctx.setLineDash([]);
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = "#80011f";
      }

      screenPoints.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.screenX, pt.screenY);
        else ctx.lineTo(pt.screenX, pt.screenY);
      });
      ctx.stroke();
      ctx.setLineDash([]); // Reset dash
    }

    // 3. Draw Origin Marker (A / Start)
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
      const { screenX, screenY } = coordToScreen(origin.lat, origin.lng);

      // Marker Drop Shadow
      ctx.fillStyle = "rgba(42, 33, 28, 0.25)";
      ctx.beginPath();
      ctx.ellipse(screenX, screenY + 2, 7, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Pin Body (Green Emerald)
      ctx.fillStyle = "#1e633d";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY - 12, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Pin Pointer
      ctx.fillStyle = "#1e633d";
      ctx.beginPath();
      ctx.moveTo(screenX - 5, screenY - 4);
      ctx.lineTo(screenX + 5, screenY - 4);
      ctx.lineTo(screenX, screenY);
      ctx.closePath();
      ctx.fill();

      // Letter 'A' Label
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("A", screenX, screenY - 12);
    }

    // 4. Draw Destination Hospital Marker (B / Hospital)
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      const { screenX, screenY } = coordToScreen(destination.lat, destination.lng);

      // Drop Shadow
      ctx.fillStyle = "rgba(42, 33, 28, 0.3)";
      ctx.beginPath();
      ctx.ellipse(screenX, screenY + 2, 8, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      // Pin Body (Rich Burgundy)
      ctx.fillStyle = "#80011f";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY - 13, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Pin Pointer
      ctx.fillStyle = "#80011f";
      ctx.beginPath();
      ctx.moveTo(screenX - 6, screenY - 4);
      ctx.lineTo(screenX + 6, screenY - 4);
      ctx.lineTo(screenX, screenY);
      ctx.closePath();
      ctx.fill();

      // Hospital Cross Icon (+)
      ctx.fillStyle = "#ffffff";
      const crossSize = 7;
      const crossThick = 2.5;
      ctx.fillRect(screenX - crossThick / 2, screenY - 13 - crossSize / 2, crossThick, crossSize);
      ctx.fillRect(screenX - crossSize / 2, screenY - 13 - crossThick / 2, crossSize, crossThick);
    }

    // 5. Draw User GPS Location (Blue Pulsing Dot)
    if (userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
      const { screenX, screenY } = coordToScreen(userLocation.lat, userLocation.lng);

      // Outer Halo
      ctx.fillStyle = "rgba(25, 118, 210, 0.22)";
      ctx.beginPath();
      ctx.arc(screenX, screenY, 14, 0, Math.PI * 2);
      ctx.fill();

      // Core Circle
      ctx.fillStyle = "#1976d2";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(screenX, screenY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 6. Calculate Scale Indicator
    const metersPerPixel = (156543.03392 * Math.cos((currentCenter.lat * Math.PI) / 180)) / Math.pow(2, currentZoom);
    const targetPixelWidth = 80;
    const rawMeters = targetPixelWidth * metersPerPixel;

    let scaleMeters = 100;
    if (rawMeters >= 50000) scaleMeters = 50000;
    else if (rawMeters >= 20000) scaleMeters = 20000;
    else if (rawMeters >= 10000) scaleMeters = 10000;
    else if (rawMeters >= 5000) scaleMeters = 5000;
    else if (rawMeters >= 2000) scaleMeters = 2000;
    else if (rawMeters >= 1000) scaleMeters = 1000;
    else if (rawMeters >= 500) scaleMeters = 500;
    else if (rawMeters >= 200) scaleMeters = 200;

    const actualBarWidth = scaleMeters / metersPerPixel;
    const scaleText = scaleMeters >= 1000 ? `${scaleMeters / 1000} km` : `${scaleMeters} m`;

    // Draw Scale Bar on bottom-left
    const barX = 14;
    const barY = height - 16;
    ctx.strokeStyle = "rgba(42, 33, 28, 0.75)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(barX, barY - 4);
    ctx.lineTo(barX, barY);
    ctx.lineTo(barX + actualBarWidth, barY);
    ctx.lineTo(barX + actualBarWidth, barY - 4);
    ctx.stroke();

    ctx.fillStyle = "rgba(42, 33, 28, 0.85)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(scaleText, barX + actualBarWidth / 2, barY - 5);

    ctx.restore();
  }, [center, zoom, geometry, origin, destination, userLocation, isFallback]);

  // Request animation frame on state or dependency changes
  useEffect(() => {
    let animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [render]);

  // Handle Resize via ResizeObserver
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(render);
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [render]);

  // Mouse & Touch Pan Handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDragging || !dragStart) return;

    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setDragStart({ x: e.clientX, y: e.clientY });

    const currentCenter = viewRef.current.center;
    const currentZoom = viewRef.current.zoom;

    const currentTileX = lngToTileX(currentCenter.lng, currentZoom);
    const currentTileY = latToTileY(currentCenter.lat, currentZoom);

    const newTileX = currentTileX - dx / 256;
    const newTileY = currentTileY - dy / 256;

    const newLng = tileXToLng(newTileX, currentZoom);
    const newLat = tileYToLat(newTileY, currentZoom);

    setCenter({ lat: newLat, lng: newLng });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (canvasRef.current) {
      try {
        canvasRef.current.releasePointerCapture(e.pointerId);
      } catch {}
    }
    setIsDragging(false);
    setDragStart(null);
  };

  // Mouse Wheel Zoom Handler
  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const zoomDelta = e.deltaY < 0 ? 0.35 : -0.35;
    const newZoom = Math.min(18, Math.max(3, viewRef.current.zoom + zoomDelta));

    // Zoom toward mouse cursor location
    const currentTileX = lngToTileX(viewRef.current.center.lng, viewRef.current.zoom);
    const currentTileY = latToTileY(viewRef.current.center.lat, viewRef.current.zoom);

    const cursorWorldX = currentTileX * 256 + (cursorX - rect.width / 2);
    const cursorWorldY = currentTileY * 256 + (cursorY - rect.height / 2);

    const cursorLng = tileXToLng(cursorWorldX / 256, viewRef.current.zoom);
    const cursorLat = tileYToLat(cursorWorldY / 256, viewRef.current.zoom);

    const scale = Math.pow(2, newZoom - viewRef.current.zoom);
    const newCenterTileX = lngToTileX(cursorLng, newZoom) - (cursorX - rect.width / 2) / 256;
    const newCenterTileY = latToTileY(cursorLat, newZoom) - (cursorY - rect.height / 2) / 256;

    setCenter({
      lat: tileYToLat(newCenterTileY, newZoom),
      lng: tileXToLng(newCenterTileX, newZoom),
    });
    setZoom(newZoom);
  };

  // Touch Pinch Zoom Handler
  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      if (pinchDist !== null) {
        const delta = (dist - pinchDist) / 120;
        setZoom((z) => Math.min(18, Math.max(3, z + delta)));
      }
      setPinchDist(dist);
    }
  };

  const handleTouchEnd = () => {
    setPinchDist(null);
  };

  const handleZoomIn = () => setZoom((z) => Math.min(18, z + 1));
  const handleZoomOut = () => setZoom((z) => Math.max(3, z - 1));

  const hasEndpoints = Boolean(origin && destination);

  return (
    <div
      ref={containerRef}
      className={`route-map-container ${className}`}
      style={{ height, position: "relative" }}
      aria-label="Interactive Route Map"
    >
      <canvas
        ref={canvasRef}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          cursor: isDragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />

      {/* Fallback Warning Overlay Banner */}
      {isFallback && hasEndpoints && (
        <div className="route-map-fallback-banner" role="alert">
          <span>⚠️ Estimated Corridor</span>
          <span className="route-map-fallback-sub">
            {fallbackReason ? ` (Reason: ${fallbackReason})` : ""} · Road routing is approximate
          </span>
        </div>
      )}

      {/* Zoom and Fit Controls */}
      <div className="route-map-controls" role="toolbar" aria-label="Map Navigation Controls">
        <button
          type="button"
          className="route-map-btn"
          onClick={handleZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="route-map-btn"
          onClick={handleZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="route-map-btn"
          onClick={fitBounds}
          title="Fit route bounds"
          aria-label="Fit route to screen"
        >
          ⛶
        </button>
        {userLocation && (
          <button
            type="button"
            className="route-map-btn"
            onClick={() => {
              setCenter({ lat: userLocation.lat, lng: userLocation.lng });
              setZoom(15);
            }}
            title="Center on my location"
            aria-label="Center on my location"
          >
            🎯
          </button>
        )}
      </div>

      {/* Map Legend (Bottom-right badge) */}
      <div className="route-map-legend" aria-hidden="true">
        {isFallback ? (
          <span style={{ color: "#c97f18", fontWeight: 600 }}>┄┄ Estimated Path</span>
        ) : (
          <span style={{ color: "#80011f", fontWeight: 600 }}>━━ OSRM Road Route</span>
        )}
        <span className="muted">· © OpenStreetMap</span>
      </div>
    </div>
  );
}

