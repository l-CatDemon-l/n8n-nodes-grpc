import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * gRPC API Credentials
 *
 * Stores connection details for gRPC services:
 * - Host endpoint
 * - TLS configuration
 * - Custom metadata headers (as JSON)
 * - Protobuf definitions (delimiter-based format for multiple files)
 */
export class GrpcApi implements ICredentialType {
	name = 'grpcApi';

	displayName = 'gRPC API';

	documentationUrl = 'https://grpc.io/docs/';

	properties: INodeProperties[] = [
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'localhost:50051',
			required: true,
			placeholder: 'my-grpc-service.example.com:443',
			description: 'The gRPC server host and port (e.g., localhost:50051 or service.domain:443)',
		},
		{
			displayName: 'Use TLS',
			name: 'useTls',
			type: 'boolean',
			default: false,
			description: 'Whether to use TLS/SSL for the connection',
		},
		{
			displayName: 'Metadata (JSON)',
			name: 'metadataJson',
			type: 'json',
			default: '{}',
			description:
				'Custom metadata headers as JSON object. Example: {"Authorization": "Bearer token", "x-api-key": "key123"}',
		},
		{
			displayName: 'Protobuf Definitions',
			name: 'protoContent',
			type: 'string',
			typeOptions: {
				rows: 25,
			},
			default: '',
			description:
				'Paste your proto file(s) here. For multiple files, use delimiter: ===== filename.proto =====',
			placeholder: `===== service.proto =====
syntax = "proto3";

package myservice;

import "common.proto";

service MyService {
  rpc SayHello (HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
}

===== common.proto =====
syntax = "proto3";

package common;

message Metadata {
  string request_id = 1;
}`,
		},
	];
}
