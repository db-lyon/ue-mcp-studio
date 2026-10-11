import { useRef, type ReactNode } from "react";
import { formatBytes, type PendingFile } from "./attachments";

/**
 * Where the user writes: the text, the files added to it (dropped, pasted or
 * picked), and the bar with the model picker and Send or Stop. Enter sends,
 * Shift+Enter starts a new line.
 */
export function Composer({ draft, onDraft, onBlur, placeholder, busy, canSend, onSend, onStop, files, onAddFiles, onRemoveFile, picker, children }: {
  draft: string;
  onDraft: (text: string) => void;
  onBlur: () => void;
  placeholder: string;
  busy: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
  files: PendingFile[];
  onAddFiles: (files: FileList | File[]) => void;
  onRemoveFile: (key: string) => void;
  picker: ReactNode;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="composer">
      {files.length > 0 && (
        <div className="attach-list" aria-label="Attached files">
          {files.map((f) => (
            <div key={f.key} className={`attach-chip ${f.state}`} title={f.error ?? f.name}>
              {f.preview ? <img src={f.preview} alt="" /> : <span className="attach-ext">{extOf(f.name)}</span>}
              <span className="attach-name">{f.name}</span>
              <span className="dim small">{f.state === "uploading" ? "adding" : f.state === "error" ? f.error : formatBytes(f.size)}</span>
              <button className="attach-remove" aria-label={`Remove ${f.name}`} onClick={() => onRemoveFile(f.key)}>{"×"}</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onDraft(e.target.value)}
        onBlur={onBlur}
        onPaste={(e) => {
          // A pasted screenshot or copied file is attached; pasted text stays text.
          if (e.clipboardData.files.length > 0) {
            e.preventDefault();
            onAddFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
      />
      <div className="composer-bar">
        {picker}
        <button className="ghost attach-button" disabled={busy} onClick={() => input.current?.click()} title="Attach files (or drop or paste them)">Attach</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(e) => {
            if (e.target.files?.length) onAddFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        {busy ? <button onClick={onStop}>Stop</button> : <button className="primary" disabled={!canSend} onClick={onSend}>Send</button>}
      </div>
      {children}
    </div>
  );
}

const extOf = (name: string): string => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");
