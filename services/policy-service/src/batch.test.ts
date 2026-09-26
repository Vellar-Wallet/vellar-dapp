import { describe, expect, it } from "vitest";
import { createPolicyService } from "./server";

describe("POST /policies/batch (#261)", () => {
  it("processes a batch of valid policy templates successfully", async () => {
    const app = await createPolicyService();

    const response = await app.inject({
      method: "POST",
      url: "/policies/batch",
      payload: {
        templates: [
          {
            definition: {
              name: "Spender Limit A",
              type: "spending_limit",
              rules: { limit: "100", period: "daily" },
            },
          },
          {
            definition: {
              name: "Spender Limit B",
              type: "spending_limit",
              rules: { limit: "500", period: "weekly" },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(2);
    expect(body.successful).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.length).toBe(2);
    expect(body.results[0].success).toBe(true);
    expect(body.results[0].policy).toBeDefined();
    expect(body.results[1].success).toBe(true);
    expect(body.results[1].policy).toBeDefined();
  });

  it("handles partial failure scenarios and returns 207 Multi-Status", async () => {
    const app = await createPolicyService();

    const response = await app.inject({
      method: "POST",
      url: "/policies/batch",
      payload: {
        templates: [
          {
            definition: {
              name: "Valid Policy",
              type: "spending_limit",
              rules: { limit: "100", period: "daily" },
            },
          },
          {
            definition: {
              name: "Invalid Policy",
              type: "invalid_type",
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(207);
    const body = JSON.parse(response.body);
    expect(body.total).toBe(2);
    expect(body.successful).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results[0].success).toBe(true);
    expect(body.results[1].success).toBe(false);
    expect(body.results[1].error).toBe("invalid_policy");
  });

  it("enforces max batch size", async () => {
    const app = await createPolicyService();
    const oversizedTemplates = Array.from({ length: 51 }, (_, i) => ({
      definition: {
        name: `Policy ${i}`,
        type: "spending_limit",
        rules: { limit: "10", period: "daily" },
      },
    }));

    const response = await app.inject({
      method: "POST",
      url: "/policies/batch",
      payload: {
        templates: oversizedTemplates,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("batch_size_exceeded");
  });
});
