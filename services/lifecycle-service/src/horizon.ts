// Horizon account reader seam (technical-doc.md §6.3 Lifecycle Service:
// account inspection). Classic (G...) accounts only — cleanup/merge is a
// classic-account concept; smart wallets are contracts and cannot be merged.

export interface HorizonBalance {
  assetType: string; // "native" | "credit_alphanum4" | "credit_alphanum12" | ...
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
}

export interface HorizonOffer {
  id: string;
  sellingAssetType: string;
  sellingAssetCode?: string;
  sellingAssetIssuer?: string;
  buyingAssetType: string;
  buyingAssetCode?: string;
  buyingAssetIssuer?: string;
  price: string;
}

export interface HorizonAccount {
  accountId: string;
  /** Current sequence number (needed to build transactions). */
  sequence: string;
  balances: HorizonBalance[];
  /** Managed-data entry keys. */
  dataKeys: string[];
  offers: HorizonOffer[];
  openOffers: number;
}

export interface AccountReader {
  /** undefined = account does not exist on the network. */
  getAccount(accountId: string): Promise<HorizonAccount | undefined>;
}

export function createHorizonAccountReader(horizonUrl: string): AccountReader {
  const base = horizonUrl.replace(/\/+$/, "");

  return {
    async getAccount(accountId) {
      const accountRes = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}`);
      if (accountRes.status === 404) return undefined;
      if (!accountRes.ok) throw new Error(`Horizon account fetch failed (${accountRes.status})`);
      const account = (await accountRes.json()) as {
        sequence: string;
        balances: Array<{
          asset_type: string;
          asset_code?: string;
          asset_issuer?: string;
          balance: string;
        }>;
        data: Record<string, string>;
      };

      const offersRes = await fetch(
        `${base}/accounts/${encodeURIComponent(accountId)}/offers?limit=200`,
      );
      if (!offersRes.ok) throw new Error(`Horizon offers fetch failed (${offersRes.status})`);
      const offersBody = (await offersRes.json()) as {
        _embedded: {
          records: Array<{
            id: string;
            selling: { asset_type: string; asset_code?: string; asset_issuer?: string };
            buying: { asset_type: string; asset_code?: string; asset_issuer?: string };
            price: string;
          }>;
        };
      };
      const offers = offersBody._embedded.records.map((o) => ({
        id: o.id,
        sellingAssetType: o.selling.asset_type,
        sellingAssetCode: o.selling.asset_code,
        sellingAssetIssuer: o.selling.asset_issuer,
        buyingAssetType: o.buying.asset_type,
        buyingAssetCode: o.buying.asset_code,
        buyingAssetIssuer: o.buying.asset_issuer,
        price: o.price,
      }));

      return {
        accountId,
        sequence: account.sequence,
        balances: account.balances.map((b) => ({
          assetType: b.asset_type,
          assetCode: b.asset_code,
          assetIssuer: b.asset_issuer,
          balance: b.balance,
        })),
        dataKeys: Object.keys(account.data ?? {}),
        offers,
        openOffers: offers.length,
      };
    },
  };
}
