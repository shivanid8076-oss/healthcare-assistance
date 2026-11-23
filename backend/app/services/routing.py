"""Patient Navigation routing service.

Uses public Open Source Routing Machine (OSRM) driving and walking profiles,
with an offline/timeout mathematical fallback based on Haversine distance and city transit speeds.
Never raises exceptions to callers; always returns a valid, structured route.
"""
import logging
import math
import httpx

from ..core.geo import bearing_deg, haversine_km, travel_minutes

log = logging.getLogger("raktdoot.routing")

OSRM_BASE_URL = "https://router.project-osrm.org"
OSRM_TIMEOUT_SECONDS = 5.0
OSRM_HEADERS = {
    "User-Agent": "RaktDoot/1.0 (hackathon project; emergency blood finder & patient navigation)"
}

DIRECTIONS = [
    (337.5, 360.0, "North"),
    (0.0, 22.5, "North"),
    (22.5, 67.5, "North-East"),
    (67.5, 112.5, "East"),
    (112.5, 157.5, "South-East"),
    (157.5, 202.5, "South"),
    (202.5, 247.5, "South-West"),
    (247.5, 292.5, "West"),
    (292.5, 337.5, "North-West"),
]


def _compass_name(bearing: float) -> str:
    b = bearing % 360
    for low, high, name in DIRECTIONS:
        if low <= b <= high:
            return name
    return "North"


def _format_maneuver(maneuver: dict, road_name: str | None) -> str:
    m_type = maneuver.get("type", "turn")
    modifier = maneuver.get("modifier", "")
    name = (road_name or "").strip()

    if m_type == "depart":
        return f"Head {modifier or 'forward'} on {name}" if name else "Head forward on the road"
    elif m_type == "arrive":
        return "Arrive at destination hospital"
    elif m_type == "roundabout" or m_type == "rotary":
        return f"Take roundabout toward {name}" if name else "Take roundabout exit"
    elif m_type == "fork":
        return f"Keep {modifier or 'ahead'} at the fork onto {name}" if name else "Keep ahead at the fork"
    elif m_type in ("new name", "continue"):
        return f"Continue on {name}" if name else "Continue straight"
    elif m_type == "end of road":
        return f"Turn {modifier or 'ahead'} at the end of the road onto {name}" if name else "Turn at the end of the road"
    else:
        # Standard turn
        if modifier:
            return f"Turn {modifier} onto {name}" if name else f"Turn {modifier}"
        return f"Turn onto {name}" if name else "Turn toward destination"


def _build_estimated_fallback(
    from_lat: float,
    from_lng: float,
    to_lat: float,
    to_lng: float,
    mode: str,
    reason: str,
) -> dict:
    """Generate high-quality estimated route when OSRM is unreachable or times out."""
    direct_km = haversine_km(from_lat, from_lng, to_lat, to_lng)

    # Road network detour factor in Indian urban areas (~1.25x - 1.30x direct distance)
    road_km = round(direct_km * 1.28, 2)
    bearing = bearing_deg(from_lat, from_lng, to_lat, to_lng)
    compass = _compass_name(bearing)

    if mode == "walking":
        # ~4.5 km/h walking speed
        duration_mins = max(1, round((road_km / 4.5) * 60))
    elif mode == "transit":
        # ~18 km/h transit speed + 8 min transfer/wait overhead
        duration_mins = max(5, round((road_km / 18) * 60) + 8)
    else:
        # Driving: city traffic speed ~22 km/h
        duration_mins = max(1, travel_minutes(road_km))

    # Generate interpolated coordinate corridor (start, waypoints, end)
    steps_count = 6
    geometry = []
    for i in range(steps_count + 1):
        fraction = i / steps_count
        interp_lat = from_lat + (to_lat - from_lat) * fraction
        interp_lng = from_lng + (to_lng - from_lng) * fraction
        geometry.append([round(interp_lng, 6), round(interp_lat, 6)])

    steps = [
        {
            "instruction": f"Head {compass} along the main corridor toward hospital",
            "distance_m": round(road_km * 250, 1),
            "duration_s": round((duration_mins * 60) * 0.25, 1),
            "maneuver_type": "depart",
            "modifier": "straight",
            "name": f"Corridor heading {compass}",
        },
        {
            "instruction": "Continue along primary road toward hospital area",
            "distance_m": round(road_km * 600, 1),
            "duration_s": round((duration_mins * 60) * 0.60, 1),
            "maneuver_type": "continue",
            "modifier": "straight",
            "name": "Main Road",
        },
        {
            "instruction": "Turn toward hospital entrance and arrive at emergency gate",
            "distance_m": round(road_km * 150, 1),
            "duration_s": round((duration_mins * 60) * 0.15, 1),
            "maneuver_type": "arrive",
            "modifier": "straight",
            "name": "Hospital Gate",
        },
    ]

    return {
        "source": "estimated",
        "is_fallback": True,
        "fallback_reason": reason,
        "distance_km": road_km,
        "duration_minutes": duration_mins,
        "mode": mode,
        "origin": {"lat": from_lat, "lng": from_lng},
        "destination": {"lat": to_lat, "lng": to_lng},
        "geometry": geometry,
        "steps": steps,
        "summary": f"Estimated {mode} corridor via {compass} ({road_km} km)",
    }


