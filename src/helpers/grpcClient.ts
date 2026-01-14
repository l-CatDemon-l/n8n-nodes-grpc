/**
 * gRPC client utilities
 * Handles dynamic client creation and method invocation
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { GrpcConfig, MetadataEntry, GrpcCallOptions, ProtoFile } from './types';
import { parseProtoFiles } from './protoParser';

// Google well-known types for proto-loader
const WELL_KNOWN_PROTOS: ProtoFile[] = [
	{
		filename: 'google/protobuf/any.proto',
		content: `syntax = "proto3";
package google.protobuf;
option java_package = "com.google.protobuf";
message Any {
  string type_url = 1;
  bytes value = 2;
}`,
	},
	{
		filename: 'google/protobuf/struct.proto',
		content: `syntax = "proto3";
package google.protobuf;
message Struct { map<string, Value> fields = 1; }
message Value {
  oneof kind {
    NullValue null_value = 1;
    double number_value = 2;
    string string_value = 3;
    bool bool_value = 4;
    Struct struct_value = 5;
    ListValue list_value = 6;
  }
}
enum NullValue { NULL_VALUE = 0; }
message ListValue { repeated Value values = 1; }`,
	},
	{
		filename: 'google/protobuf/timestamp.proto',
		content: `syntax = "proto3";
package google.protobuf;
message Timestamp { int64 seconds = 1; int32 nanos = 2; }`,
	},
	{
		filename: 'google/protobuf/duration.proto',
		content: `syntax = "proto3";
package google.protobuf;
message Duration { int64 seconds = 1; int32 nanos = 2; }`,
	},
	{
		filename: 'google/protobuf/empty.proto',
		content: `syntax = "proto3";
package google.protobuf;
message Empty {}`,
	},
	{
		filename: 'google/protobuf/wrappers.proto',
		content: `syntax = "proto3";
package google.protobuf;
message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }`,
	},
];

/**
 * Create a gRPC client for a specific service
 */
