/**
 * Proto parsing utilities using protobufjs
 * Handles parsing of proto text content and service/method discovery
 */

import * as protobuf from 'protobufjs';
import type { ProtoFile, ServiceInfo, MethodInfo } from './types';

// Google well-known types proto definitions
const GOOGLE_PROTOBUF_ANY = `
syntax = "proto3";
package google.protobuf;

message Any {
  string type_url = 1;
  bytes value = 2;
}
`;

const GOOGLE_PROTOBUF_STRUCT = `
syntax = "proto3";
package google.protobuf;

message Struct {
  map<string, Value> fields = 1;
}

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

enum NullValue {
  NULL_VALUE = 0;
}

message ListValue {
  repeated Value values = 1;
}
`;

const GOOGLE_PROTOBUF_WRAPPERS = `
syntax = "proto3";
package google.protobuf;

message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }
`;

const GOOGLE_PROTOBUF_TIMESTAMP = `
syntax = "proto3";
package google.protobuf;

message Timestamp {
  int64 seconds = 1;
  int32 nanos = 2;
}
`;

const GOOGLE_PROTOBUF_DURATION = `
syntax = "proto3";
package google.protobuf;

message Duration {
  int64 seconds = 1;
  int32 nanos = 2;
}
`;

const GOOGLE_PROTOBUF_EMPTY = `
syntax = "proto3";
package google.protobuf;

message Empty {}
`;

/**
 * Get all Google well-known type definitions
 */
function getWellKnownTypes(): ProtoFile[] {
	return [
		{ filename: 'google/protobuf/any.proto', content: GOOGLE_PROTOBUF_ANY },
		{ filename: 'google/protobuf/struct.proto', content: GOOGLE_PROTOBUF_STRUCT },
		{ filename: 'google/protobuf/wrappers.proto', content: GOOGLE_PROTOBUF_WRAPPERS },
		{ filename: 'google/protobuf/timestamp.proto', content: GOOGLE_PROTOBUF_TIMESTAMP },
		{ filename: 'google/protobuf/duration.proto', content: GOOGLE_PROTOBUF_DURATION },
		{ filename: 'google/protobuf/empty.proto', content: GOOGLE_PROTOBUF_EMPTY },
	];
}

/**
 * Parse delimiter-based proto content into separate files
 * Format: [[=============== filename.proto ===============]]
 *         <content>
 *         [[=============== another.proto ===============]]
 *         <content>
 *
 * The number of = characters is flexible (1 or more on each side)
 * If no delimiter found, treats entire content as single file "main.proto"
 */
export function parseDelimitedProtoContent(content: string): ProtoFile[] {
	if (!content || !content.trim()) {
		return [];
	}

	// Pattern: [[=+ filename.proto =+]]
	// - \[\[ matches opening [[
	// - =+ matches one or more = characters
	// - \s* matches optional whitespace
	// - ([^\]=]+\.proto) captures filename ending in .proto (no ] or = in name)
	// - \s* matches optional whitespace
	// - =+ matches one or more = characters
	// - \]\] matches closing ]]
	const delimiterRegex = /^\[\[=+\s*([^\]=]+\.proto)\s*=+\]\]\s*$/gm;
	const files: ProtoFile[] = [];

	// Check if content has delimiters
	const matches = [...content.matchAll(delimiterRegex)];

	if (matches.length === 0) {
		// No delimiters - treat as single file
		return [{ filename: 'main.proto', content: content.trim() }];
	}

	// Parse multiple files
	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const filename = match[1].trim();
		const startIndex = match.index! + match[0].length;
		const endIndex = i + 1 < matches.length ? matches[i + 1].index! : content.length;

		const fileContent = content.slice(startIndex, endIndex).trim();
		if (fileContent) {
			files.push({ filename, content: fileContent });
		}
	}

	return files;
}

/**
 * Parse multiple proto files from text content
 * Supports import resolution between files using virtual filesystem
 * Automatically includes Google well-known types (Any, Struct, Timestamp, etc.)
 */
export function parseProtoFiles(protoFiles: ProtoFile[]): protobuf.Root {
	const root = new protobuf.Root();

	// Include Google well-known types first
	const wellKnownTypes = getWellKnownTypes();
	const allFiles = [...wellKnownTypes, ...protoFiles];

	// Create a map for import resolution
	const fileMap = new Map<string, string>();
	for (const file of allFiles) {
		fileMap.set(file.filename, file.content);
		// Also map without path for simple imports
		const basename = file.filename.split('/').pop() || file.filename;
		if (!fileMap.has(basename)) {
			fileMap.set(basename, file.content);
		}
	}

	// Custom resolve path - just return the target as-is
	root.resolvePath = (_origin: string, target: string): string => target;

	// Parse well-known types first (silently ignore errors as they may already exist)
	for (const file of wellKnownTypes) {
		try {
			protobuf.parse(file.content, root);
		} catch {
			// Ignore - type may already be defined
		}
	}

	// Parse user proto files
	for (const file of protoFiles) {
		try {
			protobuf.parse(file.content, root);
		} catch (error) {
			throw new Error(`Failed to parse proto file "${file.filename}": ${(error as Error).message}`);
		}
	}

	// Resolve all types
	root.resolveAll();

	return root;
}

