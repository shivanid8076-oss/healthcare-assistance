"""Unit and integration tests for Patient Navigation routing service and API."""
import httpx
import pytest

from app.services import routing


def test_navigation_route_success(client):
    """Test standard driving route between India Gate and AIIMS New Delhi."""
    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.5672,
            "to_lng": 77.2100,
            "mode": "driving",
        },
    )
    assert r.status_code == 200
    data = r.json()

    assert data["source"] in ("osrm", "estimated")
    assert isinstance(data["is_fallback"], bool)
    assert data["distance_km"] > 0
    assert data["duration_minutes"] > 0
    assert data["mode"] == "driving"
    assert data["origin"] == {"lat": 28.6129, "lng": 77.2295}
    assert data["destination"] == {"lat": 28.5672, "lng": 77.2100}
    assert isinstance(data["geometry"], list)
    assert len(data["geometry"]) >= 2
    assert isinstance(data["steps"], list)
    assert len(data["steps"]) >= 1
    assert "summary" in data and len(data["summary"]) > 0

    first_step = data["steps"][0]
    assert "instruction" in first_step
    assert "distance_m" in first_step
    assert "duration_s" in first_step


def test_navigation_walking_mode(client):
    """Test walking mode navigation."""
    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.6150,
            "to_lng": 77.2300,
            "mode": "walking",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["mode"] == "walking"
    assert data["distance_km"] > 0
    assert data["duration_minutes"] > 0


def test_navigation_transit_mode(client):
    """Test transit mode navigation."""
    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.5672,
            "to_lng": 77.2100,
            "mode": "transit",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["mode"] == "transit"
    assert data["duration_minutes"] >= 5


def test_navigation_same_origin_destination(client):
    """Test when origin and destination are identical."""
    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.6129,
            "to_lng": 77.2295,
            "mode": "driving",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["distance_km"] == 0.0
    assert data["duration_minutes"] == 0
    assert data["is_fallback"] is False
    assert len(data["steps"]) == 1
    assert "already at the destination" in data["steps"][0]["instruction"].lower()


def test_navigation_fallback_on_osrm_timeout(client, monkeypatch):
    """Test that timeout triggers mathematical fallback with clear indication."""
    def mock_get(*args, **kwargs):
        raise httpx.TimeoutException("Simulated OSRM timeout")

    monkeypatch.setattr(routing.httpx, "get", mock_get)

    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.5672,
            "to_lng": 77.2100,
            "mode": "driving",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "estimated"
    assert data["is_fallback"] is True
    assert data["fallback_reason"] == "Timeout/Network"
    assert data["distance_km"] > 0
    assert data["duration_minutes"] > 0
    assert len(data["geometry"]) >= 2
    assert len(data["steps"]) >= 2


def test_navigation_fallback_on_osrm_500(client, monkeypatch):
    """Test that HTTP 500 response from OSRM triggers fallback."""
    class FakeResponse:
        status_code = 500
        text = "Internal Server Error"

        def json(self):
            return {}

    def mock_get(*args, **kwargs):
        return FakeResponse()

    monkeypatch.setattr(routing.httpx, "get", mock_get)

    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.5672,
            "to_lng": 77.2100,
            "mode": "walking",
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "estimated"
    assert data["is_fallback"] is True
    assert "OSRM HTTP 500" in data["fallback_reason"]


def test_navigation_invalid_coordinates(client):
    """Test validation errors on coordinate bounds."""
    # Latitude > 90
    r = client.get(
        "/api/navigation/route",
        params={"from_lat": 95.0, "from_lng": 77.2295, "to_lat": 28.5672, "to_lng": 77.2100},
    )
    assert r.status_code == 422

    # Longitude < -180
    r = client.get(
        "/api/navigation/route",
        params={"from_lat": 28.6129, "from_lng": -185.0, "to_lat": 28.5672, "to_lng": 77.2100},
    )
    assert r.status_code == 422

    # Missing parameters
    r = client.get("/api/navigation/route", params={"from_lat": 28.6129})
    assert r.status_code == 422


def test_navigation_invalid_mode(client):
    """Test validation error when invalid transport mode is provided."""
    r = client.get(
        "/api/navigation/route",
        params={
            "from_lat": 28.6129,
            "from_lng": 77.2295,
            "to_lat": 28.5672,
            "to_lng": 77.2100,
            "mode": "flying",
        },
    )
    assert r.status_code == 422


def test_routing_service_maneuver_formatting():
    """Unit test for formatting various maneuver types."""
    assert "Head forward" in routing._format_maneuver({"type": "depart"}, None)
    assert "Arrive at destination" in routing._format_maneuver({"type": "arrive"}, None)
    assert "Take roundabout" in routing._format_maneuver({"type": "roundabout"}, "Ring Road")
    assert "Keep left" in routing._format_maneuver({"type": "fork", "modifier": "left"}, "NH-48")
    assert "Turn right onto Mahatma Gandhi Marg" in routing._format_maneuver(
        {"type": "turn", "modifier": "right"}, "Mahatma Gandhi Marg"
    )