export async function createGrpcClient(
	config: GrpcConfig,
	serviceName: string,
): Promise<GrpcClientWrapper> {
	// Write proto files to temp directory for proto-loader
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-grpc-'));

	try {
		// Write Google well-known types first
		for (const protoFile of WELL_KNOWN_PROTOS) {
			const filePath = path.join(tempDir, protoFile.filename);
			const dir = path.dirname(filePath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(filePath, protoFile.content);
		}

		// Write all user proto files to temp
		for (const protoFile of config.protoFiles) {
			const filePath = path.join(tempDir, protoFile.filename);
			const dir = path.dirname(filePath);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(filePath, protoFile.content);
		}

		// Load ALL proto files (not just the first one)
		const allProtoPaths = config.protoFiles.map((f) => path.join(tempDir, f.filename));

		// Load the proto definitions from all files
		const packageDefinition = await protoLoader.load(allProtoPaths, {
			keepCase: false, // Use camelCase for JSON compatibility (like Kreya)
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
			includeDirs: [tempDir],
		});

		const grpcObject = grpc.loadPackageDefinition(packageDefinition);

		// Find the service constructor
		const ServiceConstructor = findServiceConstructor(grpcObject, serviceName);
		if (!ServiceConstructor) {
			throw new Error(`Service "${serviceName}" not found in proto definitions`);
		}

		// Create credentials
		const credentials = config.useTls
			? grpc.credentials.createSsl()
			: grpc.credentials.createInsecure();

		// Create the client
		const client = new ServiceConstructor(config.host, credentials);

		// Parse protos for type information
		const root = parseProtoFiles(config.protoFiles);

		return new GrpcClientWrapper(client, root, serviceName, tempDir);
	} catch (error) {
		// Clean up temp directory on error
		cleanupTempDir(tempDir);
		throw error;
	}
}

/**
 * Find service constructor in the loaded grpc object
 */
function findServiceConstructor(
	grpcObject: grpc.GrpcObject,
	serviceName: string,
): grpc.ServiceClientConstructor | null {
	const parts = serviceName.split('.');

	let current: grpc.GrpcObject | grpc.ServiceClientConstructor = grpcObject;

	for (const part of parts) {
		if (current && typeof current === 'object' && part in current) {
			current = (current as Record<string, unknown>)[part] as grpc.GrpcObject;
		} else {
			return null;
		}
	}

	// Check if it's a service constructor
	if (typeof current === 'function' && 'service' in current) {
		return current as unknown as grpc.ServiceClientConstructor;
	}

	return null;
}

/**
 * Clean up temporary directory
 */
function cleanupTempDir(tempDir: string): void {
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

/**
 * Convert metadata entries to gRPC Metadata object
 */
export function createMetadata(entries: MetadataEntry[]): grpc.Metadata {
	const metadata = new grpc.Metadata();
	for (const entry of entries) {
		const key = entry.key?.trim();
		const value = entry.value?.trim();
		if (key && value) {
			// HTTP/2 header names are lowercase on the wire.
			// Some backends are strict about the metadata key casing.
			metadata.add(key.toLowerCase(), value);
		}
	}
	return metadata;
}

/**
 * Decode google.protobuf.Any value to JSON
 * Converts { type_url: "type.googleapis.com/pkg.Type", value: Buffer } to { @type: "...", ...fields }
 */
function decodeAnyValue(
	anyValue: { type_url?: string; value?: Buffer | Uint8Array },
	root: protobuf.Root,
): Record<string, unknown> {
	if (!anyValue || !anyValue.type_url) {
		return anyValue as Record<string, unknown>;
	}

	const typeUrl = anyValue.type_url;
	// Extract type name from type_url (e.g., "type.googleapis.com/pkg.MyType" -> "pkg.MyType")
	const typeName = typeUrl.includes('/') ? typeUrl.split('/').pop()! : typeUrl;

	try {
		// Try to lookup the type
		let messageType: protobuf.Type | null = null;
		try {
			messageType = root.lookupType(typeName);
		} catch {
			// Try with leading dot
			try {
				messageType = root.lookupType('.' + typeName);
			} catch (lookupError) {
				console.warn(`Failed to lookup type for decoding: ${typeName}`, lookupError);
				// Return base64 encoded value
				return {
					'@type': typeUrl,
					value: anyValue.value ? Buffer.from(anyValue.value).toString('base64') : null,
				};
			}
		}

		if (messageType && anyValue.value) {
			const valueBuffer = anyValue.value instanceof Buffer
				? anyValue.value
				: Buffer.from(anyValue.value);
			const decoded = messageType.decode(valueBuffer);
			const jsonObj = messageType.toObject(decoded, {
				longs: String,
				enums: String,
				bytes: String,
				defaults: true,
			});
			return {
				'@type': typeUrl,
				...jsonObj,
			};
		}
	} catch (error) {
		console.error(`Failed to decode Any type ${typeName}:`, error);
		// Return base64 encoded value as fallback
		return {
			'@type': typeUrl,
			value: anyValue.value ? Buffer.from(anyValue.value).toString('base64') : null,
		};
	}

	return {
		'@type': typeUrl,
		value: anyValue.value ? Buffer.from(anyValue.value).toString('base64') : null,
	};
}

/**
 * Encode JSON with @type to google.protobuf.Any format
 * Converts { @type: "type.googleapis.com/pkg.Type", ...fields } to { type_url: "...", value: Buffer }
 */
function encodeAnyValue(
	jsonValue: Record<string, unknown>,
	root: protobuf.Root,
): { type_url: string; value: Buffer } | Record<string, unknown> {
	if (!jsonValue || !jsonValue['@type']) {
		return jsonValue;
	}

	const typeUrl = jsonValue['@type'] as string;
	const typeName = typeUrl.includes('/') ? typeUrl.split('/').pop()! : typeUrl;

	try {
		// Try to lookup the type
		let messageType: protobuf.Type | null = null;
		try {
			messageType = root.lookupType(typeName);
		} catch (lookupError) {
			// Try with leading dot
			try {
				messageType = root.lookupType('.' + typeName);
			} catch {
				console.error(`Failed to lookup type: ${typeName}`, lookupError);
				throw new Error(`Type not found: ${typeName}`);
			}
		}

		if (messageType) {
			// Remove @type from the object before encoding
			const { '@type': _, ...messageFields } = jsonValue;

			// Verify the message structure
			const errMsg = messageType.verify(messageFields);
			if (errMsg) {
				console.error(`Message verification failed for ${typeName}:`, errMsg);
				throw new Error(`Invalid message structure: ${errMsg}`);
			}

			// Create and encode the message
			const message = messageType.create(messageFields);
			const encoded = messageType.encode(message).finish();

			return {
				type_url: typeUrl,
				value: Buffer.from(encoded),
			};
		}
	} catch (error) {
		console.error(`Failed to encode Any type ${typeName}:`, error);
		throw error; // Re-throw instead of silently returning
	}

	throw new Error(`Failed to encode Any type: ${typeName}`);
}

/**
 * Recursively process response to decode Any types
 */
function processResponseForAny(
	obj: unknown,
	root: protobuf.Root,
): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => processResponseForAny(item, root));
	}

	if (typeof obj === 'object') {
		const record = obj as Record<string, unknown>;

		// Check if this is an Any type (has type_url and value)
		if ('type_url' in record && 'value' in record) {
			return decodeAnyValue(record as { type_url: string; value: Buffer }, root);
		}

		// Recursively process all fields
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			result[key] = processResponseForAny(value, root);
		}
		return result;
	}

	return obj;
}

