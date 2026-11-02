import { NetworkConfigError, type Network } from "./network-config";

// Horizon URL for services that read accounts from Horizon (lifecycle-service).
//
// Same class as security-audit.md RA-10: lifecycle-service used to default HORIZON_URL
// to TESTNET when unset, so a mainnet deployment that forgot the variable would
// inspect and plan cleanup against the wrong network without any error. The network
// is now the EXPLICIT, REQUIRED STELLAR_NETWORK; an unset HORIZON_URL is derived from
// it, and a HORIZON_URL that disagrees with it (or that we cannot classify) refuses
// to boot, naming both values.

const HORIZON_BY_NETWORK: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

function horizonNetwork(url: string): Network | undefined {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "horizon-testnet.stellar.org") return "testnet";
  if (host === "horizon.stellar.org") return "mainnet";
  return undefined; // unrecognized: cannot confirm either side
}

export function horizonUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.STELLAR_NETWORK?.trim();
  if (!declared) {
    throw new NetworkConfigError(
      "STELLAR_NETWORK is not set. Set it to 'testnet' or 'mainnet'; HORIZON_URL is derived " +
        "from it and never defaults to testnet.",
    );
  }
  if (declared !== "testnet" && declared !== "mainnet") {
    throw new NetworkConfigError(
      `STELLAR_NETWORK='${declared}' is not a valid network. Use 'testnet' or 'mainnet'.`,
    );
  }
  const explicit = env.HORIZON_URL?.trim();
  if (!explicit) return HORIZON_BY_NETWORK[declared];

  const actual = horizonNetwork(explicit);
  if (actual !== declared) {
    throw new NetworkConfigError(
      `STELLAR_NETWORK='${declared}' but HORIZON_URL ${
        actual ? `looks like ${actual}` : `host is unrecognized`
      } (${explicit}). Refusing to boot rather than guess which value is correct. Unset HORIZON_URL ` +
        `to use ${HORIZON_BY_NETWORK[declared]}.`,
    );
  }
  return explicit;
}
