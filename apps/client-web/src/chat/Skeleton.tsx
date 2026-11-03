/**
 * Placeholders shaped like what is loading: session rows in the list, and a
 * conversation while a session opens. Through remote control every request
 * takes a moment, and an empty pane reads as broken.
 */

/** The session list before it first answers. */
export function SessionRowsLoading() {
  return (
    <div className="skeleton-rows" role="status" aria-label="Loading sessions">
      {[72, 54, 64].map((w, i) => (
        <div key={i} className="item skeleton-row">
          <span className="skeleton-bar" style={{ width: `${w}%` }} />
          <span className="skeleton-bar thin" style={{ width: `${w - 22}%` }} />
        </div>
      ))}
    </div>
  );
}

/** A session that is opening: a user line and a few agent lines. */
export function SessionLoading() {
  return (
    <div className="transcript skeleton-session" role="status" aria-label="Opening session">
      <div className="skeleton-msg user"><span className="skeleton-bar" style={{ width: "100%" }} /></div>
      <div className="skeleton-msg">
        <span className="skeleton-bar" style={{ width: "92%" }} />
        <span className="skeleton-bar" style={{ width: "78%" }} />
        <span className="skeleton-bar" style={{ width: "54%" }} />
      </div>
      <div className="skeleton-msg tool"><span className="skeleton-bar" style={{ width: "100%" }} /></div>
      <div className="skeleton-msg">
        <span className="skeleton-bar" style={{ width: "86%" }} />
        <span className="skeleton-bar" style={{ width: "40%" }} />
      </div>
    </div>
  );
}
