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

export interface FileProviderConfig {
	type: 'file';
	path: string; // Path to Authelia's file-provider users database YAML file
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
 * Create a file-provider config object directly without loading from file.
 * Useful for testing or programmatic configuration.
 */
export function createFileProviderConfig(path: string): FileProviderConfig {
	return { type: 'file', path };
}