/**
 * Recursively process request to encode Any types
 */
function processRequestForAny(
	obj: unknown,
	root: protobuf.Root,
): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item) => processRequestForAny(item, root));
	}

	if (typeof obj === 'object') {
		const record = obj as Record<string, unknown>;

		// Check if this is an Any type in JSON format (has @type)
		if ('@type' in record) {
			return encodeAnyValue(record, root);
		}

		// Recursively process all fields
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(record)) {
			result[key] = processRequestForAny(value, root);
		}
		return result;
	}

	return obj;
}

/**
 * Wrapper class for gRPC client operations
 */
export class GrpcClientWrapper {
	private client: grpc.Client;
	private root: protobuf.Root;
	private serviceName: string;
	private tempDir: string;

	constructor(
		client: grpc.Client,
		root: protobuf.Root,
		serviceName: string,
		tempDir: string,
	) {
		this.client = client;
		this.root = root;
		this.serviceName = serviceName;
		this.tempDir = tempDir;
	}

	/**
	 * Invoke a unary gRPC method
	 */
	async invokeUnary(
		methodName: string,
		request: Record<string, unknown>,
		metadata: MetadataEntry[],
		options: GrpcCallOptions = {},
	): Promise<Record<string, unknown>> {
		const grpcMetadata = createMetadata(metadata);
		const callOptions: grpc.CallOptions = {};

		if (options.timeout) {
			callOptions.deadline = new Date(Date.now() + options.timeout);
		}

		// Process request to encode Any types
		const processedRequest = processRequestForAny(request, this.root) as Record<string, unknown>;

		return new Promise((resolve, reject) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const method = (this.client as any)[methodName];

			if (typeof method !== 'function') {
				reject(new Error(`Method "${methodName}" not found on service "${this.serviceName}"`));
				return;
			}

			(method as Function).call(
				this.client,
				processedRequest,
				grpcMetadata,
				callOptions,
				(error: grpc.ServiceError | null, response: Record<string, unknown>) => {
					if (error) {
						reject(new Error(`gRPC error (${error.code}): ${error.message}`));
					} else {
						// Process response to decode Any types
						const processedResponse = processResponseForAny(response, this.root) as Record<string, unknown>;
						resolve(processedResponse);
					}
				},
			);
		});
	}

	/**
	 * Invoke a server streaming gRPC method
	 */
	async invokeServerStreaming(
		methodName: string,
		request: Record<string, unknown>,
		metadata: MetadataEntry[],
		options: GrpcCallOptions = {},
	): Promise<Record<string, unknown>[]> {
		const grpcMetadata = createMetadata(metadata);
		const callOptions: grpc.CallOptions = {};

		if (options.timeout) {
			callOptions.deadline = new Date(Date.now() + options.timeout);
		}

		// Process request to encode Any types
		const processedRequest = processRequestForAny(request, this.root) as Record<string, unknown>;

		return new Promise((resolve, reject) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const method = (this.client as any)[methodName];

			if (typeof method !== 'function') {
				reject(new Error(`Method "${methodName}" not found on service "${this.serviceName}"`));
				return;
			}

			const call = (method as Function).call(
				this.client,
				processedRequest,
				grpcMetadata,
				callOptions,
			) as grpc.ClientReadableStream<Record<string, unknown>>;

			const results: Record<string, unknown>[] = [];

			call.on('data', (data: Record<string, unknown>) => {
				// Process each response to decode Any types
				const processedData = processResponseForAny(data, this.root) as Record<string, unknown>;
				results.push(processedData);
			});

			call.on('error', (error: grpc.ServiceError) => {
				reject(new Error(`gRPC stream error (${error.code}): ${error.message}`));
			});

			call.on('end', () => {
				resolve(results);
			});
		});
	}

	/**
	 * Get method information from the proto root
	 */
	getMethodInfo(methodName: string): { requestStream: boolean; responseStream: boolean } | null {
		try {
			const service = this.root.lookupService(this.serviceName);
			const method = service.methods[methodName];
			if (method) {
				return {
					requestStream: method.requestStream || false,
					responseStream: method.responseStream || false,
				};
			}
		} catch {
			// Method not found
		}
		return null;
	}

	/**
	 * Close the client and clean up resources
	 */
	close(): void {
		this.client.close();
		cleanupTempDir(this.tempDir);
	}
}
