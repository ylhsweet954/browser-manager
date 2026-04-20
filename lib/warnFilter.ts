const FILTERED_WARNINGS = new Set(["onClick is deprecated, please use onPress"]);

let installed = false;

export function installWarnFilter(): void {
  if (installed || typeof console === "undefined" || typeof console.warn !== "function") {
    return;
  }

  const originalWarn = console.warn.bind(console);

  console.warn = (...args: unknown[]) => {
    const firstArg = args[0];
    if (typeof firstArg === "string" && FILTERED_WARNINGS.has(firstArg)) {
      return;
    }
    originalWarn(...args);
  };

  installed = true;
}
