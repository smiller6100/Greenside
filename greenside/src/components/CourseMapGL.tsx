import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Green, GroupDot } from "./CourseMap";

// Clubhouse command-center map: the whole course on satellite imagery, framed to its extent, with
// a faint numbered marker per green and a live colored dot per group (updated every poll). North-up.
export default function CourseMapGL({ center, greens, groups }: {
  center: { lat: number; lng: number };
  greens: Green[];
  groups: GroupDot[];
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
