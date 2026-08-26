import http from "node:http";

// Sample audit log dataset (30 entries with various actors and actions)
const AUDIT_LOG_DATASET = [
  {
    id: "audit-001",
    timestamp: "2024-01-15T10:30:00Z",
    actor: "user-alice",
    action: "create",
    resource: "wallet-001",
    result: "success",
  },
  {
    id: "audit-002",
    timestamp: "2024-01-15T10:35:00Z",
    actor: "user-bob",
    action: "update",
    resource: "policy-001",
    result: "success",
  },
  {
    id: "audit-003",
    timestamp: "2024-01-15T10:40:00Z",
    actor: "system-cleanup",
    action: "delete",
    resource: "session-expired-001",
    result: "success",
  },
  {
    id: "audit-004",
    timestamp: "2024-01-15T10:45:00Z",
    actor: "user-alice",
    action: "transfer",
    resource: "tx-001",
    result: "success",
  },
  {
    id: "audit-005",
    timestamp: "2024-01-15T10:50:00Z",
    actor: "admin-charlie",
    action: "approve",
    resource: "request-001",
    result: "success",
  },
  {
    id: "audit-006",
    timestamp: "2024-01-15T10:55:00Z",
    actor: "user-bob",
    action: "create",
    resource: "wallet-002",
    result: "success",
  },
  {
    id: "audit-007",
    timestamp: "2024-01-15T11:00:00Z",
    actor: "user-alice",
    action: "update",
    resource: "profile-alice",
    result: "success",
  },
  {
    id: "audit-008",
    timestamp: "2024-01-15T11:05:00Z",
    actor: "system-cleanup",
    action: "delete",
    resource: "session-expired-002",
    result: "success",
  },
  {
    id: "audit-009",
    timestamp: "2024-01-15T11:10:00Z",
    actor: "user-bob",
    action: "transfer",
    resource: "tx-002",
    result: "success",
  },
  {
    id: "audit-010",
    timestamp: "2024-01-15T11:15:00Z",
    actor: "admin-charlie",
    action: "reject",
    resource: "request-002",
    result: "success",
  },
  {
    id: "audit-011",
    timestamp: "2024-01-15T11:20:00Z",
    actor: "user-alice",
    action: "create",
    resource: "policy-002",
    result: "success",
  },
  {
    id: "audit-012",
    timestamp: "2024-01-15T11:25:00Z",
    actor: "user-david",
    action: "update",
    resource: "settings-001",
    result: "success",
  },
  {
    id: "audit-013",
    timestamp: "2024-01-15T11:30:00Z",
    actor: "system-cleanup",
    action: "delete",
    resource: "old-log-001",
    result: "success",
  },
  {
    id: "audit-014",
    timestamp: "2024-01-15T11:35:00Z",
    actor: "user-alice",
    action: "transfer",
    resource: "tx-003",
    result: "success",
  },
  {
    id: "audit-015",
    timestamp: "2024-01-15T11:40:00Z",
    actor: "admin-charlie",
    action: "approve",
    resource: "request-003",
    result: "success",
  },
  {
    id: "audit-016",
    timestamp: "2024-01-15T11:45:00Z",
    actor: "user-bob",
    action: "create",
    resource: "device-001",
    result: "success",
  },
  {
    id: "audit-017",
    timestamp: "2024-01-15T11:50:00Z",
    actor: "user-david",
    action: "update",
    resource: "policy-003",
    result: "success",
  },
  {
    id: "audit-018",
    timestamp: "2024-01-15T11:55:00Z",
    actor: "system-cleanup",
    action: "delete",
    resource: "old-log-002",
    result: "success",
  },
  {
    id: "audit-019",
    timestamp: "2024-01-15T12:00:00Z",
    actor: "user-alice",
    action: "approve",
    resource: "tx-004",
    result: "success",
  },
  {
    id: "audit-020",
    timestamp: "2024-01-15T12:05:00Z",
    actor: "admin-charlie",
    action: "reject",
    resource: "request-004",
    result: "success",
  },
  {
    id: "audit-021",
    timestamp: "2024-01-15T12:10:00Z",
    actor: "user-bob",
    action: "create",
    resource: "session-001",
    result: "success",
  },
  {
    id: "audit-022",
    timestamp: "2024-01-15T12:15:00Z",
    actor: "user-david",
    action: "update",
    resource: "wallet-003",
    result: "success",
  },
  {
    id: "audit-023",
    timestamp: "2024-01-15T12:20:00Z",
    actor: "system-cleanup",
    action: "delete",
    resource: "expired-key-001",
    result: "success",
  },
  {
    id: "audit-024",
    timestamp: "2024-01-15T12:25:00Z",
    actor: "user-alice",
    action: "create",
    resource: "backup-001",
    result: "success",
  },
  {
    id: "audit-025",
    timestamp: "2024-01-15T12:30:00Z",
    actor: "admin-charlie",
    action: "approve",
    resource: "policy-004",
    result: "success",
  },
  {
    id: "audit-026",
    timestamp: "2024-01-15T12:35:00Z",
    actor: "user-bob",
    action: "update",
    resource: "device-002",
    result: "success",
  },
  {
    id: "audit-027",
    timestamp: "2024-01-15T12:40:00Z",
    actor: "user-david",
    action: "create",
    resource: "wallet-004",
    result: "success",
  },
  {
    id: "audit-028",
    timestamp: "2024-01-15T12:45:00Z",
    actor: "admin-charlie",
    action: "reject",
    resource: "request-005",
    result: "success",
  },
  {
    id: "audit-029",
    timestamp: "2024-01-15T12:50:00Z",
    actor: "user-alice",
    action: "update",
    resource: "profile-alice-2",
    result: "success",
  },
  {
    id: "audit-030",
    timestamp: "2024-01-15T12:55:00Z",
    actor: "user-bob",
    action: "create",
    resource: "policy-005",
    result: "success",
  },
];

