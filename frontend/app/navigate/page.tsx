"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { PatientNavigation, type NavOrigin } from "@/components/PatientNavigation";
import type { NavigationMode, Place } from "@/lib/api";

function NavigateContent() {
  const searchParams = useSearchParams();

  const initialDestination: Place | null = useMemo(() => {
    const toLat = searchParams.get("to_lat");
    const toLng = searchParams.get("to_lng");
    if (!toLat || !toLng) return null;

    const lat = parseFloat(toLat);
    const lng = parseFloat(toLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      name: searchParams.get("name") || "Destination Hospital",
      address: searchParams.get("address") || null,
      lat,
      lng,
    };
  }, [searchParams]);

  const initialOrigin: NavOrigin | null = useMemo(() => {
    const fromLat = searchParams.get("from_lat");
    const fromLng = searchParams.get("from_lng");
    if (!fromLat || !fromLng) return null;

    const lat = parseFloat(fromLat);
    const lng = parseFloat(fromLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return {
      lat,
      lng,
      label: searchParams.get("from_label") || "Specified origin",
    };
  }, [searchParams]);

  const initialMode: NavigationMode = useMemo(() => {
    const m = searchParams.get("mode");
    if (m === "walking" || m === "transit" || m === "driving") {
      return m;
    }
    return "driving";
  }, [searchParams]);

  return (
    <div style={{ paddingTop: 28, paddingBottom: 48 }}>
      <PatientNavigation
        initialOrigin={initialOrigin}
        initialDestination={initialDestination}
        initialMode={initialMode}
      />
    </div>
  );
}

export default function NavigatePage() {
  return (
    <Suspense
      fallback={
        <div className="narrow" style={{ paddingTop: 32, textAlign: "center" }}>
          <p className="muted">Loading navigation...</p>
        </div>
      }
    >
      <NavigateContent />
    </Suspense>
  );
}

