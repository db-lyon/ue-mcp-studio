/** Studio's mark: an orange dot on a dark rounded tile, as the window and the exe icon draw it. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="app-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="0" y="0" width="64" height="64" rx="11.5" fill="#131312" />
      <circle cx="32" cy="32" r="16.6" fill="#e8720c" />
    </svg>
  );
}
