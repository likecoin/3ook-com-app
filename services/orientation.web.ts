// Web has no native orientation lock to undo — the browser and the page's own
// CSS own rotation. No-op so the shared startup path can import this without
// pulling expo-screen-orientation into the web bundle.
export function startOrientationWatcher(): () => void {
  return () => {};
}
