"""Patient Navigation routing API.

Provides road and pedestrian routes with turn-by-turn directions between patient coordinates
and destination hospital.
"""
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..services import routing

router = APIRouter(prefix="/api/navigation", tags=["navigation"])


class Coordinate(BaseModel):
    lat: float
    lng: float


class StepInstruction(BaseModel):
    instruction: str
    distance_m: float
    duration_s: float
    maneuver_type: str = "turn"
    modifier: str | None = None
    name: str | None = None


class RouteResponse(BaseModel):
    source: str = Field(..., description="'osrm' or 'estimated'")
    is_fallback: bool = Field(..., description="True if fallback routing was used")
    fallback_reason: str | None = Field(default=None, description="Reason if fallback was used")
    distance_km: float = Field(..., description="Total route distance in km")
    duration_minutes: int = Field(..., description="Estimated travel time in minutes")
    mode: str = Field(..., description="Travel mode (driving, walking, transit)")
    origin: Coordinate
    destination: Coordinate
    geometry: list[list[float]] = Field(default_factory=list, description="GeoJSON [lng, lat] coordinate pairs")
    steps: list[StepInstruction] = Field(default_factory=list, description="Turn-by-turn directions")
    summary: str = Field(..., description="Human-readable route summary")


@router.get("/route", response_model=RouteResponse)
async def get_route(
    from_lat: float = Query(..., ge=-90.0, le=90.0, description="Origin latitude (-90 to 90)"),
    from_lng: float = Query(..., ge=-180.0, le=180.0, description="Origin longitude (-180 to 180)"),
    to_lat: float = Query(..., ge=-90.0, le=90.0, description="Destination latitude (-90 to 90)"),
    to_lng: float = Query(..., ge=-180.0, le=180.0, description="Destination longitude (-180 to 180)"),
    mode: str = Query("driving", pattern="^(driving|walking|transit)$", description="Travel mode: driving, walking, transit"),
) -> RouteResponse:
    """Calculate road route and turn-by-turn navigation between origin and destination."""
    res = await run_in_threadpool(routing.get_route, from_lat, from_lng, to_lat, to_lng, mode)
    return RouteResponse(**res)

