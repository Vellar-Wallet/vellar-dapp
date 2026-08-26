import http from "node:http";
import crypto from "node:crypto";

const SECRET_KEY = "mock_secret_2024";
const PROTECTED_CONTENT = {
  message: "Welcome to the protected resource!",
  data: {
    premium_feature: "enabled",
    access_level: "full",
    content_id: "protected-001",
  },
};

export class PaymentChallenge {
  constructor(secretKey = SECRET_KEY) {
    this.secretKey = secretKey;
    this.activeChallenges = new Map();
  }

  generateChallenge() {
    const challengeToken = crypto.randomBytes(16).toString("hex");
    const amount = 100; // Mock payment amount in stroops
    const timestamp = Date.now();

    const challenge = {
      challenge_token: challengeToken,
      amount,
      timestamp,
      currency: "XLM",
      expires_at: timestamp + 300000, // 5 minutes
    };

    this.activeChallenges.set(challengeToken, challenge);

    return challenge;
  }

  generateValidProof(challengeToken, amount) {
    const data = `${challengeToken}${amount}${this.secretKey}`;
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  verifyProof(proof, challengeToken, amount) {
    const expectedProof = this.generateValidProof(challengeToken, amount);
    return proof === expectedProof;
  }

  parseProof(proofHeader) {
    // Expected format: "token:proof" or just "proof"
    if (!proofHeader) return null;

    const parts = proofHeader.split(":");
    if (parts.length === 2) {
      return { token: parts[0], proof: parts[1] };
    }
    return { token: null, proof: proofHeader };
  }

  validateProofHeader(proofHeader) {
    const parsed = this.parseProof(proofHeader);
    if (!parsed || !parsed.proof) {
      return { valid: false, reason: "missing_proof" };
    }

    // If token is provided in proof header, use it
    if (parsed.token) {
      const challenge = this.activeChallenges.get(parsed.token);
      if (!challenge) {
        return { valid: false, reason: "invalid_challenge_token" };
      }

      // Check expiration
      if (Date.now() > challenge.expires_at) {
        this.activeChallenges.delete(parsed.token);
        return { valid: false, reason: "challenge_expired" };
      }

      const isValid = this.verifyProof(
        parsed.proof,
        parsed.token,
        challenge.amount
      );

      if (isValid) {
        this.activeChallenges.delete(parsed.token); // Clean up used challenge
        return { valid: true };
      }

      return { valid: false, reason: "invalid_proof" };
    }

    // If no token in header, check against all active challenges
    for (const [token, challenge] of this.activeChallenges.entries()) {
      if (Date.now() > challenge.expires_at) {
        this.activeChallenges.delete(token);
        continue;
      }

      if (this.verifyProof(parsed.proof, token, challenge.amount)) {
        this.activeChallenges.delete(token);
        return { valid: true };
      }
    }

    return { valid: false, reason: "invalid_proof" };
  }
}

export function handleProtectedRequest(paymentProof, challengeService) {
  if (!paymentProof) {
    // No payment proof - return 402 with challenge
    const challenge = challengeService.generateChallenge();
    return {
      status: 402,
      headers: {
        "X-Payment-Challenge": JSON.stringify(challenge),
      },
      body: {
        error: "payment_required",
        message: "Payment proof required to access this resource",
        challenge,
      },
    };
  }

  // Validate payment proof
  const validation = challengeService.validateProofHeader(paymentProof);

  if (!validation.valid) {
    // Invalid proof - return 402 with new challenge
    const challenge = challengeService.generateChallenge();
    return {
      status: 402,
      headers: {
        "X-Payment-Challenge": JSON.stringify(challenge),
      },
      body: {
        error: "invalid_payment_proof",
        message: `Payment proof validation failed: ${validation.reason}`,
        challenge,
      },
    };
  }

  // Valid proof - return protected content
  return {
    status: 200,
    headers: {
      "X-Payment-Verified": "true",
    },
    body: PROTECTED_CONTENT,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const challengeService = new PaymentChallenge();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname !== "/protected") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "not_found",
          message: "Resource not found",
        })
      );
      return;
    }

    const paymentProof = req.headers["x-payment-proof"];
    const result = handleProtectedRequest(paymentProof, challengeService);

    const headers = {
      "Content-Type": "application/json",
      ...result.headers,
    };

    res.writeHead(result.status, headers);
    res.end(JSON.stringify(result.body, null, 2));
  });

  const port = process.env.PORT || 4099;
  server.listen(port, () =>
    console.log(`x402 payment challenge server listening on port ${port}`)
  );
}
