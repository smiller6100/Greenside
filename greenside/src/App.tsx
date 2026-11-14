import { useState, useEffect } from "react";
import Home from "./screens/Home";
import Round from "./screens/Round";
import OutingDash from "./screens/OutingDash";
import Clubhouse from "./screens/Clubhouse";
import Stats from "./screens/Stats";

function parseHash(): { code: string; group: string | null } | null {
  const m = location.hash.match(/#\/r\/([A-Za-z0-9]+)(?:-(\d{1,2}))?/);
  if (!m) return null;
  const group = m[2] && Number(m[2]) >= 1 && Number(m[2]) <= 36 ? String(Number(m[2])) : null;
  return { code: m[1].toUpperCase(), group };
}

// A round the user has ended on this device must never auto-reopen — even if
// iOS restores the old URL when the app is killed and relaunched.
function resolveRoute(): { code: string; group: string | null } | null {
  const r = parseHash();
  if (r && localStorage.getItem(`gs:ended:${r.code}`) === "1") return null;
  return r;
}

export default function App() {
  const [route, setRoute] = useState(resolveRoute);
  const [dash, setDash] = useState(() => location.hash.startsWith("#/outing"));
  const [club, setClub] = useState(() => location.hash.startsWith("#/clubhouse"));
  const [stats, setStats] = useState(() => location.hash.startsWith("#/stats"));
  useEffect(() => {
    const on = () => { setRoute(resolveRoute()); setDash(location.hash.startsWith("#/outing")); setClub(location.hash.startsWith("#/clubhouse")); setStats(location.hash.startsWith("#/stats")); };
    window.addEventListener("hashchange", on);
    window.addEventListener("pageshow", on); // re-check when iOS restores the tab
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener("pageshow", on); };
  }, []);
  useEffect(() => {
    if (!route && !dash && !club && !stats && location.hash.includes("/r/")) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch { /* */ }
    }
  }, [route, dash, club, stats]);
  if (stats) return <Stats />;
  if (club) return <Clubhouse />;
  if (dash) return <OutingDash />;
  return route ? <Round key={route.code + (route.group || "")} code={route.code} joinGroup={route.group} /> : <Home />;
}
