export interface InFlightTracker {
  hasInFlight(walletId: string): boolean;
  start(walletId: string): () => void;
}

export function createMemoryInFlightTracker(): InFlightTracker {
  const inFlight = new Map<string, number>();
  return {
    hasInFlight(walletId: string): boolean {
      return (inFlight.get(walletId) ?? 0) > 0;
    },
    start(walletId: string): () => void {
      inFlight.set(walletId, (inFlight.get(walletId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const current = (inFlight.get(walletId) ?? 1) - 1;
        if (current <= 0) {
          inFlight.delete(walletId);
        } else {
          inFlight.set(walletId, current);
        }
      };
    },
  };
}
