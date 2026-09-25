/**
 * Centralized application configuration loader
 * Loads configuration from /opt/authelia-admin/config.yml (or configured path)
 *
 * Environment variables use the AAD_ prefix (Authelia Admin):
 * - AAD_AUTHELIA_DOMAIN, AAD_AUTHELIA_COOKIE_NAME, etc.
 * - AAD_DIRECTORY_TYPE, AAD_DIRECTORY_LLDAP_GRAPHQL_ENDPOINT, etc.
 * - AAD_LOGLEVEL (DEBUG, INFO, WARN, ERROR)
 */

import { promises as fs } from 'node:fs';
import { parse } from 'yaml';
import { setLogLevel, createLogger } from './logger';

const log = createLogger('config');

// === Configuration Interfaces ===

export interface AutheliaConfig {
	domain: string;
	cookie_name: string;
	min_auth_level: number;
	allowed_users: string[];
}

export interface LLDAPGraphQLConfigFields {
	endpoint: string;
	user: string;
	password: string;
	ldap_host: string;
	ldap_port: number;
	ldap_base_dn?: string;
}

export interface FileProviderArgon2ConfigFields {
	variant: string;
	iterations: number;
	memory: number;
	parallelism: number;
	keyLength: number;
	saltLength: number;
}

export interface FileProviderPasswordConfigFields {
	algorithm: string;
	argon2: FileProviderArgon2ConfigFields;
}

export interface FileProviderConfigFields {
	path: string;
	password: FileProviderPasswordConfigFields;
}

export type DirectoryConfig =
	| { type: 'lldap-graphql'; 'lldap-graphql': LLDAPGraphQLConfigFields }
	| { type: 'file'; file: FileProviderConfigFields };

export interface AppConfig {
	authelia: AutheliaConfig;
	directory: DirectoryConfig;
	logging_level: string;
}

// === Default Values ===

const DEFAULT_CONFIG_PATH = '/opt/authelia-admin/config.yml';

const DEFAULT_AUTHELIA_CONFIG: AutheliaConfig = {
	domain: 'auth.localhost.test',
	cookie_name: 'authelia_session',
	min_auth_level: 2,
	allowed_users: []
};

const DEFAULT_LLDAP_GRAPHQL_CONFIG: LLDAPGraphQLConfigFields = {
	endpoint: 'http://lldap:17170/api/graphql',
	user: 'admin',
	password: '',
	ldap_host: 'lldap',
	ldap_port: 3890
};

// === Singleton State ===

let configInstance: AppConfig | null = null;
let configLoadPromise: Promise<AppConfig> | null = null;

// === Config Loading Functions ===

/**
 * Load and parse configuration from YAML file
 */
export async function loadConfig(
	configPath: string = process.env.AAD_CONFIG_PATH || process.env.CONFIG_PATH || DEFAULT_CONFIG_PATH
): Promise<AppConfig> {
	if (configInstance) {
		return configInstance;
	}

	if (configLoadPromise) {
		return configLoadPromise;
	}

	configLoadPromise = (async () => {
		try {
			const content = await fs.readFile(configPath, 'utf-8');
			const parsed = parse(content);

			// Parse logging level first so subsequent logs use the correct level
			const loggingLevel = parseLoggingLevel(parsed?.logging_level);
			setLogLevel(loggingLevel);

			configInstance = {
				authelia: parseAutheliaConfig(parsed?.authelia),
				directory: await parseDirectoryConfig(parsed?.directory),
				logging_level: loggingLevel
			};

			log.info(`Configuration loaded from ${configPath}`);
			return configInstance;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				log.warn(
					`Configuration file not found at ${configPath}, using defaults and environment variables`
				);
				configInstance = await loadFromEnvironment();
				return configInstance;
			}
			throw new Error(`Failed to load configuration: ${(error as Error).message}`);
		} finally {
			configLoadPromise = null;
		}
	})();

	return configLoadPromise;
}

/**
 * Get loaded configuration (throws if not loaded)
 */
export function getConfig(): AppConfig {
	if (!configInstance) {
		throw new Error('Configuration not loaded. Call loadConfig() first.');
	}
	return configInstance;
}

/**
 * Get configuration async (loads if needed)
 */
export async function getConfigAsync(): Promise<AppConfig> {
	return configInstance || loadConfig();
}

/**
 * Reset configuration singleton (for testing)
 */
export function resetConfig(): void {
	configInstance = null;
	configLoadPromise = null;
}

// === Parsing Helpers ===

