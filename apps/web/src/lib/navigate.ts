/** Leaves the app for another address. A function of its own so tests can observe it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
