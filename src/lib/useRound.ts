import { useEffect, useRef, useState, useCallback } from "react";
import type { RoundState } from "./golf";

export function useRound(code: string) {
  const [state, setState] = useState<RoundState | null>(null);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout>;

    // Try the current host first; if the socket can't connect (e.g. the custom domain
    // is briefly not carrying WebSockets after a deploy), fall back to the worker's
    // always-on address so the round never hangs on "Connecting…".
    const FALLBACK_HOST = "greenside.smiller6100.workers.dev";
    const hosts = location.host === FALLBACK_HOST ? [location.host] : [location.host, FALLBACK_HOST];
    let hostIdx = 0;
    let fails = 0;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${hosts[hostIdx]}/api/round/${code}/connect`);
      wsRef.current = sock;
      sock.onopen = () => { if (alive) { fails = 0; setConnected(true); } };
      sock.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.type === "state") setState(d.state);
        } catch { /* ignore */ }
      };
      sock.onclose = (e) => {
        if (!alive) return;
        setConnected(false);
        if (e.code === 4404) { setMissing(true); return; }
        fails++;
        if (fails >= 3 && hosts.length > 1) { hostIdx = (hostIdx + 1) % hosts.length; fails = 0; } // switch hosts
        retry = setTimeout(connect, 1200);
      };
      sock.onerror = () => { try { sock.close(); } catch { /* */ } };
    };

    // verify the round exists before opening a socket
    fetch(`/api/round/${code}`).then((r) => {
      if (!alive) return;
      if (r.status === 404) { setMissing(true); return; }
      connect();
    }).catch(() => { if (alive) connect(); });

    return () => { alive = false; clearTimeout(retry); wsRef.current?.close(); };
  }, [code]);

  const sendScore = useCallback((playerId: string, hole: number, strokes: number) => {
    wsRef.current?.send(JSON.stringify({ type: "score", playerId, hole, strokes }));
    // optimistic local update for a snappy stepper
    setState((s) => s ? {
      ...s,
      scores: { ...s.scores, [playerId]: { ...(s.scores[playerId] || {}), [hole]: strokes } },
    } : s);
  }, []);

  const sendWolfPick = useCallback((hole: number, partner: string | null) => {
    wsRef.current?.send(JSON.stringify({ type: "wolfPick", hole, partner }));
    setState((s) => {
      if (!s) return s;
      const wolf = { ...(s.wolf || {}) };
      if (partner === null) delete wolf[hole]; else wolf[hole] = partner;
      return { ...s, wolf };
    });
  }, []);

  return { state, connected, missing, sendScore, sendWolfPick };
}
