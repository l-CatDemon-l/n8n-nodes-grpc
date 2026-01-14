# n8n-nodes-grpc

Execute gRPC calls in n8n workflows with dynamic protobuf support.

## Features

- ✅ **Dynamic Proto Parsing** - Load proto definitions directly in n8n
- ✅ **Multi-file Support** - Handle imports between multiple proto files
- ✅ **Google Well-Known Types** - Built-in support for `Any`, `Timestamp`, `Struct`, etc.
- ✅ **Flexible Configuration** - Use credentials or define inline
- ✅ **Streaming Support** - Server streaming RPC methods
- ✅ **TLS/SSL** - Secure connections support
- ✅ **Custom Metadata** - Add headers to gRPC calls

## Installation

```bash
npm install @novapo/n8n-nodes-grpc
```

In n8n, go to **Settings** → **Community Nodes** and install `@novapo/n8n-nodes-grpc`.

## Quick Start

### 1. Add gRPC Node

Add the **gRPC** node to your workflow.

### 2. Configure Connection

**Option A: Using Credentials**
- Toggle **Use Credentials** ON
- Create/select gRPC credentials with:
  - Host (e.g., `api.example.com:443`)
  - Proto definitions
  - TLS settings
  - Metadata

**Option B: Inline Configuration**
- Toggle **Use Credentials** OFF
- Fill in **Connection Settings**, **Metadata**, and **Protobuf Definitions** directly

### 3. Define Proto Files

#### Single File
```protobuf
syntax = "proto3";
package myservice;

service Greeter {
  rpc SayHello(HelloRequest) returns (HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
```

#### Multiple Files
Use delimiters to separate files:
```
[[=============== common.proto ===============]]
syntax = "proto3";
package common;

message Status {
  int32 code = 1;
  string message = 2;
}

[[=============== service.proto ===============]]
syntax = "proto3";
package myservice;

import "common.proto";

service MyService {
  rpc GetStatus(Request) returns (common.Status);
}
```

### 4. Select Service & Method

Choose from auto-discovered services and methods.

### 5. Build Request

JSON format:
```json
{
  "name": "World"
}
```

## Using google.protobuf.Any

For `Any` type fields, use `@type` to specify the message type:

```json
{
  "requestId": "123",
  "configData": {
    "@type": "type.googleapis.com/mypackage.MyMessage",
    "field_name": "value",
    "nested_field": 123
  }
}
```

**Important:**
- Top-level fields: camelCase (`requestId`, `configData`)
- Fields inside `@type`: snake_case (as defined in proto)

## Configuration Options

### Connection Settings
- **Host**: `hostname:port` (e.g., `localhost:50051`)
- **Use TLS**: Enable for secure connections

### Metadata
Add custom headers:
```
Key: Authorization
Value: Bearer token123
```

### Options
- **Timeout**: Request timeout in milliseconds
- **Response Format**: JSON or Raw

## Examples

### Basic Unary Call
```json
{
  "userId": "user-123",
  "action": "GET_PROFILE"
}
```

### With Nested Messages
```json
{
  "user": {
    "id": "123",
    "name": "John",
    "email": "john@example.com"
  },
  "preferences": {
    "theme": "dark",
    "notifications": true
  }
}
```

### With Repeated Fields
```json
{
  "taskIds": ["task-1", "task-2", "task-3"],
  "filters": [
    {"field": "status", "value": "active"},
    {"field": "priority", "value": "high"}
  ]
}
```

## Supported Features

| Feature | Status |
|---------|--------|
| Unary RPC | ✅ |
| Server Streaming | ✅ |
| Client Streaming | ❌ |
| Bidirectional Streaming | ❌ |
| TLS/SSL | ✅ |
| Custom Metadata | ✅ |
| google.protobuf.Any | ✅ |
| google.protobuf.Timestamp | ✅ |
| google.protobuf.Struct | ✅ |
| Enums | ✅ |
| Nested Messages | ✅ |
| Repeated Fields | ✅ |

## Troubleshooting

### "Service not found"
- Verify proto syntax is correct
- Check service name matches proto definition

### "Type not found" (Any type)
- Ensure `@type` URL is correct: `type.googleapis.com/package.MessageType`
- Verify the message type exists in your proto files

### "Enum error"
- Use exact enum name from proto (e.g., `RUNNING` not `running`)

### Import errors
- Use file delimiter syntax for multiple files
- Ensure imported file is defined before import

## License

MIT

## Links

- [n8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
- [gRPC Documentation](https://grpc.io/docs/)
- [Protocol Buffers Guide](https://protobuf.dev/)