/**
 * Discover all services defined in the proto root
 */
export function discoverServices(root: protobuf.Root): ServiceInfo[] {
	const services: ServiceInfo[] = [];

	function walkNamespace(ns: protobuf.NamespaceBase, parentPath: string = ''): void {
		for (const nested of ns.nestedArray) {
			const currentPath = parentPath ? `${parentPath}.${nested.name}` : nested.name;

			if (nested instanceof protobuf.Service) {
				const methods: MethodInfo[] = [];

				for (const method of nested.methodsArray) {
					methods.push({
						name: method.name,
						requestType: method.requestType,
						responseType: method.responseType,
						requestStream: method.requestStream || false,
						responseStream: method.responseStream || false,
					});
				}

				services.push({
					name: nested.name,
					fullName: currentPath,
					methods,
				});
			}

			if (nested instanceof protobuf.Namespace) {
				walkNamespace(nested, currentPath);
			}
		}
	}

	walkNamespace(root);
	return services;
}

/**
 * Get the request type for a specific service method
 */
export function getMethodRequestType(
	root: protobuf.Root,
	serviceName: string,
	methodName: string,
): protobuf.Type | null {
	try {
		const service = root.lookupService(serviceName);
		const method = service.methods[methodName];
		if (method) {
			return root.lookupType(method.requestType);
		}
	} catch {
		// Service or method not found
	}
	return null;
}

/**
 * Get the response type for a specific service method
 */
export function getMethodResponseType(
	root: protobuf.Root,
	serviceName: string,
	methodName: string,
): protobuf.Type | null {
	try {
		const service = root.lookupService(serviceName);
		const method = service.methods[methodName];
		if (method) {
			return root.lookupType(method.responseType);
		}
	} catch {
		// Service or method not found
	}
	return null;
}

/**
 * Generate a default request body skeleton from a message type
 */
export function generateRequestSkeleton(type: protobuf.Type): Record<string, unknown> {
	const obj: Record<string, unknown> = {};

	for (const field of type.fieldsArray) {
		const value = getFieldDefault(field);
		if (field.repeated) {
			obj[field.name] = [value];
		} else {
			obj[field.name] = value;
		}
	}

	return obj;
}

/**
 * Get default value for a field based on its type
 */
function getFieldDefault(field: protobuf.Field): unknown {
	// Handle nested message types
	if (field.resolvedType instanceof protobuf.Type) {
		const fullName = field.resolvedType.fullName;

		// Handle google.protobuf.Any - provide a template structure
		if (fullName === '.google.protobuf.Any') {
			return {
				'@type': 'type.googleapis.com/your.message.Type',
				// Add fields of the actual message here
			};
		}

		// Handle google.protobuf.Timestamp
		if (fullName === '.google.protobuf.Timestamp') {
			return {
				seconds: 0,
				nanos: 0,
			};
		}

		// Handle google.protobuf.Duration
		if (fullName === '.google.protobuf.Duration') {
			return {
				seconds: 0,
				nanos: 0,
			};
		}

		// Handle google.protobuf.Struct
		if (fullName === '.google.protobuf.Struct') {
			return {
				fields: {},
			};
		}

		// Handle google.protobuf.Value
		if (fullName === '.google.protobuf.Value') {
			return {
				string_value: '',
			};
		}

		// Handle wrapper types
		if (fullName.startsWith('.google.protobuf.') && fullName.endsWith('Value')) {
			return { value: getWrapperDefault(fullName) };
		}

		// Handle google.protobuf.Empty
		if (fullName === '.google.protobuf.Empty') {
			return {};
		}

		return generateRequestSkeleton(field.resolvedType);
	}

	// Handle enum types
	if (field.resolvedType instanceof protobuf.Enum) {
		const values = Object.keys(field.resolvedType.values);
		return values[0] || 0;
	}

	// Scalar type defaults
	switch (field.type) {
		case 'double':
		case 'float':
			return 0.0;
		case 'int32':
		case 'int64':
		case 'uint32':
		case 'uint64':
		case 'sint32':
		case 'sint64':
		case 'fixed32':
		case 'fixed64':
		case 'sfixed32':
		case 'sfixed64':
			return 0;
		case 'bool':
			return false;
		case 'string':
			return '';
		case 'bytes':
			return '';
		default:
			return null;
	}
}

/**
 * Get default value for wrapper types
 */
function getWrapperDefault(fullName: string): unknown {
	if (fullName.includes('Double') || fullName.includes('Float')) return 0.0;
	if (fullName.includes('Int') || fullName.includes('UInt')) return 0;
	if (fullName.includes('Bool')) return false;
	if (fullName.includes('String')) return '';
	if (fullName.includes('Bytes')) return '';
	return null;
}

/**
 * Generate proto definition string for @grpc/proto-loader
 * Combines all proto files into a format that can be loaded
 */
export function createProtoDefinitionForLoader(protoFiles: ProtoFile[]): {
	protoContent: string;
	includeDirs: string[];
} {
	// For proto-loader, we need to write to temp or use the direct parse approach
	// We'll return the main proto content and handle imports via custom loader
	const mainFile = protoFiles[0];
	return {
		protoContent: mainFile?.content || '',
		includeDirs: [],
	};
}
