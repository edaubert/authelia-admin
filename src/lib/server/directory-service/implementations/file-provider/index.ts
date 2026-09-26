import { promises as fs, constants as fsConstants } from 'node:fs';
import { parse, YAMLParseError } from 'yaml';
import type {
	IDirectoryService,
	User,
	UserSummary,
	UserWithGroups,
	Group,
	GroupSummary,
	CreateUserInput,
	UpdateUserInput,
	CreateGroupInput,
	UpdateGroupInput,
	OperationResult,
	Schema
} from '../../types';
import type { FileProviderConfig } from '../../config';
import type { FileProviderDatabase, FileProviderUserEntry } from './types';
import { mapUser, mapUserSummary, mapUserWithGroups } from './mappers';
import { createLogger } from '../../../logger';

const log = createLogger('file-provider');

const NOT_IMPLEMENTED = 'This operation is not yet supported for the Authelia file provider';

/**
 * Directory service backed by Authelia's file authentication backend
 * (a YAML users database, e.g. users_database.yml).
 *
 * Currently read-only: only browsing users is supported. Create/update/delete
 * and group management are not yet implemented.
 */
export class FileProviderService implements IDirectoryService {
	private config: FileProviderConfig;

	constructor(config: FileProviderConfig) {
		this.config = config;
	}

	private async readDatabase(): Promise<FileProviderDatabase> {
		let content: string;
		try {
			content = await fs.readFile(this.config.path, 'utf-8');
		} catch (error) {
			throw new Error(`Cannot read file provider database "${this.config.path}": ${(error as Error).message}`);
		}

		try {
			return (parse(content) as FileProviderDatabase | null) ?? {};
		} catch (error) {
			const position =
				error instanceof YAMLParseError && error.linePos
					? ` at line ${error.linePos[0].line}, column ${error.linePos[0].col}`
					: '';
			throw new Error(`File provider database "${this.config.path}": invalid YAML${position}`);
		}
	}

	private async listEntries(): Promise<[string, FileProviderUserEntry][]> {
		const db = await this.readDatabase();
		return Object.entries(db.users ?? {});
	}

	// === User operations ===

	async listUsers(): Promise<UserSummary[]> {
		const entries = await this.listEntries();
		return entries.map(([id, entry]) => mapUserSummary(id, entry));
	}

	async listUsersWithGroups(): Promise<UserWithGroups[]> {
		const entries = await this.listEntries();
		return entries.map(([id, entry]) => mapUserWithGroups(id, entry));
	}

	async getUserDetails(userId: string): Promise<User | null> {
		const db = await this.readDatabase();
		const entry = db.users?.[userId];
		return entry ? mapUser(userId, entry) : null;
	}

	async getUserByEmail(email: string): Promise<User | null> {
		const entries = await this.listEntries();
		const normalizedEmail = email.toLowerCase();
		const match = entries.find(([, entry]) => (entry.email ?? '').toLowerCase() === normalizedEmail);
		return match ? mapUser(match[0], match[1]) : null;
	}

	async createUser(_input: CreateUserInput): Promise<User> {
		throw new Error(NOT_IMPLEMENTED);
	}

	async updateUser(_input: UpdateUserInput): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async deleteUser(_userId: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async changePassword(_userId: string, _newPassword: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	// === Group operations ===
	// The file provider has no first-class group objects: groups are just
	// names referenced in each user's `groups` list. Not yet implemented.

	async createGroup(_input: CreateGroupInput): Promise<Group> {
		throw new Error(NOT_IMPLEMENTED);
	}

	async updateGroup(_input: UpdateGroupInput): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async deleteGroup(_groupId: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async listGroups(): Promise<GroupSummary[]> {
		return [];
	}

	async getGroupDetails(_groupId: string): Promise<Group | null> {
		return null;
	}

	// === Membership operations ===

	async addUserToGroup(_userId: string, _groupId: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async removeUserFromGroup(_userId: string, _groupId: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	// === Schema operations ===
	// File provider users have a fixed field set; no custom attribute schema.

	async getUserAttributesSchema(): Promise<Schema> {
		return { attributes: [] };
	}

	async getGroupAttributesSchema(): Promise<Schema> {
		return { attributes: [] };
	}

	// === Connection test ===

	async testConnection(): Promise<OperationResult> {
		try {
			await fs.access(this.config.path, fsConstants.R_OK);
			return { success: true };
		} catch (error) {
			log.warn(`File provider connection test failed: ${(error as Error).message}`);
			return { success: false, error: (error as Error).message };
		}
	}
}
