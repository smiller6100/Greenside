import { useState, useEffect } from "react";
import { ChevronLeft, User, Link2, Copy, Check, LogOut, UserPlus, X } from "lucide-react";
import { getAccount, setAccount, clearAccount, createAccount, claimAccount, mintLinkCode, setAccountName, syncDown, addFriend, removeFriend, friendCard } from "../lib/account";

// Optional profile: create or link an account so rounds, stats and handicap follow you across
// devices — and add friends to see their recent rounds. Entry to the app never requires this.
export default function Profile() {
  const [acc, setAcc] = useState(getAccount());
  const [name, setName] = useState(acc?.name || "");
  const [newName, setNewName] = useState("");
  const [enterCode, setEnterCode] = useState("");
  const [linkCode, setLinkCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [friends, setFriends] = useState<any[]>([]);
  const [addCode, setAddCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [card, setCard] = useState<{ id: string; name: string; rounds: any[] } | null>(null);

  useEffect(() => { if (getAccount()) syncDown().then((d) => { if (d) { setFriends(d.friends || []); setName(d.name || ""); setAcc(getAccount()); } }); }, []);

  const goHome = () => { location.hash = ""; };

  const doCreate = async () => { setBusy(true); setMsg(""); const a = await createAccount(newName.trim() || "Me"); setBusy(false); if (a) { setAcc(a); setName(a.name); } else setMsg("Couldn't create the account. Try again."); };
  const doClaim = async () => { setBusy(true); setMsg(""); const ok = await claimAccount(enterCode.trim()); setBusy(false); if (ok) { setAcc(getAccount()); const d = await syncDown(); if (d) { setFriends(d.friends || []); setName(d.name || ""); } } else setMsg("That code didn't work — it may have expired."); };
  const doLink = async () => { setLinkCode(""); const c = await mintLinkCode(); if (c) setLinkCode(c); };
  const saveName = async () => { await setAccountName(name.trim()); setAcc(getAccount()); setMsg("Saved"); setTimeout(() => setMsg(""), 1200); };
  const signOut = () => { clearAccount(); setAcc(null); setFriends([]); setLinkCode(""); };
  const copyId = () => { if (acc) { navigator.clipboard?.writeText(acc.id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}); } };
  const doAddFriend = async () => { const id = addCode.trim(); if (!id) return; setBusy(true); const fc = await friendCard(id); if (fc) { const next = await addFriend(id, fc.name); setFriends(next); setAddCode(""); } else setMsg("No golfer found for that code."); setBusy(false); };
  const openFriend = async (f: any) => { const fc = await friendCard(f.id); if (fc) setCard({ id: f.id, name: fc.name || f.name, rounds: fc.rounds }); };
  const dropFriend = async (id: string) => { const next = await removeFriend(id); setFriends(next); if (card?.id === id) setCard(null); };

  return (
    <div className="gs"><div className="frame home">
      <header className="dash-head">
        <button className="backbtn" onClick={goHome}><ChevronLeft size={20} /></button>
        <h2>Profile</h2><span />
      </header>

      <div className="panel">
        {!acc ? (
          <>
            <div className="pf-hero"><User size={28} /><p>Create a free profile so your rounds, stats and handicap follow you to any device. No email, no password.</p></div>
            <div className="field"><span>Your name</span>
              <input className="dash-pw" style={{ margin: 0 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Sam" />
            </div>
            <button className="primary" disabled={busy} onClick={doCreate}>{busy ? "Creating…" : "Create profile"}</button>
            <div className="qr-or"><span>or link a device</span></div>
            <div className="field"><span>Have a link code from another device?</span>
              <div className="pf-coderow">
                <input className="dash-pw" style={{ margin: 0 }} value={enterCode} onChange={(e) => setEnterCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="6-character code" maxLength={6} />
                <button className="primary pf-codebtn" disabled={busy || enterCode.length < 4} onClick={doClaim}>Link</button>
              </div>
            </div>
            {msg && <p className="err">{msg}</p>}
          </>
        ) : (
          <>
            <div className="field"><span>Your name</span>
              <div className="pf-coderow">
                <input className="dash-pw" style={{ margin: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                <button className="primary pf-codebtn" onClick={saveName}>Save</button>
              </div>
              {msg && <p className="hint" style={{ margin: "6px 0 0" }}>{msg}</p>}
            </div>

            <div className="field"><span>Add this to another device</span>
              {linkCode ? (
                <div className="pf-linkcode"><b>{linkCode}</b><span>Enter this on your other device under Profile → link. Expires in 10 minutes.</span></div>
              ) : (
                <button className="addp" onClick={doLink}><Link2 size={15} /> Get a link code</button>
              )}
            </div>

            <div className="field"><span>Friends <em className="opt">see their recent rounds</em></span>
              <div className="pf-coderow">
                <input className="dash-pw" style={{ margin: 0 }} value={addCode} onChange={(e) => setAddCode(e.target.value.trim())} placeholder="Paste a friend code" />
                <button className="primary pf-codebtn" disabled={busy || !addCode} onClick={doAddFriend}><UserPlus size={15} /></button>
              </div>
              <div className="pf-friendcode">Your friend code: <code>{acc.id}</code> <button className="linkbtn" onClick={copyId}>{copied ? "Copied" : "Copy"}</button></div>
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
