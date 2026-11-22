import { describe, expect, it, vi } from "vitest";
import { Keypair, Account, xdr } from "@stellar/stellar-sdk";
import { ThresholdKeyManager, createThresholdSubmitter } from "./threshold-submitter";
import { createAttestor } from "./attestor";

describe("Threshold Attestor Submitter & Key Management (#422)", () => {
  const signer1 = Keypair.random();
  const signer2 = Keypair.random();
  const signer3 = Keypair.random();
  const relayer = Keypair.random();

  const registryContractId = "CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP";
  const thresholdAttestorContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  describe("ThresholdKeyManager", () => {
    it("manages N attestor keys and returns public keys", () => {
      const km = new ThresholdKeyManager([signer1.secret(), signer2.secret(), signer3.secret()]);

      expect(km.count).toBe(3);
      expect(km.getPublicKeys()).toEqual([
        signer1.publicKey(),
        signer2.publicKey(),
        signer3.publicKey(),
      ]);
      expect(km.getRawPublicKeys().length).toBe(3);
    });

    it("throws if initialized with empty keys list", () => {
      expect(() => new ThresholdKeyManager([])).toThrow(/requires at least 1 signer key/i);
    });

    it("signs payload with strictly ascending signer indices", () => {
      const km = new ThresholdKeyManager([signer1.secret(), signer2.secret(), signer3.secret()]);

      const payload = Buffer.alloc(32, 7);
      const sigs = km.signPayload(payload, 2);

      expect(sigs.length).toBe(2);
      expect(sigs[0]!.signerIndex).toBe(0);
      expect(sigs[1]!.signerIndex).toBe(1);
      expect(signer1.verify(payload, sigs[0]!.signature)).toBe(true);
      expect(signer2.verify(payload, sigs[1]!.signature)).toBe(true);
    });

    it("throws when requested signatures exceed configured signers", () => {
      const km = new ThresholdKeyManager([signer1.secret()]);
      const payload = Buffer.alloc(32, 9);
      expect(() => km.signPayload(payload, 2)).toThrow(/only 1 configured signers/i);
    });
  });

  describe("createThresholdSubmitter", () => {
    function setupMockServer() {
      const getAccount = vi.fn().mockResolvedValue(new Account(relayer.publicKey(), "100"));
      const prepareTransaction = vi.fn().mockImplementation((tx) => tx);
      const sendTransaction = vi
        .fn()
        .mockResolvedValue({ status: "PENDING", hash: "tx_mock_hash_123" });
      const getTransaction = vi.fn().mockResolvedValue({ status: "SUCCESS" });
      const getLatestLedger = vi.fn().mockResolvedValue({ sequence: 5000 });
      const simulateTransaction = vi.fn().mockResolvedValue({
        result: { retval: xdr.ScVal.scvVoid() },
      });

      return {
        getAccount,
        prepareTransaction,
        sendTransaction,
        getTransaction,
        getLatestLedger,
        simulateTransaction,
      };
    }

    it("submits upsert with M-of-N threshold signatures", async () => {
      const server = setupMockServer();
      const km = new ThresholdKeyManager([signer1.secret(), signer2.secret(), signer3.secret()]);

      const submitter = createThresholdSubmitter({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: "Test SDF Network ; September 2015",
        registryContractId,
        thresholdAttestorContractId,
        relayerSecretKey: relayer.secret(),
        keyManager: km,
        attestThreshold: 2,
        revokeThreshold: 1,
        server,
      });

      const fakeWasm = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      await submitter.upsert(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        fakeWasm,
        6000,
      );

      expect(server.getAccount).toHaveBeenCalledWith(relayer.publicKey());
      expect(server.sendTransaction).toHaveBeenCalled();
      expect(server.getTransaction).toHaveBeenCalledWith("tx_mock_hash_123");
    });

    it("measures revocation latency and executes fast-path revoke", async () => {
      const server = setupMockServer();
      const km = new ThresholdKeyManager([signer1.secret(), signer2.secret(), signer3.secret()]);

      const submitter = createThresholdSubmitter({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: "Test SDF Network ; September 2015",
        registryContractId,
        thresholdAttestorContractId,
        relayerSecretKey: relayer.secret(),
        keyManager: km,
        attestThreshold: 2,
        revokeThreshold: 1,
        server,
      });

      const latencyMs = await submitter.measureRevocationLatencyMs(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      );

      expect(typeof latencyMs).toBe("number");
      expect(latencyMs).toBeGreaterThanOrEqual(0);
      expect(latencyMs).toBeLessThan(5000); // Revocation latency must remain acceptable
      expect(server.sendTransaction).toHaveBeenCalled();
    });

    it("integrates with createAttestor and preserves never-revoke-on-uncertainty", async () => {
      const server = setupMockServer();
      const km = new ThresholdKeyManager([signer1.secret(), signer2.secret()]);

      const submitter = createThresholdSubmitter({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: "Test SDF Network ; September 2015",
        registryContractId,
        thresholdAttestorContractId,
        relayerSecretKey: relayer.secret(),
        keyManager: km,
        attestThreshold: 2,
        server,
      });

      const attestor = createAttestor({ submitter });

      // Verification failed for a never-attested contract: must NOT revoke
      vi.spyOn(submitter, "isAttested").mockResolvedValue(false);
      const revokeSpy = vi.spyOn(submitter, "revoke");

      await attestor.reportOutcome("C_UNATTESTED", {
        status: "failed",
        statusDetail: "rebuild hash mismatch",
        log: "",
      });

      expect(revokeSpy).not.toHaveBeenCalled();
    });
  });
});

  describe("M-of-N submission shape and failure modes (#772)", () => {
    const registryContractId = "CBZVS2ETJKCIMRRWUHTZFVMWDACJNYUZ54JIXUJCHXNBFNXELKTSWHGP";
    const thresholdAttestorContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

    function setupMockServer() {
      const relayer = Keypair.random();
      const getAccount = vi.fn().mockResolvedValue(new Account(relayer.publicKey(), "100"));
      const prepareTransaction = vi.fn().mockImplementation((tx) => tx);
      const sendTransaction = vi
        .fn()
        .mockResolvedValue({ status: "PENDING", hash: "tx_mock_hash_772" });
      const getTransaction = vi.fn().mockResolvedValue({ status: "SUCCESS" });
      const getLatestLedger = vi.fn().mockResolvedValue({ sequence: 5000 });
      const simulateTransaction = vi.fn().mockResolvedValue({
        result: { retval: xdr.ScVal.scvVoid() },
      });
      return {
        relayer,
        getAccount,
        prepareTransaction,
        sendTransaction,
        getTransaction,
        getLatestLedger,
        simulateTransaction,
      };
    }

    it("builds and sends M-of-N co-signed auth entry, not single-signer shape", async () => {
      const server = setupMockServer();
      const s1 = Keypair.random();
      const s2 = Keypair.random();
      const s3 = Keypair.random();
      const km = new ThresholdKeyManager([s1.secret(), s2.secret(), s3.secret()]);
      const submitter = createThresholdSubmitter({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: "Test SDF Network ; September 2015",
        registryContractId,
        thresholdAttestorContractId,
        relayerSecretKey: server.relayer.secret(),
        keyManager: km,
        attestThreshold: 2,
        revokeThreshold: 1,
        server,
      });

      await submitter.upsert(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        6000,
      );

      expect(server.sendTransaction).toHaveBeenCalledTimes(1);
      const sentTx = server.sendTransaction.mock.calls[0]![0];
      const op = sentTx.operations[0] as any;
      expect(op.auth).toHaveLength(1);
      const authEntry = op.auth[0];
      const creds = authEntry.credentials().address();
      expect(creds.signature().switch().name).toBe("scvMap");
      const sigMap = creds.signature().map();
      const signaturesEntry = sigMap!.find((e: any) => e.key().sym().toString() === "signatures");
      const signatures = signaturesEntry!.val().vec();
      expect(signatures).toHaveLength(2);
      const indices = signatures.map((s: any) => {
        const entries = s.map();
        const idx = entries.find((e: any) => e.key().sym().toString() === "signer_index");
        return idx.val().u32();
      });
      expect(indices).toEqual([0, 1]);
    });

    it("fails clearly when fewer than M of N signatures are available", async () => {
      const server = setupMockServer();
      const s1 = Keypair.random();
      const km = new ThresholdKeyManager([s1.secret()]); // only 1 signer configured
      const submitter = createThresholdSubmitter({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: "Test SDF Network ; September 2015",
        registryContractId,
        thresholdAttestorContractId,
        relayerSecretKey: server.relayer.secret(),
        keyManager: km,
        attestThreshold: 2,
        revokeThreshold: 1,
        server,
      });

      await expect(
        submitter.upsert(
          "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          6000,
        ),
      ).rejects.toThrow(/Cannot produce 2 signatures with only 1 configured signers/);
      expect(server.sendTransaction).not.toHaveBeenCalled();
    });
  });
