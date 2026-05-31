import { useState, useEffect } from "react";
import Home from "./screens/Home";
import Round from "./screens/Round";

function parseHash() {
  const m = location.hash.match(/#\/r\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
}

export default function App() {
  const [code, setCode] = useState<string | null>(parseHash());
  useEffect(() => {
    const on = () => setCode(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return code ? <Round key={code} code={code} /> : <Home />;
}
