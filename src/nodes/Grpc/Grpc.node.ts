import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { GrpcConfig, MetadataEntry, ProtoFile } from '../../helpers/types';
import {
	parseProtoFiles,
	parseDelimitedProtoContent,
	discoverServices,
	getMethodRequestType,
	generateRequestSkeleton,
} from '../../helpers/protoParser';
import { createGrpcClient } from '../../helpers/grpcClient';

export class Grpc implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'gRPC',
		name: 'grpc',
		icon: 'file:grpc.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["service"] + "." + $parameter["method"]}}',
		description: 'Execute gRPC calls to any service defined in protobuf',
		defaults: {
			name: 'gRPC',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'grpcApi',
				required: false,
				displayOptions: {
					show: {
						'/useCredentials': [true],
					},
				},
			},
		],
		properties: [
			// Toggle for using credentials
			{
				displayName: 'Use Credentials',
				name: 'useCredentials',
				type: 'boolean',
				default: false,
				description: 'Whether to use saved credentials (when enabled) or define connection details below',
			},
			// Override connection settings - NO displayOptions to persist data across mode switches
			{
				displayName: 'Connection Settings',
				name: 'connectionSettings',
				type: 'collection',
				placeholder: 'Configure Connection',
				default: {},
				description: 'Connection settings (only used when "Override / Define Here" is selected)',
				options: [
					{
						displayName: 'Host',
						name: 'host',
						type: 'string',
						default: 'localhost:50051',
						placeholder: 'my-grpc-service.example.com:443',
						description: 'The gRPC server host and port',
					},
					{
						displayName: 'Use TLS',
						name: 'useTls',
						type: 'boolean',
						default: false,
						description: 'Whether to use TLS/SSL for the connection',
					},
				],
			},
			{
				displayName: 'Metadata',
				name: 'overrideMetadata',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				placeholder: 'Add Metadata Entry',
				description: 'Custom metadata headers (only used when "Override / Define Here" is selected)',
				options: [
					{
						name: 'entries',
						displayName: 'Metadata Entries',
						values: [
							{
								displayName: 'Key',
								name: 'key',
								type: 'string',
								default: '',
								placeholder: 'Authorization',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								placeholder: 'Bearer token...',
							},
						],
					},
				],
			},
			{
				displayName: 'Protobuf Definitions',
				name: 'overrideProtoFiles',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				placeholder: 'Add Proto File',
				description: 'Protobuf definition files (only used when "Override / Define Here" is selected)',
				options: [
					{
						name: 'files',
						displayName: 'Proto Files',
						values: [
							{
								displayName: 'Filename',
								name: 'filename',
								type: 'string',
								default: 'service.proto',
							},
							{
								displayName: 'Content',
								name: 'content',
								type: 'string',
								typeOptions: {
									rows: 10,
								},
								default: '',
							},
						],
					},
				],
			},

			// Service selection
			{
				displayName: 'Service Name or ID',
				name: 'service',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getServices',
				},
				default: '',
				required: true,
				description:
					'The gRPC service to call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// Method selection
			{
				displayName: 'Method Name or ID',
				name: 'method',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getMethods',
					loadOptionsDependsOn: ['service'],
				},
				default: '',
				required: true,
				description:
					'The method to invoke. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// Request body
			{
				displayName: 'Request Body',
				name: 'requestBody',
				type: 'json',
				default: '{}',
				required: true,
				description:
					'The request payload as JSON. Use the "Generate Skeleton" button to auto-fill based on the selected method.',
			},

			// Options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						default: 30000,
						description: 'Request timeout in milliseconds',
					},
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						type: 'options',
						options: [
							{
								name: 'JSON',
								value: 'json',
								description: 'Parse response as JSON object',
							},
							{
								name: 'Raw',
								value: 'raw',
								description: 'Return raw response data',
							},
						],
						default: 'json',
						description: 'How to format the response data',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			/**
			 * Get available services from proto definitions
			 */
			async getServices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const config = await getConfig(this);
					const root = parseProtoFiles(config.protoFiles);
					const services = discoverServices(root);

					return services.map((service) => ({
						name: service.fullName,
						value: service.fullName,
						description: `${service.methods.length} method(s)`,
					}));
				} catch (error) {
					return [
						{
							name: 'Error loading services - check proto definitions',
							value: '',
							description: (error as Error).message,
						},
					];
				}
			},

			/**
			 * Get available methods for the selected service
			 */
			async getMethods(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const config = await getConfig(this);
					const serviceName = this.getCurrentNodeParameter('service') as string;

					if (!serviceName) {
						return [{ name: 'Select a service first', value: '' }];
					}

					const root = parseProtoFiles(config.protoFiles);
					const services = discoverServices(root);
					const service = services.find((s) => s.fullName === serviceName);

					if (!service) {
						return [{ name: 'Service not found', value: '' }];
					}

					return service.methods.map((method) => {
						const streamInfo = [];
						if (method.requestStream) streamInfo.push('client streaming');
						if (method.responseStream) streamInfo.push('server streaming');

						return {
							name: method.name,
							value: method.name,
							description:
								streamInfo.length > 0
									? `${method.requestType} → ${method.responseType} (${streamInfo.join(', ')})`
									: `${method.requestType} → ${method.responseType}`,
						};
					});
				} catch (error) {
					return [
						{
							name: 'Error loading methods',
							value: '',
							description: (error as Error).message,
						},
					];
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Get configuration
		const config = await getConfig(this);
		const serviceName = this.getNodeParameter('service', 0) as string;

		if (!config.protoFiles.length) {
			throw new NodeOperationError(this.getNode(), 'No protobuf definitions provided');
		}

		if (!serviceName) {
			throw new NodeOperationError(this.getNode(), 'No service selected');
		}

		// Create the gRPC client
		const client = await createGrpcClient(config, serviceName);

		try {
			for (let i = 0; i < items.length; i++) {
				const methodName = this.getNodeParameter('method', i) as string;
				const requestBody = this.getNodeParameter('requestBody', i) as string;
				const options = this.getNodeParameter('options', i) as {
					timeout?: number;
					responseFormat?: 'json' | 'raw';
				};

				if (!methodName) {
					throw new NodeOperationError(this.getNode(), 'No method selected', { itemIndex: i });
				}

				// Parse request body
				let request: Record<string, unknown>;
				try {
					request = JSON.parse(requestBody);
				} catch {
					throw new NodeOperationError(this.getNode(), 'Invalid JSON in request body', {
						itemIndex: i,
					});
				}

				// Get method info to determine call type
				const methodInfo = client.getMethodInfo(methodName);

				let response: Record<string, unknown> | Record<string, unknown>[];

				if (methodInfo?.responseStream) {
					// Server streaming call
					response = await client.invokeServerStreaming(methodName, request, config.metadata, {
						timeout: options.timeout,
						responseFormat: options.responseFormat,
					});

					// For streaming, each response becomes a separate item
					if (Array.isArray(response)) {
						for (const item of response) {
							returnData.push({ json: item as IDataObject });
						}
						continue;
					}
				} else {
					// Unary call
					response = await client.invokeUnary(methodName, request, config.metadata, {
						timeout: options.timeout,
						responseFormat: options.responseFormat,
					});
				}

				returnData.push({ json: response as IDataObject });
			}
		} finally {
			// Clean up client
			client.close();
		}

		return [returnData];
	}
}

