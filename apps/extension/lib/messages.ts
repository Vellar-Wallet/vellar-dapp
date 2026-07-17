import type { ProviderRequest, RequestEnvelope, ResponsePayload } from "@vela/provider-sdk";

// Internal extension messaging contracts (content script <-> background <->
// popup). These never cross into page context.

export interface ProviderRequestMessage {
  type: "provider-request";
  envelope: RequestEnvelope;
}

export interface ListPendingMessage {
  type: "list-pending";
}

export interface ResolvePendingMessage {
  type: "resolve-pending";
  id: string;
  approved: boolean;
}

export type ExtensionMessage = ProviderRequestMessage | ListPendingMessage | ResolvePendingMessage;

/** What the popup renders for an approval (origin ALWAYS displayed — §8.2). */
export interface PendingApprovalSummary {
  id: string;
  origin: string;
  request: ProviderRequest;
}

export type ProviderRequestReply = ResponsePayload;
