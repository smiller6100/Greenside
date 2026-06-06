import { useState, useEffect } from "react";
import Home from "./screens/Home";
import Round from "./screens/Round";

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
  useEffect(() => {
    const on = () => setRoute(resolveRoute());
    window.addEventListener("hashchange", on);
    window.addEventListener("pageshow", on); // re-check when iOS restores the tab
    return () => { window.removeEventListener("hashchange", on); window.removeEventListener("pageshow", on); };
  }, []);
  useEffect(() => {
    if (!route && location.hash.includes("/r/")) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch { /* */ }
    }
  }, [route]);
  return route ? <Round key={route.code + (route.group || "")} code={route.code} joinGroup={route.group} /> : <Home />;
}
