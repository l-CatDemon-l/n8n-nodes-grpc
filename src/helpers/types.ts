/**
 * Shared type definitions for gRPC node
 */

export interface ProtoFile {
	filename: string;
	content: string;
}

export interface MetadataEntry {
	key: string;
	value: string;
}

export interface GrpcConfig {
	host: string;
	useTls: boolean;
	metadata: MetadataEntry[];
	protoFiles: ProtoFile[];
}

export interface ServiceInfo {
	name: string;
	fullName: string;
	methods: MethodInfo[];
}

export interface MethodInfo {
	name: string;
	requestType: string;
	responseType: string;
	requestStream: boolean;
	responseStream: boolean;
}

export interface GrpcCallOptions {
	timeout?: number;
	responseFormat?: 'json' | 'raw';
}