function parseAutheliaConfig(config: unknown): AutheliaConfig {
	const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {};

	// Parse from YAML with env var substitution, then apply env var overrides
	const domain = process.env.AAD_AUTHELIA_DOMAIN ||
		substituteEnvVars(String(cfg.domain || DEFAULT_AUTHELIA_CONFIG.domain));

	const cookie_name = process.env.AAD_AUTHELIA_COOKIE_NAME ||
		substituteEnvVars(String(cfg.cookie_name || DEFAULT_AUTHELIA_CONFIG.cookie_name));

	const min_auth_level = process.env.AAD_AUTHELIA_MIN_AUTH_LEVEL
		? parseInt(process.env.AAD_AUTHELIA_MIN_AUTH_LEVEL, 10)
		: (cfg.min_auth_level !== undefined
			? Number(cfg.min_auth_level)
			: DEFAULT_AUTHELIA_CONFIG.min_auth_level);

	const allowed_users = process.env.AAD_AUTHELIA_ALLOWED_USERS
		? process.env.AAD_AUTHELIA_ALLOWED_USERS.split(',').map((u) => u.trim()).filter((u) => u.length > 0)
		: parseAllowedUsers(cfg.allowed_users);

	return { domain, cookie_name, min_auth_level, allowed_users };
}

async function parseDirectoryConfig(config: unknown): Promise<DirectoryConfig> {
	const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {};

	// Get type from env var or config
	const type = process.env.AAD_DIRECTORY_TYPE ||
		substituteEnvVars(String(cfg.type || 'lldap-graphql'));

	if (type === 'file') {
		return {
			type: 'file',
			file: await parseFileProviderConfig(cfg.file)
		};
	}

	if (type !== 'lldap-graphql') {
		throw new Error(`Unsupported directory type: ${type}`);
	}

	// Parse the type-specific config
	const lldapConfig = parseLLDAPGraphQLConfig(cfg['lldap-graphql']);

	return {
		type: 'lldap-graphql',
		'lldap-graphql': lldapConfig
	};
}

/**
 * Authelia's own defaults for authentication_backend.file.password.argon2,
 * used whenever a given field isn't explicitly set - matches what Authelia
 * itself applies, so we hash the same way it would.
 * See: https://www.authelia.com/configuration/first-factor/file/
 */
const DEFAULT_ARGON2_CONFIG: FileProviderArgon2ConfigFields = {
	variant: 'argon2id',
	iterations: 3,
	memory: 65536,
	parallelism: 4,
	keyLength: 32,
	saltLength: 16
};

/**
 * Resolve the file provider's users database path and password hashing
 * parameters. Uses AAD_DIRECTORY_FILE_PATH / directory.file.path if set,
 * otherwise falls back to reading `authentication_backend.file` from
 * Authelia's own configuration.yml (same file consulted for the storage
 * backend) - the password parameters always come from there, since they
 * must match whatever Authelia itself is configured to verify against.
 */
async function parseFileProviderConfig(config: unknown): Promise<FileProviderConfigFields> {
	const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {};

	const explicitPath = process.env.AAD_DIRECTORY_FILE_PATH ||
		(cfg.path ? substituteEnvVars(String(cfg.path)) : undefined);

	const autheliaFileSection = await readAutheliaFileProviderSection();
	const autheliaPath = autheliaFileSection?.path;
	const path = explicitPath || (typeof autheliaPath === 'string' && autheliaPath.length > 0 ? autheliaPath : undefined);
	if (!path) {
		throw new Error(
			'Directory file provider path is not configured. Set AAD_DIRECTORY_FILE_PATH, directory.file.path, ' +
			'or authentication_backend.file.path in the Authelia configuration.'
		);
	}

	return { path, password: parseFileProviderPasswordConfig(autheliaFileSection?.password) };
}

function parseFileProviderPasswordConfig(section: unknown): FileProviderPasswordConfigFields {
	const cfg = (section && typeof section === 'object') ? section as Record<string, unknown> : {};
	const algorithm = typeof cfg.algorithm === 'string' && cfg.algorithm.length > 0 ? cfg.algorithm : 'argon2';

	const argon2Cfg = (cfg.argon2 && typeof cfg.argon2 === 'object') ? cfg.argon2 as Record<string, unknown> : {};
	const argon2: FileProviderArgon2ConfigFields = {
		variant: typeof argon2Cfg.variant === 'string' && argon2Cfg.variant.length > 0
			? argon2Cfg.variant
			: DEFAULT_ARGON2_CONFIG.variant,
		iterations: numberOr(argon2Cfg.iterations, DEFAULT_ARGON2_CONFIG.iterations),
		memory: numberOr(argon2Cfg.memory, DEFAULT_ARGON2_CONFIG.memory),
		parallelism: numberOr(argon2Cfg.parallelism, DEFAULT_ARGON2_CONFIG.parallelism),
		keyLength: numberOr(argon2Cfg.key_length, DEFAULT_ARGON2_CONFIG.keyLength),
		saltLength: numberOr(argon2Cfg.salt_length, DEFAULT_ARGON2_CONFIG.saltLength)
	};

	return { algorithm, argon2 };
}

