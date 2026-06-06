import { useState, useEffect } from "react";
import Home from "./screens/Home";
import Round from "./screens/Round";

function parseHash(): { code: string; group: string | null } | null {
  const m = location.hash.match(/#\/r\/([A-Za-z0-9]+)(?:-(\d{1,2}))?/);
  if (!m) return null;
  const group = m[2] && Number(m[2]) >= 1 && Number(m[2]) <= 36 ? String(Number(m[2])) : null;
  return { code: m[1].toUpperCase(), group };
}

export default function App() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route ? <Round key={route.code + (route.group || "")} code={route.code} joinGroup={route.group} /> : <Home />;
}
