"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Place } from "@/lib/api";
import type { NavOrigin } from "./PatientNavigation";
import "maplibre-gl/dist/maplibre-gl.css";

export interface RouteMapProps {
  origin?: NavOrigin | null;
  destination?: Place | null;
  geometry?: [number, number][]; // GeoJSON [lng, lat] pairs
  isFallback?: boolean;
  fallbackReason?: string | null;
  userLocation?: { lat: number; lng: number } | null;
  className?: string;
  height?: number | string;
  distanceKm?: number;
  durationMinutes?: number;
  mode?: string;
}

type MapTheme = "streets" | "voyager" | "dark";

// Carto Voyager High-Resolution Retina Raster Style (zero API key, crystal-clear road labels)
const CARTO_VOYAGER_STYLE: any = {
  version: 8,
  sources: {
    "carto-voyager": {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
    },
  },
  layers: [
    {
      id: "carto-voyager-layer",
      type: "raster",
      source: "carto-voyager",
      minzoom: 0,
      maxzoom: 20,
    },
  ],
};

// Carto Dark Matter High-Resolution Retina Raster Style (Dark mode)
const CARTO_DARK_STYLE: any = {
  version: 8,
  sources: {
    "carto-dark": {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>',
    },
  },
  layers: [
    {
      id: "carto-dark-layer",
      type: "raster",
      source: "carto-dark",
      minzoom: 0,
      maxzoom: 20,
    },
  ],
};

const OPENFREEMAP_BRIGHT = "https://tiles.openfreemap.org/styles/bright";
const OPENFREEMAP_LIBERTY = "https://tiles.openfreemap.org/styles/liberty";

// Projection math for Canvas Fallback
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

const tileCache = new Map<string, HTMLImageElement>();