function numberOr(value: unknown, fallback: number): number {
	return value === undefined || value === null || value === '' ? fallback : Number(value);
}

const DEFAULT_AUTHELIA_CONFIG_PATH = '/config/configuration.yml';

async function readAutheliaFileProviderSection(): Promise<Record<string, unknown> | undefined> {
	const autheliaConfigPath = process.env.AAD_AUTHELIA_CONFIG_PATH ||
		process.env.AUTHELIA_CONFIG_PATH ||
		DEFAULT_AUTHELIA_CONFIG_PATH;

	let content: string;
	try {
		content = await fs.readFile(autheliaConfigPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw new Error(
			`Failed to read Authelia configuration "${autheliaConfigPath}" for file provider settings: ${(error as Error).message}`
		);
	}

	const parsed = parse(content);
	const authBackend = (parsed && typeof parsed === 'object')
		? (parsed as Record<string, unknown>).authentication_backend
		: undefined;
	const file = (authBackend && typeof authBackend === 'object')
		? (authBackend as Record<string, unknown>).file
		: undefined;

	return (file && typeof file === 'object') ? file as Record<string, unknown> : undefined;
}

function parseLLDAPGraphQLConfig(config: unknown): LLDAPGraphQLConfigFields {
	const cfg = (config && typeof config === 'object') ? config as Record<string, unknown> : {};

	// Each field can be overridden by AAD_DIRECTORY_LLDAP_GRAPHQL_* env vars
	const endpoint = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_ENDPOINT ||
		substituteEnvVars(String(cfg.endpoint || DEFAULT_LLDAP_GRAPHQL_CONFIG.endpoint));

	const user = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_USER ||
		substituteEnvVars(String(cfg.user || DEFAULT_LLDAP_GRAPHQL_CONFIG.user));

	const password = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_PASSWORD ||
		substituteEnvVars(String(cfg.password || DEFAULT_LLDAP_GRAPHQL_CONFIG.password));

	const ldap_host = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_LDAP_HOST ||
		substituteEnvVars(String(cfg.ldap_host || DEFAULT_LLDAP_GRAPHQL_CONFIG.ldap_host));

	const ldap_port = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_LDAP_PORT
		? parseInt(process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_LDAP_PORT, 10)
		: (cfg.ldap_port !== undefined
			? Number(cfg.ldap_port)
			: DEFAULT_LLDAP_GRAPHQL_CONFIG.ldap_port);

	// ldap_base_dn is optional with no default - must be explicitly configured
	const ldap_base_dn = process.env.AAD_DIRECTORY_LLDAP_GRAPHQL_LDAP_BASE_DN ||
		(cfg.ldap_base_dn ? substituteEnvVars(String(cfg.ldap_base_dn)) : undefined);

	return { endpoint, user, password, ldap_host, ldap_port, ldap_base_dn };
}

function parseAllowedUsers(users: unknown): string[] {
	if (Array.isArray(users)) {
		return users.map((u) => String(u).trim()).filter((u) => u.length > 0);
	}
	if (typeof users === 'string') {
		return users
			.split(',')
			.map((u) => u.trim())
			.filter((u) => u.length > 0);
	}
	return DEFAULT_AUTHELIA_CONFIG.allowed_users;
}

// === Environment Variable Fallbacks ===

async function loadFromEnvironment(): Promise<AppConfig> {
	const loggingLevel = parseLoggingLevel(undefined);
	setLogLevel(loggingLevel);

	return {
		authelia: parseAutheliaConfig({}),
		directory: await parseDirectoryConfig({}),
		logging_level: loggingLevel
	};
}

/**
 * Parse logging level from config or environment variable
 * Environment variable AAD_LOGLEVEL takes precedence
 */
function parseLoggingLevel(configValue: unknown): string {
	// Environment variable takes precedence
	if (process.env.AAD_LOGLEVEL) {
		return process.env.AAD_LOGLEVEL.toUpperCase();
	}

	// Then config file value
	if (typeof configValue === 'string') {
		return configValue.toUpperCase();
	}

	// Default to WARN
	return 'WARN';
}

function substituteEnvVars(value: string): string {
	return value.replace(/\$\{(\w+)\}/g, (_, envVar) => {
		return process.env[envVar] || '';
	});
}