def get_route(
    from_lat: float,
    from_lng: float,
    to_lat: float,
    to_lng: float,
    mode: str = "driving",
) -> dict:
    """Calculate road route between two points using OSRM or mathematical fallback.

    Returns a comprehensive dict guaranteed to have all route fields.
    """
    mode = mode.lower().strip()
    if mode not in ("driving", "walking", "transit"):
        mode = "driving"

    # Edge case: same location
    if math.isclose(from_lat, to_lat, abs_tol=1e-5) and math.isclose(from_lng, to_lng, abs_tol=1e-5):
        return {
            "source": "osrm",
            "is_fallback": False,
            "fallback_reason": None,
            "distance_km": 0.0,
            "duration_minutes": 0,
            "mode": mode,
            "origin": {"lat": from_lat, "lng": from_lng},
            "destination": {"lat": to_lat, "lng": to_lng},
            "geometry": [[round(from_lng, 6), round(from_lat, 6)]],
            "steps": [
                {
                    "instruction": "You are already at the destination hospital",
                    "distance_m": 0.0,
                    "duration_s": 0.0,
                    "maneuver_type": "arrive",
                    "modifier": "straight",
                    "name": "Destination",
                }
            ],
            "summary": "At destination",
        }

    # Map mode to OSRM profile (OSRM supports 'driving', 'walking', 'bike')
    osrm_profile = "walking" if mode == "walking" else "driving"
    coords = f"{from_lng:.6f},{from_lat:.6f};{to_lng:.6f},{to_lat:.6f}"
    url = f"{OSRM_BASE_URL}/route/v1/{osrm_profile}/{coords}?overview=full&geometries=geojson&steps=true"

    try:
        r = httpx.get(url, headers=OSRM_HEADERS, timeout=OSRM_TIMEOUT_SECONDS)
        if r.status_code != 200:
            log.warning("OSRM returned status %s: %s", r.status_code, r.text[:150])
            return _build_estimated_fallback(
                from_lat, from_lng, to_lat, to_lng, mode, f"OSRM HTTP {r.status_code}"
            )

        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            log.warning("OSRM returned non-OK code: %s", data.get("code"))
            return _build_estimated_fallback(
                from_lat, from_lng, to_lat, to_lng, mode, f"OSRM code {data.get('code')}"
            )

        route = data["routes"][0]
        raw_dist_m = float(route.get("distance", 0.0))
        raw_dur_s = float(route.get("duration", 0.0))
        geometry = route.get("geometry", {}).get("coordinates", [])

        # Parse steps from the first leg
        steps_out = []
        legs = route.get("legs", [])
        if legs and "steps" in legs[0]:
            for st in legs[0]["steps"]:
                maneuver = st.get("maneuver", {})
                name = st.get("name", "")
                instruction = _format_maneuver(maneuver, name)
                steps_out.append({
                    "instruction": instruction,
                    "distance_m": round(float(st.get("distance", 0.0)), 1),
                    "duration_s": round(float(st.get("duration", 0.0)), 1),
                    "maneuver_type": maneuver.get("type", "turn"),
                    "modifier": maneuver.get("modifier"),
                    "name": name or None,
                })

        distance_km = round(raw_dist_m / 1000.0, 2)
        if mode == "transit":
            # For transit, scale driving duration slightly to represent urban bus/metro transit
            duration_minutes = max(5, round((raw_dur_s / 60.0) * 1.35) + 6)
        else:
            duration_minutes = max(1, round(raw_dur_s / 60.0))

        route_summary = route.get("weight_name", "")
        if legs and legs[0].get("summary"):
            route_summary = legs[0]["summary"]
        if not route_summary:
            route_summary = f"{mode.title()} via {steps_out[0]['name'] if steps_out and steps_out[0].get('name') else 'road'}"

        return {
            "source": "osrm",
            "is_fallback": False,
            "fallback_reason": None,
            "distance_km": distance_km,
            "duration_minutes": duration_minutes,
            "mode": mode,
            "origin": {"lat": from_lat, "lng": from_lng},
            "destination": {"lat": to_lat, "lng": to_lng},
            "geometry": geometry,
            "steps": steps_out,
            "summary": route_summary,
        }

    except (httpx.TimeoutException, httpx.NetworkError) as e:
        log.warning("OSRM request timeout/network error: %s", e)
        return _build_estimated_fallback(from_lat, from_lng, to_lat, to_lng, mode, "Timeout/Network")
    except Exception as e:
        log.error("OSRM routing unexpected error: %s", e, exc_info=True)
        return _build_estimated_fallback(from_lat, from_lng, to_lat, to_lng, mode, "Unexpected error")