/**
 * Normalize n8n fixedCollection shapes to a plain array.
 *
 * n8n can serialize fixedCollection values differently across versions:
 * - { groupName: T[] }
 * - { groupName: T }
 * - Array<{ groupName: T }> (when multipleValues is enabled)
 * - Array<T> (in some older/newer combinations)
 */
function normalizeFixedCollectionArray<T extends object>(
	raw: unknown,
	groupName: string,
): T[] {
	if (!raw) return [];

	// Shape: { groupName: T[] } or { groupName: T }
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		const groupValue = (raw as Record<string, unknown>)[groupName];
		if (Array.isArray(groupValue)) return groupValue as T[];
		if (groupValue && typeof groupValue === 'object') return [groupValue as T];
		return [];
	}

	// Shape: Array<...>
	if (Array.isArray(raw)) {
		const result: T[] = [];
		for (const item of raw) {
			// Array<{ groupName: T }>
			if (item && typeof item === 'object' && !Array.isArray(item) && groupName in (item as object)) {
				const v = (item as Record<string, unknown>)[groupName];
				if (Array.isArray(v)) result.push(...(v as T[]));
				else if (v && typeof v === 'object') result.push(v as T);
				continue;
			}
			// Array<T>
			if (item && typeof item === 'object' && !Array.isArray(item)) {
				result.push(item as T);
			}
		}
		return result;
	}

	return [];
}

