import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Green, GroupDot } from "./CourseMap";

// Clubhouse command-center map: the whole course on satellite imagery, framed to its extent, with
// a faint numbered marker per green and a live colored dot per group (updated every poll). North-up.
// [lat,lon] -> [lon,lat], closing the ring for a valid GeoJSON polygon.
const toLL = (p: number[]): [number, number] => [p[1], p[0]];
const ring = (poly: number[][]): [number, number][] => {
  const r = poly.map(toLL);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0]);
  return r;
};

export default function CourseMapGL({ center, greens, groups, holes }: {
  center: { lat: number; lng: number };
  greens: Green[];
  groups: GroupDot[];
  holes?: any[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const greenMarks = useRef<maplibregl.Marker[]>([]);
  const groupMarks = useRef<Map<string, { mk: maplibregl.Marker; el: HTMLDivElement }>>(new Map());
  const framed = useRef(false);

  useEffect(() => {
    if (!wrapRef.current) return;
    const map = new maplibregl.Map({
      container: wrapRef.current,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      center: [center.lng, center.lat],
      zoom: 15,
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
    return () => { map.remove(); mapRef.current = null; greenMarks.current = []; groupMarks.current.clear(); framed.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fairway + green outlines over the busy satellite, so the holes read clearly.
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const build = () => {
      ["cmh-fw-fill", "cmh-fw-line", "cmh-gr-fill", "cmh-gr-line"].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("holes")) map.removeSource("holes");
      const feats: any[] = [];
      (holes || []).forEach((h: any) => {
        (h.fairways || []).forEach((poly: number[][]) => feats.push({ type: "Feature", properties: { k: "fw" }, geometry: { type: "Polygon", coordinates: [ring(poly)] } }));
        if (h.green) feats.push({ type: "Feature", properties: { k: "gr" }, geometry: { type: "Polygon", coordinates: [ring(h.green)] } });
      });
      if (!feats.length) return;
      map.addSource("holes", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
      map.addLayer({ id: "cmh-fw-fill", type: "fill", source: "holes", filter: ["==", ["get", "k"], "fw"], paint: { "fill-color": "#8ed081", "fill-opacity": 0.32 } });
      map.addLayer({ id: "cmh-fw-line", type: "line", source: "holes", filter: ["==", ["get", "k"], "fw"], paint: { "line-color": "#eafff0", "line-width": 1.4, "line-opacity": 0.85 } });
      map.addLayer({ id: "cmh-gr-fill", type: "fill", source: "holes", filter: ["==", ["get", "k"], "gr"], paint: { "fill-color": "#2ecc71", "fill-opacity": 0.5 } });
      map.addLayer({ id: "cmh-gr-line", type: "line", source: "holes", filter: ["==", ["get", "k"], "gr"], paint: { "line-color": "#eafff0", "line-width": 1.2, "line-opacity": 0.9 } });
    };
    if (map.loaded()) build(); else map.once("load", build);
  }, [holes]);

  // Green markers + frame the course once the hole map arrives.
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const place = () => {
      greenMarks.current.forEach((m) => m.remove());
      greenMarks.current = [];
      greens.forEach((g) => {
        const el = document.createElement("div");
        el.className = "cm-gl-green";
        el.textContent = g.num ? String(g.num) : "";
        greenMarks.current.push(new maplibregl.Marker({ element: el }).setLngLat([g.lng, g.lat]).addTo(map));
      });
      if (!framed.current && greens.length >= 2) {
        const b = greens.reduce((bb, g) => bb.extend([g.lng, g.lat]), new maplibregl.LngLatBounds([greens[0].lng, greens[0].lat], [greens[0].lng, greens[0].lat]));
        map.fitBounds(b, { padding: 46, maxZoom: 17, animate: false });
        framed.current = true;
      }
    };
    if (map.loaded()) place(); else map.once("load", place);
  }, [greens]);

  // Live group dots — add/move/remove without rebuilding the map.
  useEffect(() => {
    const map = mapRef.current; if (!map) return;
    const sync = () => {
      const seen = new Set<string>();
      groups.forEach((d) => {
        seen.add(d.key);
        let entry = groupMarks.current.get(d.key);
        if (!entry) {
          const el = document.createElement("div");
          el.className = "cm-gl-dot";
          const mk = new maplibregl.Marker({ element: el }).setLngLat([d.lng, d.lat]).addTo(map);
          entry = { mk, el };
          groupMarks.current.set(d.key, entry);
        } else {
          entry.mk.setLngLat([d.lng, d.lat]);
        }
        entry.el.className = "cm-gl-dot" + (d.estimated ? " est" : "");
        entry.el.style.background = d.color;
        entry.el.style.opacity = d.fresh ? "1" : "0.55";
        entry.el.innerHTML = `<span>${d.label}</span>${d.hole ? `<em>${d.hole}</em>` : ""}`;
      });
      for (const [k, v] of groupMarks.current) if (!seen.has(k)) { v.mk.remove(); groupMarks.current.delete(k); }
    };
    if (map.loaded()) sync(); else map.once("load", sync);
  }, [groups]);

  return <div ref={wrapRef} className="cm-gl" />;
}
