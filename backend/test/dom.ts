/** Wait for pending promises (the station source is async). */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}

export function press(input: HTMLElement, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  return event;
}

export function mouseDown(node: Element) {
  node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

export const options = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[role="option"]')];
export const optionNames = (root: ParentNode) =>
  options(root).map((o) => o.querySelector(".station-name")!.textContent);
