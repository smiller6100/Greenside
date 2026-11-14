import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import distance from "@turf/distance";
import { point } from "@turf/helpers";

// The parsed hole from /api/holemap. All coordinates are [lat, lon] (OSM order).
type Hole = {
  ref: number | null; par: number | null;
  line: number[][]; tee: number[]; green: number[][] | null; greenC: number[];
  fairways: number[][][]; rough: number[][][]; tees: number[][][];
  hazards: { kind: string; poly: number[][]; c: number[] }[];
  teeToGreenYds: number;
};
type LL = [number, number]; // [lon, lat] for GeoJSON / MapLibre

// [lat,lon] -> [lon,lat], and close a ring so it's a valid GeoJSON polygon.
const toLL = (p: number[]): LL => [p[1], p[0]];
const ring = (poly: number[][]): LL[] => {
  const r = poly.map(toLL);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  return r;
};
// Yards between two [lon,lat] points, computed on real geographic coordinates (not pixels).
const yds = (a: LL, b: LL) => Math.round(distance(point(a), point(b), { units: "kilometers" }) * 1093.6133);

function initialBearing(a: LL, b: LL): number {
  const toR = Math.PI / 180, toD = 180 / Math.PI;
  const dL = (b[0] - a[0]) * toR;
  const y = Math.sin(dL) * Math.cos(b[1] * toR);
  const x = Math.cos(a[1] * toR) * Math.sin(b[1] * toR) - Math.sin(a[1] * toR) * Math.cos(b[1] * toR) * Math.cos(dL);
  return (Math.atan2(y, x) * toD + 360) % 360;
}

export default function HoleMapGL({ hole, me }: { hole: Hole; me?: { lat: number; lng: number; acc?: number } | null }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const targetMk = useRef<maplibregl.Marker | null>(null);
  const meMk = useRef<maplibregl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [target, setTarget] = useState<LL | null>(null);

  const teeLL = toLL(hole.tee);
  const greenCLL = toLL(hole.greenC);
  // Distances are measured from the golfer when we have GPS, otherwise from the tee.
  const originLL: LL = me ? [me.lng, me.lat] : teeLL;

  // Front / center / back of the green, relative to the current origin.
  const gd = useMemo(() => {
    const center = yds(originLL, greenCLL);
    let front = center, back = center;
    if (hole.green && hole.green.length) {
      let mn = Infinity, mx = -Infinity;
      for (const v of hole.green) { const d = yds(originLL, toLL(v)); if (d < mn) mn = d; if (d > mx) mx = d; }
      front = mn; back = mx;
    }
    return { front, center, back };
  }, [originLL[0], originLL[1], hole]);

  // Build the map once per hole.
  useEffect(() => {
    if (!wrapRef.current) return;
    const map = new maplibregl.Map({
      container: wrapRef.current,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      style: {
        version: 8,
        sources: {
          esri: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
          },
        },
        layers: [{ id: "esri", type: "raster", source: "esri" }],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      const feats: any[] = [];
      const addPolys = (polys: number[][][] | undefined, kind: string) =>
        (polys || []).forEach((poly) => feats.push({ type: "Feature", properties: { kind }, geometry: { type: "Polygon", coordinates: [ring(poly)] } }));
      addPolys(hole.fairways, "fairway");
      if (hole.green) feats.push({ type: "Feature", properties: { kind: "green" }, geometry: { type: "Polygon", coordinates: [ring(hole.green)] } });
      addPolys(hole.tees, "tee");
      (hole.hazards || []).forEach((h) => feats.push({ type: "Feature", properties: { kind: h.kind }, geometry: { type: "Polygon", coordinates: [ring(h.poly)] } }));
      feats.push({ type: "Feature", properties: { kind: "center" }, geometry: { type: "LineString", coordinates: hole.line.map(toLL) } });
      map.addSource("hole", { type: "geojson", data: { type: "FeatureCollection", features: feats } });

      const fill = (id: string, kind: string, color: string, opacity: number) => {
        map.addLayer({ id, type: "fill", source: "hole", filter: ["==", ["get", "kind"], kind], paint: { "fill-color": color, "fill-opacity": opacity } });
        map.addLayer({ id: id + "-o", type: "line", source: "hole", filter: ["==", ["get", "kind"], kind], paint: { "line-color": color, "line-width": 1.3, "line-opacity": 0.9 } });
      };
      fill("fw", "fairway", "#8ed081", 0.20);
      fill("water", "water", "#2f80ed", 0.45);
      fill("bunker", "bunker", "#efe2b0", 0.55);
      fill("tee", "tee", "#4da3ff", 0.55);
      fill("green", "green", "#2ecc71", 0.42);
      map.addLayer({ id: "center", type: "line", source: "hole", filter: ["==", ["get", "kind"], "center"], paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.5 } });

      // Aim line from the golfer (or tee) to the movable target.
      map.addSource("aim", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "aim", type: "line", source: "aim", paint: { "line-color": "#ffd60a", "line-width": 2.5 } });

      // Frame and orient the hole so it plays bottom-to-top.
      const pts: LL[] = [teeLL, greenCLL];
      if (hole.green) hole.green.forEach((v) => pts.push(toLL(v)));
      (hole.fairways || []).forEach((poly) => poly.forEach((v) => pts.push(toLL(v))));
      const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
      map.fitBounds(bounds, { bearing: initialBearing(teeLL, greenCLL), padding: 48, maxZoom: 18, animate: false });

      // Draggable target, starting at the green center. Tap anywhere to move it too.
      const t = new maplibregl.Marker({ draggable: true, color: "#ffd60a" }).setLngLat(greenCLL).addTo(map);
      targetMk.current = t;
      setTarget(greenCLL);
      const sync = () => { const l = t.getLngLat(); setTarget([l.lng, l.lat]); };
      t.on("drag", sync); t.on("dragend", sync);
      map.on("click", (e) => { t.setLngLat(e.lngLat); setTarget([e.lngLat.lng, e.lngLat.lat]); });

      map.resize();
      setReady(true);
    });

    return () => { map.remove(); mapRef.current = null; meMk.current = null; targetMk.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hole.ref]);

  // Keep the aim line and the golfer dot in sync as GPS / target move.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("aim") as maplibregl.GeoJSONSource | undefined;
    if (src && target) src.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [originLL, target] } }] });
    if (me) {
      if (!meMk.current) {
        const el = document.createElement("div");
        el.className = "gl-me";
        meMk.current = new maplibregl.Marker({ element: el }).setLngLat([me.lng, me.lat]).addTo(map);
      } else meMk.current.setLngLat([me.lng, me.lat]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originLL[0], originLL[1], target, ready, me]);

  const toTarget = target ? yds(originLL, target) : null;
  const targetToGreen = target ? yds(target, greenCLL) : null;

  return (
    <div className="glmap">
      <div ref={wrapRef} className="glmap-canvas" />
      <div className="glmap-dist">
        <div className="gd-fcb"><span>{gd.front}</span><span className="gd-c">{gd.center}</span><span>{gd.back}</span></div>
        <div className="gd-lbl">front · center · back · yds {me ? "from you" : "from tee"}</div>
      </div>
      {target && (
        <div className="glmap-target"><b>{toTarget}</b> yds to target · <b>{targetToGreen}</b> yds target→green</div>
      )}
    </div>
  );
}