/**
 * Get gRPC configuration from credentials or node parameters
 */
async function getConfig(context: IExecuteFunctions | ILoadOptionsFunctions): Promise<GrpcConfig> {
	const useCredentials = context.getNodeParameter('useCredentials', 0, true) as boolean;

	if (useCredentials) {
		// Get from credentials
		let credentials;
		try {
			credentials = await context.getCredentials('grpcApi');
		} catch {
			// No credentials selected, fall through to use override settings
			credentials = null;
		}

		if (!credentials) {
			// No credentials, use override settings instead
			const connectionSettings = (context.getNodeParameter('connectionSettings', 0, {}) as {
				host?: string;
				useTls?: boolean;
			}) || {};
			const metadataRaw = context.getNodeParameter('overrideMetadata', 0, {}) as unknown;
			const protoFilesRaw = context.getNodeParameter('overrideProtoFiles', 0, {}) as unknown;

			return {
				host: connectionSettings.host || 'localhost:50051',
				useTls: connectionSettings.useTls || false,
				metadata: normalizeFixedCollectionArray<MetadataEntry>(metadataRaw, 'entries'),
				protoFiles: normalizeFixedCollectionArray<ProtoFile>(protoFilesRaw, 'files'),
			};
		}

		// Parse metadata from JSON
		let metadata: MetadataEntry[] = [];
		const metadataJson = credentials.metadataJson as string;
		if (metadataJson) {
			try {
				const parsed = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
				// Convert object format {"key": "value"} to array format [{key, value}]
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					metadata = Object.entries(parsed).map(([key, value]) => ({
						key,
						value: String(value),
					}));
				}
			} catch {
				// Invalid JSON, use empty array
			}
		}

		// Parse proto files from delimiter-based content
		const protoContent = credentials.protoContent as string;
		const protoFiles = parseDelimitedProtoContent(protoContent || '');

		return {
			host: credentials.host as string,
			useTls: credentials.useTls as boolean,
			metadata,
			protoFiles,
		};
	} else {
		// Get from node parameters (collection and fixedCollection format)
		const connectionSettings = (context.getNodeParameter('connectionSettings', 0, {}) as {
			host?: string;
			useTls?: boolean;
		}) || {};
		const metadataRaw = context.getNodeParameter('overrideMetadata', 0, {}) as unknown;
		const protoFilesRaw = context.getNodeParameter('overrideProtoFiles', 0, {}) as unknown;

		return {
			host: connectionSettings.host || 'localhost:50051',
			useTls: connectionSettings.useTls || false,
			metadata: normalizeFixedCollectionArray<MetadataEntry>(metadataRaw, 'entries'),
			protoFiles: normalizeFixedCollectionArray<ProtoFile>(protoFilesRaw, 'files'),
		};
	}
}

/**
 * Generate a request body skeleton for a method
 * This can be called to help users fill in the request body
 */
export function generateMethodSkeleton(
	protoFiles: ProtoFile[],
	serviceName: string,
	methodName: string,
): Record<string, unknown> {
	const root = parseProtoFiles(protoFiles);
	const requestType = getMethodRequestType(root, serviceName, methodName);

	if (!requestType) {
		return {};
	}

	return generateRequestSkeleton(requestType);
}
