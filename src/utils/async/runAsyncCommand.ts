/**
 * Shared terminal boundary for detached UI/native async commands.
 *
 * Commands launched without awaiting must terminate their rejection path here
 * so native/storage failures never become unhandled promise rejections.
 */
export function runAsyncCommand(
  context: string,
  operation: () => Promise<void>,
  onError?: (error: unknown) => void
): void {
  void Promise.resolve()
    .then(operation)
    .catch((error: unknown) => {
      try {
        console.warn(`[async-command] ${context} failed:`, error);
        onError?.(error);
      } catch (handlerError) {
        console.error(`[async-command] ${context} error handler failed:`, handlerError);
      }
    });
}