export class AuditLogAggregator {
  constructor(dataset = AUDIT_LOG_DATASET) {
    this.dataset = dataset;
  }

  getEntries(filters = {}) {
    const { actor, action, limit = 10, offset = 0 } = filters;

    // Apply filters
    let filtered = [...this.dataset];

    if (actor) {
      filtered = filtered.filter((entry) => entry.actor === actor);
    }

    if (action) {
      filtered = filtered.filter((entry) => entry.action === action);
    }

    const total = filtered.length;

    // Apply pagination
    const paginated = filtered.slice(offset, offset + limit);

    return {
      entries: paginated,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total,
      },
    };
  }

  getSummary() {
    const summary = {};
    let totalEntries = 0;

    for (const entry of this.dataset) {
      if (!summary[entry.action]) {
        summary[entry.action] = 0;
      }
      summary[entry.action]++;
      totalEntries++;
    }

    return {
      summary,
      totalEntries,
    };
  }
}

export function handleRequest(action, params) {
  const aggregator = new AuditLogAggregator();

  if (action === "entries") {
    const filters = {
      actor: params.actor,
      action: params.action,
      limit: params.limit ? parseInt(params.limit, 10) : undefined,
      offset: params.offset ? parseInt(params.offset, 10) : undefined,
    };

    return {
      status: 200,
      body: aggregator.getEntries(filters),
    };
  }

  if (action === "summary") {
    return {
      status: 200,
      body: aggregator.getSummary(),
    };
  }

  return {
    status: 400,
    body: { error: "unknown_action", message: `Unknown action: ${action}` },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    let action;
    if (pathname === "/entries") {
      action = "entries";
    } else if (pathname === "/summary") {
      action = "summary";
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "not_found",
          message: `Endpoint ${pathname} not found`,
        })
      );
      return;
    }

    const params = Object.fromEntries(url.searchParams.entries());
    const { status, body } = handleRequest(action, params);

    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  });

  const port = process.env.PORT || 4109;
  server.listen(port, () =>
    console.log(`Audit log aggregation server listening on port ${port}`)
  );
}
