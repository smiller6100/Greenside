import { useState, useEffect, useRef } from "react";
import { ChevronLeft, User, Link2, LogOut, UserPlus, X, Lock, Check, ShieldCheck } from "lucide-react";
import { getAccount, clearAccount, claimAccount, mintLinkCode, setAccountName, syncDown, addFriend, removeFriend, friendCard, signup, login, setCredentials, usernameAvailable } from "../lib/account";

// Account screen. Signed out: sign in or create an account with a username + password (so everything
// follows you to any device). Signed in: manage your name, friends, and link codes — and, for an
// older passwordless account, a one-time prompt to add a username + password.
export default function Profile() {
  const [acc, setAcc] = useState(getAccount());
  const [name, setName] = useState(acc?.name || "");
  const [enterCode, setEnterCode] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [friends, setFriends] = useState<any[]>([]);
  const [addCode, setAddCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [card, setCard] = useState<{ id: string; name: string; rounds: any[] } | null>(null);

  // Signed-out auth form
  const [authMode, setAuthMode] = useState<"in" | "create">("in");
  const [showLink, setShowLink] = useState(false);
  const [u, setU] = useState(""); const [pw, setPw] = useState(""); const [dispName, setDispName] = useState("");
  const [authErr, setAuthErr] = useState("");
  const [uState, setUState] = useState<"" | "checking" | "free" | "taken" | "bad">("");

  // Secure-your-account (migration) form, shown when signed in without a username
  const [secU, setSecU] = useState(""); const [secPw, setSecPw] = useState(""); const [secErr, setSecErr] = useState("");

  useEffect(() => { if (getAccount()) syncDown().then((d) => { if (d) { setFriends(d.friends || []); setName(d.name || ""); setAcc(getAccount()); } }); }, []);

  // Live username availability while creating an account.
  const uTimer = useRef<any>(null);
  useEffect(() => {
    if (authMode !== "create") { setUState(""); return; }
    const v = u.trim();
    if (!v) { setUState(""); return; }
    if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) { setUState("bad"); return; }
    setUState("checking");
    clearTimeout(uTimer.current);
    uTimer.current = setTimeout(async () => { const r = await usernameAvailable(v); setUState(!r.valid ? "bad" : r.available ? "free" : "taken"); }, 350);
    return () => clearTimeout(uTimer.current);
  }, [u, authMode]);

  const goHome = () => { location.hash = ""; };

  const doSignup = async () => {
    setBusy(true); setAuthErr("");
    const r = await signup(u.trim(), pw, dispName.trim());
    setBusy(false);
    if (r.ok) { const a = getAccount(); setAcc(a); setName(a?.name || ""); const d = await syncDown(); if (d) setFriends(d.friends || []); }
    else setAuthErr(r.error || "Couldn't create that account.");
  };
  const doLogin = async () => {
    setBusy(true); setAuthErr("");
    const r = await login(u.trim(), pw);
    setBusy(false);
    if (r.ok) { setAcc(getAccount()); setName(getAccount()?.name || ""); const d = await syncDown(); if (d) setFriends(d.friends || []); }
    else setAuthErr(r.error || "Wrong username or password.");
  };
  const doSecure = async () => {
    setBusy(true); setSecErr("");
    const r = await setCredentials(secU.trim(), secPw);
    setBusy(false);
    if (r.ok) { setAcc(getAccount()); setMsg("Account secured"); setTimeout(() => setMsg(""), 1400); }
    else setSecErr(r.error || "Couldn't set that username.");
  };
  const doClaim = async () => { setBusy(true); setAuthErr(""); const ok = await claimAccount(enterCode.trim()); setBusy(false); if (ok) { setAcc(getAccount()); const d = await syncDown(); if (d) { setFriends(d.friends || []); setName(d.name || ""); } } else setAuthErr("That code didn't work — it may have expired."); };
  const doLink = async () => { setLinkCode(""); const c = await mintLinkCode(); if (c) setLinkCode(c); };
  const saveName = async () => { await setAccountName(name.trim()); setAcc(getAccount()); setMsg("Saved"); setTimeout(() => setMsg(""), 1200); };
  const signOut = () => { clearAccount(); setAcc(null); setFriends([]); setLinkCode(""); setU(""); setPw(""); setDispName(""); };
  const doAddFriend = async () => { const id = addCode.trim(); if (!id) return; setBusy(true); const fc = await friendCard(id); if (fc) { const next = await addFriend(id, fc.name); setFriends(next); setAddCode(""); } else setMsg("No golfer found for that code."); setBusy(false); };
  const openFriend = async (f: any) => { const fc = await friendCard(f.id); if (fc) setCard({ id: f.id, name: fc.name || f.name, rounds: fc.rounds }); };
  const dropFriend = async (id: string) => { const next = await removeFriend(id); setFriends(next); if (card?.id === id) setCard(null); };

  const uHint = uState === "bad" ? "3–20 letters, numbers or _" : uState === "taken" ? "Taken" : uState === "free" ? "Available" : uState === "checking" ? "Checking…" : "";

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>{acc ? "Account" : "Sign in"}</h2><span />
      </header>

      <div className="panel">
        {!acc ? (
          <>
            <div className="pf-hero"><User size={28} /><p>Sign in so your rounds, stats, leagues and Ryder Cups follow you to any device.</p></div>

            <div className="pf-seg">
              <button className={authMode === "in" ? "on" : ""} onClick={() => { setAuthMode("in"); setAuthErr(""); }}>Sign in</button>
              <button className={authMode === "create" ? "on" : ""} onClick={() => { setAuthMode("create"); setAuthErr(""); }}>Create account</button>
            </div>

            <div className="field"><span>Username</span>
              <input className="dash-pw" style={{ margin: 0 }} value={u} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={(e) => setU(e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20))} placeholder="username" />
              {authMode === "create" && uHint && <p className={`pf-uhint ${uState}`}>{uState === "free" ? <Check size={12} /> : null}{uHint}</p>}
            </div>
            <div className="field"><span>Password</span>
              <input className="dash-pw" style={{ margin: 0 }} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={authMode === "create" ? "at least 6 characters" : "password"}
                onKeyDown={(e) => { if (e.key === "Enter" && authMode === "in") doLogin(); }} />
            </div>
            {authMode === "create" && (
              <div className="field"><span>Display name <em className="opt">shown to friends</em></span>
                <input className="dash-pw" style={{ margin: 0 }} value={dispName} onChange={(e) => setDispName(e.target.value)} placeholder="e.g. Sam" />
              </div>
            )}

            {authErr && <p className="err">{authErr}</p>}
            {authMode === "in"
              ? <button className="primary" disabled={busy || !u.trim() || !pw} onClick={doLogin}>{busy ? "Signing in…" : "Sign in"}</button>
              : <button className="primary" disabled={busy || uState === "taken" || uState === "bad" || !u.trim() || pw.length < 6} onClick={doSignup}>{busy ? "Creating…" : "Create account"}</button>}

            <div className="qr-or"><span>or link a device</span></div>
            {showLink ? (
              <div className="field"><span>Have a link code from another device?</span>
                <div className="pf-coderow">
                  <input className="dash-pw" style={{ margin: 0 }} value={enterCode} onChange={(e) => setEnterCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="6-character code" maxLength={6} />
                  <button className="primary pf-codebtn" disabled={busy || enterCode.length < 4} onClick={doClaim}>Link</button>
                </div>
              </div>
            ) : (
              <button className="linkbtn" onClick={() => setShowLink(true)}><Link2 size={14} /> Link with a code instead</button>
            )}
          </>
        ) : (
          <>
            {acc.username
              ? <div className="pf-signedin"><ShieldCheck size={16} /> Signed in as <b>@{acc.username}</b></div>
              : (
                <div className="pf-secure">
                  <div className="pf-secure-h"><Lock size={15} /> Secure your account</div>
                  <p>Add a username and password so you can sign in on any device. Without it, this account only lives on this phone.</p>
                  <input className="dash-pw" style={{ margin: "0 0 8px" }} value={secU} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setSecU(e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20))} placeholder="username" />
                  <input className="dash-pw" style={{ margin: "0 0 8px" }} type="password" value={secPw} onChange={(e) => setSecPw(e.target.value)} placeholder="password (6+ characters)" />
                  {secErr && <p className="err" style={{ margin: "0 0 8px" }}>{secErr}</p>}
                  <button className="primary" disabled={busy || !secU.trim() || secPw.length < 6} onClick={doSecure}>{busy ? "Saving…" : "Save username & password"}</button>
                </div>
              )}

            <div className="field"><span>Your name</span>
              <div className="pf-coderow">
                <input className="dash-pw" style={{ margin: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                <button className="primary pf-codebtn" onClick={saveName}>Save</button>
              </div>
              {msg && <p className="hint" style={{ margin: "6px 0 0" }}>{msg}</p>}
            </div>

            <div className="field"><span>Add this to another device</span>
              {linkCode ? (
                <div className="pf-linkcode"><b>{linkCode}</b><span>Enter this on your other device under Sign in → link. Expires in 10 minutes.</span></div>
              ) : (
                <button className="addp" onClick={doLink}><Link2 size={15} /> Get a link code</button>
              )}
              {acc.username && <p className="hint" style={{ margin: "6px 0 0" }}>Or just sign in there with <b>@{acc.username}</b> and your password.</p>}
            </div>

            <div className="field"><span>Friends <em className="opt">see their recent rounds</em></span>
              <div className="pf-coderow">
                <input className="dash-pw" style={{ margin: 0 }} value={addCode} onChange={(e) => setAddCode(e.target.value.trim())} placeholder="Paste a friend code" />
                <button className="primary pf-codebtn" disabled={busy || !addCode} onClick={doAddFriend}><UserPlus size={15} /></button>
              </div>
              <div className="pf-friendcode">Your friend code: <code>{acc.id}</code></div>
              {friends.length > 0 && (
                <div className="pf-friends">
                  {friends.map((f) => (
                    <div className="pf-friend" key={f.id}>
                      <button className="pf-friend-main" onClick={() => openFriend(f)}><span className="pf-fav">{(f.name || "?").slice(0, 1).toUpperCase()}</span><b>{f.name || "Golfer"}</b></button>
                      <button className="pf-friend-x" onClick={() => dropFriend(f.id)} aria-label="remove"><X size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="linkbtn" style={{ marginTop: 8 }} onClick={signOut}><LogOut size={14} /> Sign out of this device</button>
          </>
        )}
      </div>

      {card && (
        <div className="modal" onClick={() => setCard(null)}><div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h3>{card.name}</h3>
          {card.rounds.length === 0 ? <p className="hint">No rounds yet.</p> : (
            <div className="pf-cardrounds">
              {card.rounds.map((r: any, i: number) => (
                <div className="pf-cr" key={i}><span>{r.courseName || r.name || "Round"}</span><em>{new Date(r.endedAt || r.savedAt).toLocaleDateString([], { month: "short", day: "numeric" })}</em></div>
              ))}
            </div>
          )}
          <button className="ghostbtn" onClick={() => setCard(null)}>Close</button>
        </div></div>
      )}
    </div></div>
  );
}
