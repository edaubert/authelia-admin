// Shape of Authelia's file-provider users database YAML (e.g. users_database.yml)

export interface FileProviderUserEntry {
	disabled?: boolean;
	displayname?: string;
	password?: string;
	email?: string;
	groups?: string[];
}

export interface FileProviderDatabase {
	users?: Record<string, FileProviderUserEntry>;
}
