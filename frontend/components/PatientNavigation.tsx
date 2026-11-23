"use client";

import { useEffect, useState, useTransition } from "react";
import {
  api,
  fetchRoute,
  type NavigationMode,
  type Place,
  type RouteResponse,
} from "@/lib/api";
import { useLang } from "@/lib/i18n";
import { RouteMap } from "./RouteMap";

export type NavOrigin = {
  lat: number;
  lng: number;
  label: string;
};

interface PatientNavigationProps {
  initialOrigin?: NavOrigin | null;
  initialDestination?: Place | null;
  initialMode?: NavigationMode;
}

function formatManeuverIcon(type: string, modifier?: string | null): string {
  const t = (type || "").toLowerCase();
  const m = (modifier || "").toLowerCase();
  if (t === "arrive") return "🏁";
  if (t === "depart") return "↗️";
  if (t === "roundabout" || t === "rotary") return "🔄";
  if (t === "fork") return "⑂";
  if (m.includes("left")) return "⬅️";
  if (m.includes("right")) return "➡️";
  if (m.includes("straight") || t === "continue" || t === "new name") return "⬆️";
  return "➔";
}

function formatStepDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatStepDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "< 1 min";
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""}`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} min` : `${hrs} hr`;
}

export function PatientNavigation({
  initialOrigin = null,
  initialDestination = null,
  initialMode = "driving",
}: PatientNavigationProps) {
  const { t } = useLang();

  // Route calculation state
  const [origin, setOrigin] = useState<NavOrigin | null>(initialOrigin);
  const [destination, setDestination] = useState<Place | null>(initialDestination);
  const [mode, setMode] = useState<NavigationMode>(initialMode);
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Origin search & location state
  const [originEditing, setOriginEditing] = useState<boolean>(!initialOrigin);
  const [originQuery, setOriginQuery] = useState("");
  const [originResults, setOriginResults] = useState<Place[] | null>(null);
  const [originBusy, setOriginBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locDenied, setLocDenied] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);

  // Destination search & suggestions state
  const [destEditing, setDestEditing] = useState<boolean>(!initialDestination);
  const [destQuery, setDestQuery] = useState("");
  const [destResults, setDestResults] = useState<Place[] | null>(null);
  const [nearbyHospitals, setNearbyHospitals] = useState<Place[]>([]);
  const [destBusy, setDestBusy] = useState(false);

  const [, startTransition] = useTransition();

  // Debounced Origin Search
  useEffect(() => {
    const q = originQuery.trim();
    if (q.length < 2) {
      setOriginResults(null);
      return;
    }
    let active = true;
    setOriginBusy(true);
    const id = setTimeout(async () => {
      try {
        const res = await api<Place[]>(`/api/places/search?q=${encodeURIComponent(q)}`);
        if (active) setOriginResults(res);
      } catch {
        if (active) setOriginResults([]);
      } finally {
        if (active) setOriginBusy(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [originQuery]);

  // Debounced Destination Search
  useEffect(() => {
    const q = destQuery.trim();
    if (q.length < 2) {
      setDestResults(null);
      return;
    }
    let active = true;
    setDestBusy(true);
    const near = origin ? `&lat=${origin.lat}&lng=${origin.lng}` : "";
    const id = setTimeout(async () => {
      try {
        const res = await api<Place[]>(`/api/places/search?q=${encodeURIComponent(q)}${near}`);
        if (active) setDestResults(res);
      } catch {
        if (active) setDestResults([]);
      } finally {
        if (active) setDestBusy(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(id);
    };
  }, [destQuery, origin]);

  // Load nearby hospitals when origin changes
  useEffect(() => {
    if (!origin) return;
    let active = true;
    api<Place[]>(`/api/places/nearby-hospitals?lat=${origin.lat}&lng=${origin.lng}`)
      .then((res) => {
        if (active) setNearbyHospitals(res);
      })
      .catch(() => {
        if (active) setNearbyHospitals([]);
      });
    return () => {
      active = false;
    };
  }, [origin]);

  // Geolocation trigger
  function handleUseMyLocation() {
    if (!("geolocation" in navigator)) {
      setLocDenied(true);
      return;
    }
    setLocating(true);
    setLocDenied(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const uLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(uLoc);
        const newOrigin: NavOrigin = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: "Current location (GPS)",
        };
        setOrigin(newOrigin);
        setOriginEditing(false);
      },
      () => {
        setLocating(false);
        setLocDenied(true);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  // Fetch Route when origin, destination, or mode changes
  useEffect(() => {
    if (!origin || !destination) {
      setRoute(null);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    fetchRoute(origin.lat, origin.lng, destination.lat, destination.lng, mode)
      .then((res) => {
        if (active) {
          startTransition(() => {
            setRoute(res);
            setLoading(false);
          });
        }
      })
      .catch((err: Error) => {
        if (active) {
          setError(err.message || "Failed to calculate navigation route. Please check coordinates and retry.");
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [origin, destination, mode]);

  // Format total duration
  function formatTotalDuration(mins: number): string {
    if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""}`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }

  return (
    <div className="narrow stack" style={{ ["--gap" as string]: "20px" }}>
      {/* Title & Description */}
      <div>
        <h1 className="h1">{t("nav_title")}</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>
          {t("nav_subtitle")}
        </p>
      </div>

      {/* Starting Location Field */}
      <div className="field">
        <span className="label">{t("nav_origin")}</span>
        {origin && !originEditing ? (
          <div className="sheet row" style={{ padding: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>📍 {origin.label}</div>
              <div className="small muted num">
                {origin.lat.toFixed(4)}°, {origin.lng.toFixed(4)}°
              </div>
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="linkbtn small"
              onClick={() => setOriginEditing(true)}
            >
              {t("nav_change_origin")}
            </button>
          </div>
        ) : (
          <div className="stack" style={{ ["--gap" as string]: "10px" }}>
            <div className="row">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleUseMyLocation}
                disabled={locating}
              >
                {locating ? t("locating") : t("use_location")}
              </button>
              {origin && (
                <button
                  type="button"
                  className="linkbtn small"
                  onClick={() => setOriginEditing(false)}
                >
                  Cancel
                </button>
              )}
            </div>

            {locDenied && (
              <p className="note" role="status">
                {t("loc_denied")}
              </p>
            )}

            <input
              className="input"
              type="search"
              placeholder={t("search_ph")}
              value={originQuery}
              onChange={(e) => setOriginQuery(e.target.value)}
              autoComplete="off"
            />

            {originResults && originResults.length === 0 && !originBusy && (
              <p className="muted small">{t("no_results")}</p>
            )}

            {originResults && originResults.length > 0 && (
              <ul className="choices">
                {originResults.map((p, i) => (
                  <li key={`origin-${p.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setOrigin({ lat: p.lat, lng: p.lng, label: p.name });
                        setOriginEditing(false);
                        setOriginQuery("");
                      }}
                    >
                      <span className="t">{p.name}</span>
                      {p.address && <span className="s">{p.address}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Destination Hospital Field */}
      <div className="field">
        <span className="label">{t("nav_destination")}</span>
        {destination && !destEditing ? (
          <div className="sheet row" style={{ padding: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>🏥 {destination.name}</div>
              {destination.address && (
                <div className="small muted">{destination.address}</div>
              )}
            </div>
            <span className="spacer" />
            <button
              type="button"
              className="linkbtn small"
              onClick={() => setDestEditing(true)}
            >
              {t("nav_change_dest")}
            </button>
          </div>
        ) : (
          <div className="stack" style={{ ["--gap" as string]: "10px" }}>
            <input
              className="input"
              type="search"
              placeholder={t("nav_choose_hospital")}
              value={destQuery}
              onChange={(e) => setDestQuery(e.target.value)}
              autoComplete="off"
            />

            {destination && (
              <div>
                <button
                  type="button"
                  className="linkbtn small"
                  onClick={() => setDestEditing(false)}
                >
                  Cancel
                </button>
              </div>
            )}

            {destResults && destResults.length === 0 && !destBusy && (
              <p className="muted small">{t("no_results")}</p>
            )}

            {/* Suggestions: either search results or nearby hospitals */}
            {(destResults || nearbyHospitals).length > 0 && (
              <ul className="choices">
                {(destResults || nearbyHospitals).map((p, i) => (
                  <li key={`dest-${p.name}-${i}`}>
                    <button
                      type="button"
                      aria-pressed={destination?.name === p.name}
                      onClick={() => {
                        setDestination(p);
                        setDestEditing(false);
                        setDestQuery("");
                      }}
                    >
                      <span className="t">{p.name}</span>
                      {p.address && <span className="s">{p.address}</span>}
                      {p.distance_km !== undefined && (
                        <span className="d num">{p.distance_km} km</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Travel Mode Selector */}
      <div className="field">
        <span className="label">Mode of Travel</span>
        <div className="seg" role="group" aria-label="Travel mode">
          <button
            type="button"
            aria-pressed={mode === "driving"}
            onClick={() => setMode("driving")}
          >
            🚗 {t("nav_mode_driving")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "walking"}
            onClick={() => setMode("walking")}
          >
            🚶 {t("nav_mode_walking")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "transit"}
            onClick={() => setMode("transit")}
          >
            🚌 {t("nav_mode_transit")}
          </button>
        </div>
      </div>

      {/* Loading Indicator */}
      {loading && (
        <div className="sheet" style={{ textAlign: "center", padding: "28px 18px" }}>
          <div className="ai-assistant-btn-spin" style={{ margin: "0 auto 12px", width: 24, height: 24 }} />
          <p className="muted" style={{ margin: 0 }}>
            {t("nav_calculating")}
          </p>
        </div>
      )}

      {/* Error Message */}
      {error && !loading && (
        <div className="note" role="alert" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 20 }}>⚠️</span>
          <div style={{ flex: 1 }}>{error}</div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              if (origin && destination) {
                setLoading(true);
                setError(null);
                fetchRoute(origin.lat, origin.lng, destination.lat, destination.lng, mode)
                  .then(setRoute)
                  .catch((e) => setError(e.message))
                  .finally(() => setLoading(false));
              }
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Onboarding State: Prompt to select both endpoints */}
      {!origin || !destination ? (
        <div className="sheet stack" style={{ textAlign: "center", padding: "32px 20px" }}>
          <div style={{ fontSize: 40, margin: "0 auto" }}>🗺️</div>
          <h2 className="h2" style={{ fontSize: 20 }}>Ready for directions</h2>
          <p className="muted" style={{ margin: 0 }}>
            {t("nav_no_route")}
          </p>
        </div>
      ) : null}

      {/* Route Display Section */}
      {route && !loading && !error && (
        <div className="stack" style={{ ["--gap" as string]: "18px" }}>
          {/* Interactive Route Map */}
          <RouteMap
            origin={origin}
            destination={destination}
            geometry={route.geometry}
            isFallback={route.is_fallback}
            fallbackReason={route.fallback_reason}
            userLocation={userLocation}
            height={380}
          />

          {/* Source Authentication Badge & Summary */}
          <div className="row" style={{ justifyContent: "space-between" }}>
            {route.is_fallback ? (
              <span className="nav-badge-fallback">
                ⚠️ Estimated Corridor (Fallback: {route.fallback_reason || "Offline"})
              </span>
            ) : (
              <span className="nav-badge-live">
                ✓ {t("nav_live_osrm")} (OSRM)
              </span>
            )}
            <span className="small muted">{route.summary}</span>
          </div>

          {/* Fallback Warning Box */}
          {route.is_fallback && (
            <div className="note" role="alert">
              <strong>Estimated Route: </strong>
              {t("nav_fallback_alert")}
              {route.fallback_reason ? ` (${route.fallback_reason})` : ""}
            </div>
          )}

          {/* Quick Metrics Grid */}
          <div className="nav-stat-grid">
            <div className="nav-stat-card">
              <span className="nav-stat-label">{t("nav_distance")}</span>
              <span className="nav-stat-val num">{route.distance_km} km</span>
            </div>
            <div className="nav-stat-card">
              <span className="nav-stat-label">{t("nav_est_time")}</span>
              <span className="nav-stat-val num">
                {formatTotalDuration(route.duration_minutes)}
              </span>
            </div>
            <div className="nav-stat-card">
              <span className="nav-stat-label">Mode</span>
              <span className="nav-stat-val" style={{ fontSize: 20 }}>
                {mode === "driving" ? "🚗 Driving" : mode === "walking" ? "🚶 Walking" : "🚌 Transit"}
              </span>
            </div>
          </div>

          {/* Turn-by-turn Step Directions */}
          <div className="stack" style={{ ["--gap" as string]: "10px", marginTop: 8 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 className="h3">{t("nav_steps")}</h2>
              <span className="small muted num">{route.steps.length} steps</span>
            </div>

            <ol className="nav-step-list">
              {route.steps.map((st, i) => (
                <li key={`step-${i}`} className="nav-step-item">
                  <div className="nav-step-icon" aria-hidden="true">
                    {formatManeuverIcon(st.maneuver_type, st.modifier)}
                  </div>
                  <div className="nav-step-details">
                    <div className="nav-step-instruction">{st.instruction}</div>
                    <div className="nav-step-meta num">
                      <span>{formatStepDistance(st.distance_m)}</span>
                      <span>·</span>
                      <span>{formatStepDuration(st.duration_s)}</span>
                      {st.name && <span className="nav-step-road">{st.name}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

