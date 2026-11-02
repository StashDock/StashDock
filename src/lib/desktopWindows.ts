import { isTauri, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type DesktopSurface = "panel" | "folder" | "search";
export type DesktopWindowStatus = { visible: DesktopSurface | null; requested: DesktopSurface | null; maximized: boolean };
export const desktopSurface = (): DesktopSurface => { const surface = new URLSearchParams(window.location.search).get("surface"); return surface === "folder" || surface === "search" ? surface : "panel"; };
export const switchDesktopSurface = (target: DesktopSurface) => invoke<DesktopWindowStatus>("set_desktop_surface", { target });

// Portalled menu/dialog events bubble through React ancestors, but only
// pointers physically inside the grey chrome may start a native gesture.
export function handleTitlebarDrag(event: React.PointerEvent<HTMLElement>, enabled = true) {
  if (!enabled || !isTauri() || !event.currentTarget.contains(event.target as Node) || event.button !== 0 || event.detail > 1 ||
    (event.target as HTMLElement).closest("button, input, textarea, label, a, select, [data-no-drag]")) return;
  event.preventDefault();
  void getCurrentWindow().startDragging().catch(error => console.warn("Could not move StashDock", error));
}
export function handleTitlebarDoubleClick(event: React.MouseEvent<HTMLElement>, enabled = true) {
  if (!enabled || !isTauri() || !event.currentTarget.contains(event.target as Node) || (event.target as HTMLElement).closest("button, input, textarea, label, a, select, [data-no-drag]")) return;
  void getCurrentWindow().toggleMaximize().catch(error => console.warn("Could not resize StashDock", error));
}
export async function beginFloatingDrag(pointer?: { x: number; y: number }): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("drag_folder_window", { pointerX: pointer?.x, pointerY: pointer?.y });
}
export async function hideStashDock() {
  if (isTauri()) await invoke<DesktopWindowStatus>("hide_stashdock");
}
