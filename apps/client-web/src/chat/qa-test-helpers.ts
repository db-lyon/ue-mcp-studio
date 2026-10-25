import { fireEvent } from "@testing-library/react";

/** Open a collapsed Playtest card, as the user does by clicking its title. */
export function openCard(container: HTMLElement): void {
  const toggle = container.querySelector<HTMLButtonElement>(".qa-toggle[aria-expanded='false']");
  if (toggle) fireEvent.click(toggle);
}
