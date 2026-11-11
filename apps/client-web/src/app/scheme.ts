/** Light or dark as Windows has it, kept on <html data-scheme> for app.css; `fixed` pins one (visual QA). */
export function followScheme(fixed?: "light" | "dark"): void {
  const root = document.documentElement;
  if (fixed) {
    root.dataset.scheme = fixed;
    return;
  }
  const query = window.matchMedia("(prefers-color-scheme: light)");
  const apply = () => (root.dataset.scheme = query.matches ? "light" : "dark");
  apply();
  query.addEventListener("change", apply);
}
