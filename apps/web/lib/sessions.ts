"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Network } from "@vela/types";
import { walletConfig } from "./config";
import { createHttpWalletBackend } from "./http-backend";

// Session/device management data hooks (technical-doc.md §5.1). Isolated in
// this module so component tests can mock it.

function api() {
  return createHttpWalletBackend(walletConfig().apiUrl);
}

const sessionsKey = (contractId: string | undefined, network: Network) => [
  "sessions",
  contractId,
  network,
];

export function useSessions(contractId: string | undefined, network: Network) {
  return useQuery({
    queryKey: sessionsKey(contractId, network),
    enabled: contractId !== undefined,
    queryFn: async () =>
      (await api().listSessions({ contractId: contractId as string, network })).sessions,
  });
}

export function useRevokeSession(contractId: string | undefined, network: Network) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => api().revokeSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionsKey(contractId, network) }),
  });
}
