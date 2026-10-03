// Next instrumentation hook: runs once when the server starts. The
// Node-only work lives in its own module behind the runtime check so
// the edge bundle never sees a Node built-in import.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
