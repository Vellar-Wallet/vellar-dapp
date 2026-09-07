import Fastify, { type FastifyInstance } from "fastify";
import { registerHealth, registerMetrics } from "@vellar/service-kit";

export interface PermissionServiceDeps {
  isReady?: () => boolean | Promise<boolean>;
  dbCheck?: () => Promise<boolean>;
}

export function buildPermissionServer(deps: PermissionServiceDeps = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  const isReady = async (): Promise<boolean> => {
    if (deps.isReady) {
      const ready = await deps.isReady();
      if (!ready) return false;
    }
    if (deps.dbCheck) {
      try {
        const dbOk = await deps.dbCheck();
        if (!dbOk) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  registerHealth(app, "permission-service", { isReady });
  registerMetrics(app, "permission-service");

  app.get("/permissions", async () => {
    return { service: "permission-service", status: "ok" };
  });

  return app;
}
