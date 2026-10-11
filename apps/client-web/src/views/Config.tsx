import { useEffect, useState } from "react";
import type { StudioConfigFile } from "@ue-mcp-studio/shared";
import { api, ApiError } from "../api";

export function ConfigView() {
  const [file, setFile] = useState<StudioConfigFile | null>(null);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.config().then((f) => {
      setFile(f);
      setText(f.text);
    }, (e: Error) => setMessage({ ok: false, text: e.message }));
  }, []);

  const save = () => {
    api.saveConfig(text).then(
      (f) => {
        setFile(f);
        setMessage({ ok: true, text: "Saved. The server reloads it on the next call." });
      },
      (e: ApiError) => setMessage({ ok: false, text: e.message }),
    );
  };

  if (!file) return message ? <div className="banner bad">{message.text}</div> : <p className="muted">Loading...</p>;
  const dirty = text !== file.text;
  return (
    <section className="card">
      <div className="row">
        <h2>Project config</h2>
        <span className="muted mono small" title={file.path}>{file.path.split(/[\\/]/).pop()}</span>
        <span className="spacer" />
        <button disabled={!dirty} onClick={() => setText(file.text)}>Revert</button>
        <button disabled={!dirty} onClick={save}>Save</button>
      </div>
      {message && <div className={`banner ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
      <textarea className="editor mono" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
    </section>
  );
}
