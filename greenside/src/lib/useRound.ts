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

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/api/round/${code}/connect`);
      wsRef.current = sock;
      sock.onopen = () => { if (alive) setConnected(true); };
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
        retry = setTimeout(connect, 1500);
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
