import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { redact, redactString, safeLog, createSafeLogger } from "./secretsRedactor";
import { validateSecrets, isSecretSet, getSecretLength } from "./validateSecrets";

describe("Secrets Audit: Issue #307", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Save original env and create a fresh copy for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe("Redactor: redact()", () => {
    it("should redact objects with secret keys", () => {
      const obj = {
        api_key: "secret-123",
        username: "admin",
        password: "pass456",
        other: "visible",
      };

      const redacted = redact(obj);

      expect(redacted).toEqual({
        api_key: "[REDACTED]",
        username: "admin",
        password: "[REDACTED]",
        other: "visible",
      });
    });

    it("should redact Error objects with secret values in message", () => {
      const err = new Error("Failed to connect with DATABASE_URL=postgres://user:pass@host/db");
      const redacted = redact(err);

      expect(redacted).toMatchObject({
        name: "Error",
      });
      expect((redacted as any).message).not.toContain("postgres://user:pass@host");
      expect((redacted as any).message).toContain("[REDACTED]");
    });

    it("should recursively redact nested objects", () => {
      const obj = {
        config: {
          database: {
            DATABASE_URL: "postgresql://user:pass@host:5432/db",
          },
          api: {
            API_KEY: "sk_live_123456",
          },
        },
        status: "ok",
      };

      const redacted = redact(obj);

      expect((redacted as any).config.database.DATABASE_URL).toBe("[REDACTED]");
      expect((redacted as any).config.api.API_KEY).toBe("[REDACTED]");
      expect((redacted as any).status).toBe("ok");
    });

    it("should redact arrays of objects", () => {
      const arr = [
        { api_key: "key1", visible: "data1" },
        { password: "pass2", visible: "data2" },
      ];

      const redacted = redact(arr);

      expect((redacted as any)[0].api_key).toBe("[REDACTED]");
      expect((redacted as any)[0].visible).toBe("data1");
      expect((redacted as any)[1].password).toBe("[REDACTED]");
    });
  });

  describe("Redactor: redactString()", () => {
    it("should redact literal secret values from strings", () => {
      process.env.DATABASE_URL = "postgres://user:pass@host/db";
      process.env.ATTESTOR_SECRET_KEY = "SA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

      let str = `Error: Failed with ${process.env.DATABASE_URL}`;
      const redacted = redactString(str);

      expect(redacted).not.toContain("postgres://user:pass@host");
      expect(redacted).toContain("[REDACTED]");
    });

    it("should redact PostgreSQL connection strings", () => {
      const str = "Connected to postgresql://admin:secretPassword@localhost:5432/mydb";
      const redacted = redactString(str);

      expect(redacted).toContain("postgresql://[REDACTED]@");
      expect(redacted).not.toContain("admin:secretPassword");
    });

    it("should redact Ed25519 private keys (Stellar SA format)", () => {
      const str = "Using attestor key SAFRELPDOBRWLJZLVGSOOWBSVEUOMTAPXEMJOLU7AUJJS4Q6ZQ2QBTRY";
      const redacted = redactString(str);

      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("SAFRELPDOBRWLJZLVGSOOWBSVEUOMTAPXEMJOLU");
    });

    it("should redact password= patterns", () => {
      const str = 'Config: password=my_secret_password, user=admin';
      const redacted = redactString(str);

      expect(redacted).toContain("password=[REDACTED]");
      expect(redacted).not.toContain("my_secret_password");
    });

    it("should redact secret= patterns", () => {
      const str = 'Setup: secret=my_api_secret, environment=prod';
      const redacted = redactString(str);

      expect(redacted).toContain("secret=[REDACTED]");
      expect(redacted).not.toContain("my_api_secret");
    });

    it("should handle non-string input gracefully", () => {
      expect(redactString(123)).toBe("123");
      expect(redactString(null)).toBe("null");
      expect(redactString(undefined)).toBe("undefined");
    });
  });

  describe("Safe Logger: safeLog()", () => {
    it("should log redacted messages", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      process.env.DATABASE_URL = "postgres://user:pass@host/db";
      safeLog("error", "Connection failed", {
        url: process.env.DATABASE_URL,
        code: "ECONNREFUSED",
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const call = consoleErrorSpy.mock.calls[0];
      expect(call[0]).toBe("Connection failed");
      expect(JSON.stringify(call[1])).not.toContain("user:pass");
      expect(JSON.stringify(call[1])).toContain("[REDACTED]");

      consoleErrorSpy.mockRestore();
    });

    it("should handle all log levels", () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      safeLog("info", "test info");
      safeLog("warn", "test warn");
      safeLog("error", "test error");
      safeLog("debug", "test debug");

      expect(infoSpy).toHaveBeenCalledWith("test info");
      expect(warnSpy).toHaveBeenCalledWith("test warn");
      expect(errorSpy).toHaveBeenCalledWith("test error");
      expect(debugSpy).toHaveBeenCalledWith("test debug");

      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    });
  });

  describe("Safe Logger: createSafeLogger()", () => {
    it("should create a logger object with all safe methods", () => {
      const logger = createSafeLogger();

      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });

    it("should redact secrets in all logger methods", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createSafeLogger();

      process.env.API_KEY = "sk_live_super_secret_key";
      logger.error("Auth failed", { api_key: process.env.API_KEY });

      const call = consoleErrorSpy.mock.calls[0];
      expect(JSON.stringify(call)).not.toContain("sk_live_super_secret_key");
      expect(JSON.stringify(call)).toContain("[REDACTED]");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("Validation: validateSecrets()", () => {
    it("should validate required secrets are present", () => {
      // Ensure DATABASE_URL is set
      process.env.DATABASE_URL = "postgres://localhost/test";

      expect(() => {
        validateSecrets(process.env);
      }).not.toThrow();
    });

    it("should throw if DATABASE_URL is missing", () => {
      delete process.env.DATABASE_URL;

      expect(() => {
        validateSecrets(process.env);
      }).toThrow("Missing required secrets");
    });

    it("should validate conditional attestor secrets consistency", () => {
      process.env.DATABASE_URL = "postgres://localhost/test";

      // Setting only ATTESTOR_SECRET_KEY should fail
      process.env.ATTESTOR_SECRET_KEY = "SA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
      delete process.env.ATTESTATION_REGISTRY_ID;

      expect(() => {
        validateSecrets(process.env);
      }).toThrow("Incomplete attestor configuration");
    });

    it("should not require attestor secrets when neither is set", () => {
      process.env.DATABASE_URL = "postgres://localhost/test";
      delete process.env.ATTESTOR_SECRET_KEY;
      delete process.env.ATTESTATION_REGISTRY_ID;

      expect(() => {
        validateSecrets(process.env);
      }).not.toThrow();
    });

    it("should require both attestor secrets if one is set", () => {
      process.env.DATABASE_URL = "postgres://localhost/test";
      process.env.ATTESTATION_REGISTRY_ID = "CASSET123456";
      delete process.env.ATTESTOR_SECRET_KEY;

      expect(() => {
        validateSecrets(process.env);
      }).toThrow("Incomplete attestor configuration");
    });
  });

  describe("Validation helpers: isSecretSet(), getSecretLength()", () => {
    it("should check if a secret is set without exposing value", () => {
      process.env.TEST_SECRET = "my_secret_value";

      expect(isSecretSet("TEST_SECRET", process.env)).toBe(true);
      expect(isSecretSet("NONEXISTENT_SECRET", process.env)).toBe(false);
    });

    it("should get secret length without exposing value", () => {
      process.env.TEST_SECRET = "my_secret_value";

      expect(getSecretLength("TEST_SECRET", process.env)).toBe("my_secret_value".length);
      expect(getSecretLength("NONEXISTENT_SECRET", process.env)).toBe(0);
    });
  });

  describe("Integration: Secrets never appear in logs", () => {
    it("should not log DATABASE_URL in error output", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      process.env.DATABASE_URL = "postgres://admin:securePass123@db.example.com:5432/wallet";

      // Simulate a database connection error being logged through the safe logger
      const logger = createSafeLogger();
      logger.error("Database connection failed", {
        url: process.env.DATABASE_URL,
        error: "connection timeout",
      });

      // Check that the secret was not logged
      const allCalls = consoleErrorSpy.mock.calls
        .map((call) => JSON.stringify(call))
        .join("");

      expect(allCalls).not.toContain("securePass123");
      expect(allCalls).not.toContain("admin:");
      expect(allCalls).toContain("[REDACTED]");

      consoleErrorSpy.mockRestore();
    });

    it("should not log ATTESTOR_SECRET_KEY in error output", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      process.env.ATTESTOR_SECRET_KEY =
        "SAFRELPDOBRWLJZLVGSOOWBSVEUOMTAPXEMJOLU7AUJJS4Q6ZQ2QBTRY";

      const logger = createSafeLogger();
      logger.error("Attestor failed", {
        key: process.env.ATTESTOR_SECRET_KEY,
        operation: "sign",
      });

      const allCalls = consoleErrorSpy.mock.calls
        .map((call) => JSON.stringify(call))
        .join("");

      expect(allCalls).not.toContain("SAFRELPDOBRWLJZLVGSOOWBSVEUOMTAPXEMJOLU");
      expect(allCalls).toContain("[REDACTED]");

      consoleErrorSpy.mockRestore();
    });

    it("should not log inline secrets even in error stack traces", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const secret = "sk_test_abc123xyz789";
      const err = new Error(`Auth error with key: ${secret}`);

      const logger = createSafeLogger();
      logger.error("Operation failed", err);

      const allCalls = consoleErrorSpy.mock.calls
        .map((call) => JSON.stringify(call))
        .join("");

      expect(allCalls).not.toContain("sk_test_abc123xyz789");
      expect(allCalls).toContain("[REDACTED]");

      consoleErrorSpy.mockRestore();
    });
  });
});