export function RouteMap({
  origin,
  destination,
  geometry = [],
  isFallback = false,
  fallbackReason = null,
  userLocation = null,
  className = "",
  height = 420,
  distanceKm,
  durationMinutes,
  mode = "driving",
}: RouteMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // MapLibre instance refs
  const mapInstanceRef = useRef<any>(null);
  const maplibreglRef = useRef<any>(null);
  const originMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);

  const [mapReady, setMapReady] = useState(false);
  const [useCanvasFallback, setUseCanvasFallback] = useState(false);
  const [mapTheme, setMapTheme] = useState<MapTheme>("streets");
  const [styleLoading, setStyleLoading] = useState(false);
  const styleRequestIdRef = useRef<number>(0);
  const styleTimeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeStyleCleanupRef = useRef<(() => void) | null>(null);

  // Canvas Fallback Viewport State
  const [canvasCenter, setCanvasCenter] = useState<{ lat: number; lng: number }>({
    lat: 28.6129,
    lng: 77.2295,
  });
  const [canvasZoom, setCanvasZoom] = useState<number>(13);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const canvasViewRef = useRef({ center: canvasCenter, zoom: canvasZoom });
  canvasViewRef.current = { center: canvasCenter, zoom: canvasZoom };

  // Helper to create custom DOM marker elements
  const createOriginMarkerElement = (label?: string) => {
    const el = document.createElement("div");
    el.className = "nav-marker-origin-wrapper";
    el.innerHTML = `
      <div class="nav-marker-pin nav-marker-origin">
        <svg width="34" height="44" viewBox="0 0 34 44" fill="none" xmlns="http://www.w3.org/2000/svg">
          <filter id="shadow-origin" x="-20%" y="-10%" width="140%" height="130%">
            <feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-color="#2a211c" flood-opacity="0.35"/>
          </filter>
          <path d="M17 0C7.61 0 0 7.61 0 17C0 29.75 17 44 17 44C17 44 34 29.75 34 17C34 7.61 26.39 0 17 0Z" fill="#15803d" filter="url(#shadow-origin)"/>
          <circle cx="17" cy="16" r="10" fill="#ffffff"/>
          <text x="17" y="20" font-size="12" font-weight="bold" fill="#15803d" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif">A</text>
        </svg>
      </div>
    `;
    const pin = el.querySelector<HTMLDivElement>(".nav-marker-pin");
    if (pin) {
      pin.title = label || "Origin";
    }
    return el;
  };

  const createDestMarkerElement = (name?: string) => {
    const el = document.createElement("div");
    el.className = "nav-marker-dest-wrapper";
    el.innerHTML = `
      <div class="nav-marker-pin nav-marker-dest">
        <div class="nav-dest-pulse"></div>
        <svg width="36" height="46" viewBox="0 0 36 46" fill="none" xmlns="http://www.w3.org/2000/svg">
          <filter id="shadow-dest" x="-20%" y="-10%" width="140%" height="130%">
            <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#5e0016" flood-opacity="0.45"/>
          </filter>
          <path d="M18 0C8.06 0 0 8.06 0 18C0 31.5 18 46 18 46C18 46 36 31.5 36 18C36 8.06 27.94 0 18 0Z" fill="#80011f" filter="url(#shadow-dest)"/>
          <circle cx="18" cy="17" r="10.5" fill="#ffffff"/>
          <rect x="16" y="11" width="4" height="12" rx="1" fill="#80011f"/>
          <rect x="12" y="15" width="12" height="4" rx="1" fill="#80011f"/>
        </svg>
      </div>
    `;
    const pin = el.querySelector<HTMLDivElement>(".nav-marker-pin");
    if (pin) {
      pin.title = name || "Destination Hospital";
    }
    return el;
  };

  const createUserMarkerElement = () => {
    const el = document.createElement("div");
    el.className = "nav-marker-gps-wrapper";
    el.innerHTML = `
      <div class="nav-marker-gps">
        <div class="nav-gps-pulse"></div>
        <div class="nav-gps-core"></div>
      </div>
    `;
    const pin = el.querySelector<HTMLDivElement>(".nav-marker-gps");
    if (pin) {
      pin.title = "Your Current GPS Location";
    }
    return el;
  };

  // Compute bounding box for bounds fitting
  const calculateBounds = useCallback(() => {
    const points: [number, number][] = [];
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
      points.push([origin.lng, origin.lat]);
    }
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      points.push([destination.lng, destination.lat]);
    }
    if (geometry && geometry.length > 0) {
      for (const [lng, lat] of geometry) {
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          points.push([lng, lat]);
        }
      }
    }
    if (points.length === 0 && userLocation) {
      points.push([userLocation.lng, userLocation.lat]);
    }
    return points;
  }, [origin, destination, geometry, userLocation]);

  // Fit bounds helper for MapLibre or Canvas
  const fitBounds = useCallback(() => {
    const points = calculateBounds();
    if (points.length === 0) return;

    if (mapInstanceRef.current && maplibreglRef.current && !useCanvasFallback) {
      const map = mapInstanceRef.current;
      const maplibregl = maplibreglRef.current;
      const bounds = new maplibregl.LngLatBounds();
      points.forEach(([lng, lat]) => bounds.extend([lng, lat]));

      map.fitBounds(bounds, {
        padding: { top: 80, bottom: 60, left: 60, right: 60 },
        maxZoom: 16,
        duration: 700,
      });
      return;
    }

    // Canvas fallback bounds calculation
    let minLat = 90;
    let maxLat = -90;
    let minLng = 180;
    let maxLng = -180;

    for (const [lng, lat] of points) {
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
    const pad = 70;

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
    setCanvasCenter({ lat: cLat, lng: cLng });
    setCanvasZoom(Math.min(16, Math.max(10, targetZoom)));
  }, [calculateBounds, useCanvasFallback]);

  // Update Route Layers in MapLibre
  const updateMapRouteLayers = useCallback((map: any) => {
    if (!map || !map.isStyleLoaded()) return;

    const sourceData = {
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "LineString" as const,
        coordinates: geometry && geometry.length > 0 ? geometry : [],
      },
    };

    const existingSource = map.getSource("route-source");
    if (existingSource) {
      existingSource.setData(sourceData);
    } else {
      map.addSource("route-source", {
        type: "geojson",
        data: sourceData,
      });
    }

    // Outer Casing Layer (High-contrast boundary)
    if (!map.getLayer("route-casing")) {
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route-source",
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": isFallback ? "#78350f" : "#ffffff",
          "line-width": isFallback ? 7 : 9,
          "line-opacity": 0.95,
        },
      });
    } else {
      map.setPaintProperty("route-casing", "line-color", isFallback ? "#78350f" : "#ffffff");
      map.setPaintProperty("route-casing", "line-width", isFallback ? 7 : 9);
    }

    // Core Route Line Layer
    if (!map.getLayer("route-line")) {
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route-source",
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: isFallback
          ? {
              "line-color": "#d97706",
              "line-width": 4.5,
              "line-dasharray": [2, 2],
              "line-opacity": 0.95,
            }
          : {
              "line-color": "#1a73e8", // High-visibility navigation blue
              "line-width": 5.5,
              "line-opacity": 1.0,
            },
      });
    } else {
      map.setPaintProperty("route-line", "line-color", isFallback ? "#d97706" : "#1a73e8");
      map.setPaintProperty("route-line", "line-width", isFallback ? 4.5 : 5.5);
      if (isFallback) {
        map.setPaintProperty("route-line", "line-dasharray", [2, 2]);
      } else {
        // Reset dasharray for solid road line
        map.setPaintProperty("route-line", "line-dasharray", [1, 0]);
      }
    }
  }, [geometry, isFallback]);

  // Synchronize Markers in MapLibre
  const updateMapMarkers = useCallback((map: any, maplibregl: any) => {
    if (!map || !maplibregl) return;

    // 1. Origin Marker
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
      const popupNode = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = "Starting Point";
      popupNode.appendChild(strong);
      popupNode.appendChild(document.createElement("br"));
      popupNode.appendChild(document.createTextNode(origin.label || "Selected Origin"));

      if (!originMarkerRef.current) {
        const el = createOriginMarkerElement(origin.label);
        const popup = new maplibregl.Popup({ offset: 25, closeButton: false }).setDOMContent(popupNode);
        originMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([origin.lng, origin.lat])
          .setPopup(popup)
          .addTo(map);
      } else {
        originMarkerRef.current.setLngLat([origin.lng, origin.lat]);
        const pin = originMarkerRef.current.getElement()?.querySelector(".nav-marker-pin");
        if (pin) pin.title = origin.label || "Origin";
        originMarkerRef.current.getPopup()?.setDOMContent(popupNode);
      }
    } else if (originMarkerRef.current) {
      originMarkerRef.current.remove();
      originMarkerRef.current = null;
    }

    // 2. Destination Marker
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      const popupNode = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = `🏥 ${destination.name}`;
      popupNode.appendChild(strong);

      if (destination.address) {
        popupNode.appendChild(document.createElement("br"));
        const addrSpan = document.createElement("span");
        addrSpan.style.color = "#6c6056";
        addrSpan.style.fontSize = "12px";
        addrSpan.textContent = destination.address;
        popupNode.appendChild(addrSpan);
      }

      if (!destMarkerRef.current) {
        const el = createDestMarkerElement(destination.name);
        const popup = new maplibregl.Popup({ offset: 25, closeButton: false }).setDOMContent(popupNode);
        destMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([destination.lng, destination.lat])
          .setPopup(popup)
          .addTo(map);
      } else {
        destMarkerRef.current.setLngLat([destination.lng, destination.lat]);
        const pin = destMarkerRef.current.getElement()?.querySelector(".nav-marker-pin");
        if (pin) pin.title = destination.name || "Destination Hospital";
        destMarkerRef.current.getPopup()?.setDOMContent(popupNode);
      }
    } else if (destMarkerRef.current) {
      destMarkerRef.current.remove();
      destMarkerRef.current = null;
    }

    // 3. User GPS Marker
    if (userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
      const popupNode = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = "Your Location (GPS)";
      popupNode.appendChild(strong);

      if (!userMarkerRef.current) {
        const el = createUserMarkerElement();
        const popup = new maplibregl.Popup({ offset: 15, closeButton: false }).setDOMContent(popupNode);
        userMarkerRef.current = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat([userLocation.lng, userLocation.lat])
          .setPopup(popup)
          .addTo(map);
      } else {
        userMarkerRef.current.setLngLat([userLocation.lng, userLocation.lat]);
        userMarkerRef.current.getPopup()?.setDOMContent(popupNode);
      }
    } else if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
  }, [origin, destination, userLocation]);

  function getRouteModeLabel(modeName: string, fallback: boolean): string {
    const m = (modeName || "driving").toLowerCase();
    if (fallback) {
      if (m === "walking") return "⚠️ Estimated corridor (walking) · Path approximate";
      if (m === "transit") return "⚠️ Estimated corridor (transit) · Route approximate";
      return "⚠️ Estimated corridor (driving) · Road routing unavailable";
    }
    if (m === "walking") return "✓ Walking route (OSRM)";
    if (m === "transit") return "✓ Estimated Transit Route";
    return "✓ Driving route (OSRM)";
  }

  function renderMapAttribution(theme: MapTheme, isCanvasFallback: boolean) {
    if (theme === "streets" && !isCanvasFallback) {
      return (
        <span className="route-map-attribution-text">
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style={{ pointerEvents: "auto", color: "inherit", textDecoration: "underline" }}>OpenStreetMap</a> contributors · <a href="https://openfreemap.org" target="_blank" rel="noopener noreferrer" style={{ pointerEvents: "auto", color: "inherit", textDecoration: "underline" }}>OpenFreeMap</a>
        </span>
      );
    }
    return (
      <span className="route-map-attribution-text">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style={{ pointerEvents: "auto", color: "inherit", textDecoration: "underline" }}>OpenStreetMap</a> contributors · <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer" style={{ pointerEvents: "auto", color: "inherit", textDecoration: "underline" }}>CARTO</a>
      </span>
    );
  }

  // Switch Map Style (Streets / Retina Voyager / Dark)
  const handleStyleChange = useCallback((newTheme: MapTheme) => {
    setMapTheme(newTheme);
    const map = mapInstanceRef.current;
    if (!map) return;

    // 1. Explicitly invalidate and clean up any ongoing style transition
    if (activeStyleCleanupRef.current) {
      activeStyleCleanupRef.current();
      activeStyleCleanupRef.current = null;
    }

    const requestId = ++styleRequestIdRef.current;
    setStyleLoading(true);

    let targetStyle: any = OPENFREEMAP_BRIGHT;
    if (newTheme === "voyager") targetStyle = CARTO_VOYAGER_STYLE;
    else if (newTheme === "dark") targetStyle = CARTO_DARK_STYLE;

    let finished = false;
    let requestTimerId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      map.off("style.load", onStyleLoad);
      map.off("error", onMapError);
      if (requestTimerId) {
        clearTimeout(requestTimerId);
        if (styleTimeoutTimerRef.current === requestTimerId) {
          styleTimeoutTimerRef.current = null;
        }
        requestTimerId = null;
      }
      if (activeStyleCleanupRef.current === cleanup) {
        activeStyleCleanupRef.current = null;
      }
    };

    activeStyleCleanupRef.current = cleanup;

    const onStyleLoad = () => {
      if (finished) return;
      cleanup();
      // Ensure only the latest requested style applies
      if (styleRequestIdRef.current !== requestId) return;

      setStyleLoading(false);
      const currentMap = mapInstanceRef.current;
      if (!currentMap) return;
      updateMapRouteLayers(currentMap);
      if (maplibreglRef.current) {
        updateMapMarkers(currentMap, maplibreglRef.current);
      }
    };

    const onMapError = (e: any) => {
      if (finished) return;
      // Do not let unrelated tile/sprite 404s prematurely clear style loading.
      // Only abort on genuine style compilation/source failures.
      const isStyleError =
        e &&
        e.error &&
        (e.dataType === "style" ||
          e.sourceId === "style" ||
          (typeof e.error.message === "string" && e.error.message.toLowerCase().includes("style")));

      if (isStyleError) {
        cleanup();
        if (styleRequestIdRef.current === requestId) {
          console.warn("Genuine style load error:", e.error);
          setStyleLoading(false);
        }
      }
    };

    // Failsafe timer to clear loading indicator if network fails completely without emitting style error
    requestTimerId = setTimeout(() => {
      if (!finished && styleRequestIdRef.current === requestId) {
        cleanup();
        console.warn("Style loading timeout reached for theme:", newTheme);
        setStyleLoading(false);
      }
    }, 6000);
    styleTimeoutTimerRef.current = requestTimerId;

    map.on("style.load", onStyleLoad);
    map.on("error", onMapError);

    try {
      map.setStyle(targetStyle);
    } catch (err) {
      cleanup();
      setStyleLoading(false);
      console.warn("Synchronous setStyle error for theme:", newTheme, err);
    }
  }, [updateMapRouteLayers, updateMapMarkers]);

  // Primary Initialization: MapLibre GL JS
  useEffect(() => {
    let isMounted = true;
    let styleTimeoutId: ReturnType<typeof setTimeout> | null = null;

    async function initMap() {
      if (!mapContainerRef.current) return;

      try {
        const maplibreglModule: any = await import("maplibre-gl");
        if (!isMounted || !mapContainerRef.current) return;

        const maplibregl = maplibreglModule.default || maplibreglModule;
        maplibreglRef.current = maplibregl;

        if (!maplibregl.supported || !maplibregl.supported()) {
          console.warn("WebGL not supported in browser environment, falling back to Canvas tile renderer.");
          if (isMounted) setUseCanvasFallback(true);
          return;
        }

        const initialCenter: [number, number] = destination
          ? [destination.lng, destination.lat]
          : origin
          ? [origin.lng, origin.lat]
          : [77.2295, 28.6129]; // Default: New Delhi

        // Initialize MapLibre instance with OpenFreeMap Bright (with timeout fallback to CARTO Voyager)
        const map = new maplibregl.Map({
          container: mapContainerRef.current,
          style: OPENFREEMAP_BRIGHT,
          center: initialCenter,
          zoom: 13,
          attributionControl: false,
        });

        // Store immediately so map is accessible to cleanup even if unmounted before "load"
        mapInstanceRef.current = map;

        // Fallback to CARTO Voyager if vector style encounters network issues
        let styleLoaded = false;
        styleTimeoutId = setTimeout(() => {
          if (!isMounted || !mapInstanceRef.current || styleLoaded) return;
          console.warn("Vector style load timeout, falling back to CARTO Voyager style.");
          try {
            mapInstanceRef.current.setStyle(CARTO_VOYAGER_STYLE);
          } catch (err) {
            console.warn("Error applying fallback style:", err);
          }
        }, 3500);

        map.once("load", () => {
          styleLoaded = true;
          if (styleTimeoutId) {
            clearTimeout(styleTimeoutId);
            styleTimeoutId = null;
          }
          if (!isMounted) return;

          setMapReady(true);
          updateMapRouteLayers(map);
          updateMapMarkers(map, maplibregl);
          fitBounds();
        });

        map.on("error", (e: any) => {
          console.warn("MapLibre GL internal warning/error:", e?.error?.message || e);
        });

      } catch (err) {
        console.warn("MapLibre initialization failed, falling back to Canvas renderer:", err);
        if (isMounted) setUseCanvasFallback(true);
      }
    }

    initMap();

    return () => {
      isMounted = false;
      if (styleTimeoutId) {
        clearTimeout(styleTimeoutId);
        styleTimeoutId = null;
      }
      if (activeStyleCleanupRef.current) {
        activeStyleCleanupRef.current();
        activeStyleCleanupRef.current = null;
      }
      if (styleTimeoutTimerRef.current) {
        clearTimeout(styleTimeoutTimerRef.current);
        styleTimeoutTimerRef.current = null;
      }
      if (originMarkerRef.current) {
        originMarkerRef.current.remove();
        originMarkerRef.current = null;
      }
      if (destMarkerRef.current) {
        destMarkerRef.current.remove();
        destMarkerRef.current = null;
      }
      if (userMarkerRef.current) {
        userMarkerRef.current.remove();
        userMarkerRef.current = null;
      }
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Sync route and markers when props change
  useEffect(() => {
    if (!mapReady || useCanvasFallback) return;
    const map = mapInstanceRef.current;
    if (map) {
      updateMapRouteLayers(map);
      if (maplibreglRef.current) {
        updateMapMarkers(map, maplibreglRef.current);
      }
      fitBounds();
    }
  }, [mapReady, useCanvasFallback, geometry, isFallback, origin, destination, userLocation, updateMapRouteLayers, updateMapMarkers, fitBounds]);

  // ==========================================
  // Canvas Fallback Render Engine (resilient mode)
  // ==========================================
  const scheduleRedrawRef = useRef<() => void>(() => {});

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !useCanvasFallback) return;
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

    const { center: currentCenter, zoom: currentZoom } = canvasViewRef.current;

    // Background fill
    ctx.fillStyle = mapTheme === "dark" ? "#1e242b" : "#fdfbf7";
    ctx.fillRect(0, 0, width, height);

    const centerTileX = lngToTileX(currentCenter.lng, currentZoom);
    const centerTileY = latToTileY(currentCenter.lat, currentZoom);
    const centerPixelX = centerTileX * 256;
    const centerPixelY = centerTileY * 256;

    const screenToWorld = (screenX: number, screenY: number) => ({
      worldX: centerPixelX + (screenX - width / 2),
      worldY: centerPixelY + (screenY - height / 2),
    });

    const worldToScreen = (worldX: number, worldY: number) => ({
      screenX: width / 2 + (worldX - centerPixelX),
      screenY: height / 2 + (worldY - centerPixelY),
    });

    const coordToScreen = (lat: number, lng: number) => {
      const tileX = lngToTileX(lng, currentZoom);
      const tileY = latToTileY(lat, currentZoom);
      return worldToScreen(tileX * 256, tileY * 256);
    };

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

    // 1. Draw High-Res Retina Tiles (CARTO Voyager or Dark)
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        if (ty < 0 || ty >= numTiles) continue;
        const normalizedTx = ((tx % numTiles) + numTiles) % numTiles;
        const sub = ["a", "b", "c"][Math.abs(normalizedTx + ty) % 3];
        const tileKey = `${mapTheme}/${intZoom}/${normalizedTx}/${ty}`;
        const tileUrl =
          mapTheme === "dark"
            ? `https://${sub}.basemaps.cartocdn.com/dark_all/${intZoom}/${normalizedTx}/${ty}@2x.png`
            : `https://${sub}.basemaps.cartocdn.com/rastertiles/voyager/${intZoom}/${normalizedTx}/${ty}@2x.png`;

        const tileWorldX = tx * 256 * scaleFactor;
        const tileWorldY = ty * 256 * scaleFactor;
        const { screenX, screenY } = worldToScreen(tileWorldX, tileWorldY);
        const tileSize = 256 * scaleFactor;

        let img = tileCache.get(tileKey);
        if (!img) {
          img = new Image();
          img.crossOrigin = "anonymous";
          img.src = tileUrl;
          img.onload = () => scheduleRedrawRef.current();
          tileCache.set(tileKey, img);
        }

        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, screenX, screenY, tileSize, tileSize);
        } else {
          ctx.strokeStyle = mapTheme === "dark" ? "#2a3441" : "#e5dfd3";
          ctx.lineWidth = 1;
          ctx.strokeRect(screenX, screenY, tileSize, tileSize);
        }
      }
    }

    // 2. Draw Route Polyline
    if (geometry && geometry.length > 1) {
      const screenPoints = geometry.map(([lng, lat]) => coordToScreen(lat, lng));

      // Outer Casing
      ctx.beginPath();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = isFallback ? 7 : 9;
      ctx.strokeStyle = isFallback ? "#78350f" : "#ffffff";
      screenPoints.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.screenX, pt.screenY);
        else ctx.lineTo(pt.screenX, pt.screenY);
      });
      ctx.stroke();

      // Core Line
      ctx.beginPath();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (isFallback) {
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = "#d97706";
      } else {
        ctx.setLineDash([]);
        ctx.lineWidth = 5.5;
        ctx.strokeStyle = "#1a73e8";
      }

      screenPoints.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.screenX, pt.screenY);
        else ctx.lineTo(pt.screenX, pt.screenY);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 3. Draw Origin Pin
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) {
      const { screenX, screenY } = coordToScreen(origin.lat, origin.lng);
      ctx.fillStyle = "rgba(42, 33, 28, 0.3)";
      ctx.beginPath();
      ctx.ellipse(screenX, screenY + 2, 7, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#15803d";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY - 13, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#15803d";
      ctx.beginPath();
      ctx.moveTo(screenX - 5, screenY - 4);
      ctx.lineTo(screenX + 5, screenY - 4);
      ctx.lineTo(screenX, screenY);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("A", screenX, screenY - 13);
    }

    // 4. Draw Destination Pin
    if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
      const { screenX, screenY } = coordToScreen(destination.lat, destination.lng);
      ctx.fillStyle = "rgba(42, 33, 28, 0.35)";
      ctx.beginPath();
      ctx.ellipse(screenX, screenY + 2, 8, 4, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#80011f";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY - 14, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#80011f";
      ctx.beginPath();
      ctx.moveTo(screenX - 6, screenY - 4);
      ctx.lineTo(screenX + 6, screenY - 4);
      ctx.lineTo(screenX, screenY);
      ctx.closePath();
      ctx.fill();

      // Hospital Cross
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(screenX - 1.5, screenY - 14 - 4, 3, 8);
      ctx.fillRect(screenX - 4, screenY - 14 - 1.5, 8, 3);
    }

    // 5. Draw GPS User Location
    if (userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)) {
      const { screenX, screenY } = coordToScreen(userLocation.lat, userLocation.lng);
      ctx.fillStyle = "rgba(26, 115, 232, 0.25)";
      ctx.beginPath();
      ctx.arc(screenX, screenY, 15, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#1a73e8";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(screenX, screenY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }, [useCanvasFallback, mapTheme, geometry, isFallback, origin, destination, userLocation]);

  const rafIdRef = useRef<number | null>(null);

  const scheduleCanvasRedraw = useCallback(() => {
    if (!useCanvasFallback) return;
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      renderCanvas();
    });
  }, [useCanvasFallback, renderCanvas]);

  scheduleRedrawRef.current = scheduleCanvasRedraw;

  // Handle ResizeObserver for Canvas
  useEffect(() => {
    if (!useCanvasFallback) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      scheduleCanvasRedraw();
    });
    ro.observe(canvas);

    return () => {
      ro.disconnect();
    };
  }, [useCanvasFallback, scheduleCanvasRedraw]);

  // Trigger canvas redraw on dependency changes
  useEffect(() => {
    if (useCanvasFallback) {
      scheduleCanvasRedraw();
    }
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [
    useCanvasFallback,
    scheduleCanvasRedraw,
    canvasCenter,
    canvasZoom,
    geometry,
    isFallback,
    origin,
    destination,
    userLocation,
    mapTheme,
  ]);

  // Pointer drag and zoom handlers for Canvas fallback
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

    const currentCenter = canvasViewRef.current.center;
    const currentZoom = canvasViewRef.current.zoom;
    const currentTileX = lngToTileX(currentCenter.lng, currentZoom);
    const currentTileY = latToTileY(currentCenter.lat, currentZoom);
    const newTileX = currentTileX - dx / 256;
    const newTileY = currentTileY - dy / 256;

    const newLng = tileXToLng(newTileX, currentZoom);
    const newLat = tileYToLat(newTileY, currentZoom);

    canvasViewRef.current = {
      center: { lat: newLat, lng: newLng },
      zoom: currentZoom,
    };
    setCanvasCenter({
      lat: newLat,
      lng: newLng,
    });
    scheduleCanvasRedraw();
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

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomDelta = e.deltaY < 0 ? 0.35 : -0.35;
    const nextZoom = Math.min(18, Math.max(3, canvasViewRef.current.zoom + zoomDelta));
    canvasViewRef.current = {
      center: canvasViewRef.current.center,
      zoom: nextZoom,
    };
    setCanvasZoom(nextZoom);
    scheduleCanvasRedraw();
  };

  // Zoom and Pan UI buttons
  const handleZoomIn = () => {
    if (mapInstanceRef.current && !useCanvasFallback) {
      mapInstanceRef.current.zoomIn();
    } else {
      setCanvasZoom((z) => Math.min(18, z + 1));
    }
  };

  const handleZoomOut = () => {
    if (mapInstanceRef.current && !useCanvasFallback) {
      mapInstanceRef.current.zoomOut();
    } else {
      setCanvasZoom((z) => Math.max(3, z - 1));
    }
  };

  const handleCenterUser = () => {
    if (!userLocation) return;
    if (mapInstanceRef.current && !useCanvasFallback) {
      mapInstanceRef.current.flyTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 15,
        duration: 800,
      });
    } else {
      setCanvasCenter({ lat: userLocation.lat, lng: userLocation.lng });
      setCanvasZoom(15);
    }
  };

  const hasEndpoints = Boolean(origin && destination);

  return (
    <div
      className={`route-map-container ${className}`}
      style={{ height, position: "relative" }}
      aria-label="Interactive Navigation Road Map"
    >
      {/* Primary MapLibre Vector/Raster Map Container */}
      {!useCanvasFallback ? (
        <div
          ref={mapContainerRef}
          style={{ width: "100%", height: "100%" }}
          className="route-map-gl-canvas"
        />
      ) : (
        /* Resilient Fallback Canvas */
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
        />
      )}

      {/* Google Maps-Style Floating Route HUD */}
      {hasEndpoints && (
        <div className="route-map-hud" role="region" aria-label="Route Overview Summary">
          <div className="route-map-hud-content">
            <div className="route-map-hud-primary">
              {durationMinutes !== undefined && (
                <span className="route-map-hud-time num">
                  {durationMinutes >= 60
                    ? `${Math.floor(durationMinutes / 60)} hr ${durationMinutes % 60} min`
                    : `${durationMinutes} min`}
                </span>
              )}
              {distanceKm !== undefined && (
                <span className="route-map-hud-dist num">({distanceKm} km)</span>
              )}
            </div>
            <div className="route-map-hud-badge-row">
              {isFallback ? (
                <span className="route-map-badge-fallback">
                  {getRouteModeLabel(mode, true)}
                </span>
              ) : (
                <span className="route-map-badge-live">
                  {getRouteModeLabel(mode, false)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fallback Explicit Warning Banner */}
      {isFallback && hasEndpoints && (
        <div className="route-map-fallback-banner" role="alert">
          <span style={{ fontWeight: 700 }}>⚠️ Estimated Projection:</span>
          <span className="route-map-fallback-sub">
            Showing straight-line corridor {fallbackReason ? `(${fallbackReason})` : ""}. Actual road turns are approximate.
          </span>
        </div>
      )}

      {/* Navigation Controls (Right-side toolbar) */}
      <div className="route-map-controls" role="toolbar" aria-label="Map Controls">
        <button
          type="button"
          className="route-map-btn"
          onClick={handleZoomIn}
          title="Zoom In"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="route-map-btn"
          onClick={handleZoomOut}
          title="Zoom Out"
          aria-label="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="route-map-btn"
          onClick={fitBounds}
          title="Fit Route to View"
          aria-label="Fit entire route bounds"
        >
          ⛶
        </button>
        {userLocation && (
          <button
            type="button"
            className="route-map-btn"
            onClick={handleCenterUser}
            title="My GPS Location"
            aria-label="Center on my location"
          >
            🎯
          </button>
        )}
        <button
          type="button"
          className="route-map-btn route-map-btn-theme"
          disabled={styleLoading}
          onClick={() => {
            if (styleLoading) return;
            const nextTheme = mapTheme === "streets" ? "voyager" : mapTheme === "voyager" ? "dark" : "streets";
            handleStyleChange(nextTheme);
          }}
          title={`Switch map style (Current: ${mapTheme}${styleLoading ? " - loading..." : ""})`}
          aria-label={`Switch map style. Current theme is ${mapTheme}.${styleLoading ? " Loading new style." : ""}`}
        >
          {styleLoading ? "⏳" : mapTheme === "dark" ? "🌙" : mapTheme === "voyager" ? "🗺️" : "☀️"}
        </button>
      </div>

      {/* Accessible Map Style Loading Indicator */}
      {styleLoading && (
        <div
          role="status"
          aria-live="polite"
          aria-label="Updating map style"
          style={{
            position: "absolute",
            top: 14,
            right: 58,
            backgroundColor: "rgba(255, 252, 239, 0.96)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            border: "1px solid var(--rule-strong)",
            borderRadius: "var(--radius)",
            padding: "6px 12px",
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--ink)",
            boxShadow: "0 2px 10px rgba(42, 33, 28, 0.14)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            zIndex: 12,
            pointerEvents: "none",
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: 12,
              height: 12,
              border: "2px solid var(--rule-strong)",
              borderTopColor: "var(--burgundy)",
              borderRadius: "50%",
              animation: "ai-spin 0.8s linear infinite",
            }}
            aria-hidden="true"
          />
          <span>Loading {mapTheme} map...</span>
        </div>
      )}

      {/* Map Legend & Legal Attribution (Bottom-right badge) */}
      <footer
        className="route-map-legend"
        role="contentinfo"
        aria-label="Map route legend and map tile provider attribution"
        style={{ pointerEvents: "auto" }}
      >
        {isFallback ? (
          <span style={{ color: "#d97706", fontWeight: 600 }}>┄┄ Estimated Corridor</span>
        ) : (
          <span style={{ color: "#1a73e8", fontWeight: 600 }}>
            ━━ {mode === "walking" ? "OSRM Walking Path" : mode === "transit" ? "Estimated Transit Route" : "OSRM Road Route"}
          </span>
        )}
        <span className="muted">·</span>
        {renderMapAttribution(mapTheme, useCanvasFallback)}
      </footer>
    </div>
  );
}
