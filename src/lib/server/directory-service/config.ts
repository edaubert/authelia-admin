/**
 * Directory service configuration types
 * Configuration is loaded from the centralized config module
 */

export interface LLDAPGraphQLConfig {
	type: 'lldap-graphql';
	endpoint: string;
	user: string;
	password: string;
	ldap_host: string;
	ldap_port: number;
	ldap_base_dn?: string;
}

export interface FileProviderArgon2Config {
	variant: string;
	iterations: number;
	memory: number;
	parallelism: number;
	keyLength: number;
	saltLength: number;
}

export interface FileProviderPasswordConfig {
	// As configured in Authelia's authentication_backend.file.password.algorithm.
	// Only 'argon2' (with variant 'argon2id') is currently supported for
	// hashing; other values are accepted (read-only operations still work)
	// but changePassword/createUser refuse to write an incompatible hash.
	algorithm: string;
	argon2: FileProviderArgon2Config;
}

export interface FileProviderConfig {
	type: 'file';
	path: string; // Path to Authelia's file-provider users database YAML file
	password: FileProviderPasswordConfig; // Must match Authelia's own authentication_backend.file.password
}

// Future: Add other config types
// export interface ActiveDirectoryConfig { ... }

export type ServiceConfig = LLDAPGraphQLConfig | FileProviderConfig; // | ActiveDirectoryConfig | ...

/**
 * Create a config object directly without loading from file.
 * Useful for testing or programmatic configuration.
 */
export function createLLDAPConfig(
	endpoint: string,
	user: string,
	password: string,
	ldap_host = 'lldap',
	ldap_port = 3890,
	ldap_base_dn?: string
): LLDAPGraphQLConfig {
	return {
		type: 'lldap-graphql',
		endpoint,
		user,
		password,
		ldap_host,
		ldap_port,
		ldap_base_dn
	};
}

/**
 * Authelia's own defaults for authentication_backend.file.password.argon2.
 * See: https://www.authelia.com/configuration/first-factor/file/
 */
export const DEFAULT_FILE_PROVIDER_ARGON2_CONFIG: FileProviderArgon2Config = {
	variant: 'argon2id',
	iterations: 3,
	memory: 65536,
	parallelism: 4,
	keyLength: 32,
	saltLength: 16
};

/**
 * Create a file-provider config object directly without loading from file.
 * Useful for testing or programmatic configuration.
 */
export function createFileProviderConfig(
	path: string,
	password: FileProviderPasswordConfig = { algorithm: 'argon2', argon2: DEFAULT_FILE_PROVIDER_ARGON2_CONFIG }
): FileProviderConfig {
	return { type: 'file', path, password };
}
