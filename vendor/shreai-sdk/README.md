# @shreai/sdk -- Shre AI Platform SDK

SDK for building services on the Shre AI platform. Provides structured logging, database clients, event bus, retrieval-augmented generation, execution tracking, and more.

## Installation

```bash
npm install @shreai/sdk
```

## Quick Start

```typescript
import { createLogger, createCortexClient, createEventBus } from "@shreai/sdk";

const log = createLogger("my-service");
const cortex = createCortexClient("my-service");
const events = createEventBus("my-service");

log.info("Service starting", { port: 5490 });

// Write structured data to CortexDB
await cortex.write("evaluation", { agentId: "main", quality: 4.2 });

// Publish events
await events.publish("service.started", "info", { service: "my-service" });
```

## Modules

### Logger

Structured JSON logging with correlation IDs and automatic secret redaction.

```typescript
import { createLogger } from "@shreai/sdk/logger";

const log = createLogger("my-service");
log.info("Request received", { userId: "u-123", action: "query" });
log.warn("Slow response", { latencyMs: 1200 });
log.error("Connection failed", { error: err.message });
```

### CortexDB Client

Typed client for CortexService (PostgreSQL + Qdrant + Redis). Non-blocking writes by default.

```typescript
import { createCortexClient } from "@shreai/sdk/cortex";

const cortex = createCortexClient("my-service");

await cortex.write("task_result", { taskId: "t-1", score: 0.95 });
const results = await cortex.query("task_result", { taskId: "t-1" });
const search = await cortex.search("sales trends", { dataType: "insight", limit: 5 });
```

### Event Bus

Redis Streams-backed pub/sub with consumer groups.

```typescript
import { createEventBus } from "@shreai/sdk/events";

const bus = createEventBus("my-service");

bus.subscribe("task.completed", async (event) => {
  console.log("Task done:", event.data);
});

await bus.publish("task.created", "info", { taskId: "t-1" });
```

### RAG (Retrieval-Augmented Generation)

Universal RAG pipeline: vector retrieval, memory recall, conversation learning.

```typescript
import { createRAGClient, createRAGMiddleware, createConversationLearner } from "@shreai/sdk/rag";

// Retrieve context
const rag = createRAGClient("my-service");
const patterns = await rag.retrieve("sales trends", "tenant-1", 5);
const memories = await rag.recallMemory("agent-id", "sales trends", 5);

// Middleware: parallel multi-source retrieval
const middleware = createRAGMiddleware("my-service", {
  sources: ["vectors", "memory", "custom"],
  customSource: async (query, tenantId) => fetchContext(query),
});
const context = await middleware.enrich("What were sales?", "tenant-1", "agent-id");

// Conversation learning: extract and store insights
const learner = createConversationLearner("my-service");
await learner.learn(userText, assistantText, "tenant-1", "agent-id");
```

### Execution Tracker

CortexService-persisted task execution with write-ahead buffer, phase tracking, and stuck recovery.

```typescript
import { createExecutionTracker } from "@shreai/sdk/execution";

const tracker = createExecutionTracker("my-service");
const exec = await tracker.start({ taskId: "t-1", agentId: "agent-1" });
await exec.advance("execute");
await exec.complete({ quality: 0.92 });
```

### Lite Tier

Drop-in replacements for CortexClient and EventBus using in-memory storage. No Redis, PostgreSQL, or Qdrant required.

```typescript
import { createLiteCortexClient, createLiteEventBus, isLiteTier } from "@shreai/sdk/lite";

const cortex = createLiteCortexClient("my-service", {
  persistPath: "./data/lite-store.json",
});
const events = createLiteEventBus("my-service");

// Same API as the standard clients
await cortex.write("metric", { value: 42 });
await events.publish("metric.recorded", "info", { value: 42 });
```

Set `SHRE_TIER=lite` to auto-select lite backends in services that support tier detection.

## All Available Imports

| Import Path | Description |
|-------------|-------------|
| `@shreai/sdk` | Main entry -- re-exports all modules |
| `@shreai/sdk/logger` | Structured JSON logger with correlation IDs |
| `@shreai/sdk/cortex` | CortexDB write/query/search client |
| `@shreai/sdk/events` | Redis Streams event bus with consumer groups |
| `@shreai/sdk/rag` | RAG retrieval, middleware, conversation learning |
| `@shreai/sdk/execution` | Task execution tracker with phase management |
| `@shreai/sdk/lite` | In-memory CortexDB + EventBus (no infrastructure) |
| `@shreai/sdk/discovery` | Service discovery from ports.json |
| `@shreai/sdk/auth` | Vault reader, token validation, auth headers |
| `@shreai/sdk/config` | Model config loader with hot-reload |
| `@shreai/sdk/types` | Shared TypeScript type definitions |
| `@shreai/sdk/startup` | Startup dependency validation |
| `@shreai/sdk/circuit-breaker` | Circuit breaker for external calls |
| `@shreai/sdk/lifecycle` | Graceful shutdown handler |
| `@shreai/sdk/platform` | Cross-OS detection, paths, service management |
| `@shreai/sdk/probe` | System probes: network, ports, processes |
| `@shreai/sdk/device-bridge` | WebSocket protocol for mobile/remote devices |
| `@shreai/sdk/feed` | Activity feed posts and audit helpers |
| `@shreai/sdk/feedback` | Agent feedback and reporting pipeline |
| `@shreai/sdk/marketplace` | Agent marketplace client |
| `@shreai/sdk/audit` | Structured audit logging with Hono middleware |
| `@shreai/sdk/tenant` | Multi-tenant context extraction and propagation |
| `@shreai/sdk/rbac` | Role-based access control |
| `@shreai/sdk/passport-client` | Passport authentication client |
| `@shreai/sdk/service-identity` | HMAC-based service-to-service authentication |

## Requirements

- Node.js 18+
- TypeScript 5.7+ (for consumers using TypeScript)
- Redis 7+ (for event bus; use `@shreai/sdk/lite` without Redis)
- CortexService (for database client; use `@shreai/sdk/lite` without it)

## License

MIT -- Nirlab Inc

## Links

- [GitHub Repository](https://github.com/nirlab-inc/shreai)
- [Issue Tracker](https://github.com/nirlab-inc/shreai/issues)
