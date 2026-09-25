import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify, YAMLParseError } from 'yaml';
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
import { mapGroupSummary, mapUser, mapUserSummary, mapUserWithGroups } from './mappers';
import { createLogger } from '../../../logger';

const log = createLogger('file-provider');

const NOT_IMPLEMENTED = 'This operation is not yet supported for the Authelia file provider';

/**
 * Directory service backed by Authelia's file authentication backend
 * (a YAML users database, e.g. users_database.yml).
 *
 * Browsing users and groups, editing a user's email/display name/disabled
 * flag, and changing group membership are supported. Creating/deleting users,
 * creating/updating/deleting groups, and changing passwords are not yet
 * implemented.
 */
export class FileProviderService implements IDirectoryService {
	private config: FileProviderConfig;
	// Serializes read-modify-write operations within this process; the file has
	// no transaction support, so concurrent membership edits from this service
	// must not interleave and clobber each other's changes.
	private writeQueue: Promise<unknown> = Promise.resolve();

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

	/**
	 * Atomically write the database: write to a temp file in the same
	 * directory, then rename over the target. Avoids Authelia's file watcher
	 * (or another reader) ever observing a partially-written file.
	 */
	private async writeDatabase(db: FileProviderDatabase): Promise<void> {
		const dir = path.dirname(this.config.path);
		const tempPath = path.join(dir, `.${path.basename(this.config.path)}.${randomUUID()}.tmp`);
		const content = stringify(db);
		try {
			await fs.writeFile(tempPath, content, 'utf-8');
			await fs.rename(tempPath, this.config.path);
		} catch (error) {
			await fs.rm(tempPath, { force: true });
			throw new Error(`Cannot write file provider database "${this.config.path}": ${(error as Error).message}`);
		}
	}

	/**
	 * Serialize a read-modify-write operation against any other pending one
	 * from this service instance, so concurrent edits don't interleave.
	 */
	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.writeQueue.then(operation, operation);
		this.writeQueue = result.catch(() => undefined);
		return result;
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

	async updateUser(input: UpdateUserInput): Promise<OperationResult> {
		return this.runExclusive(async () => {
			const db = await this.readDatabase();
			const entry = db.users?.[input.id];
			if (!entry) {
				return { success: false, error: `User "${input.id}" not found` };
			}

			// Custom attributes (insertAttributes/removeAttributes) are not
			// supported by the file provider, which has a fixed field set;
			// they are silently ignored here, matching the empty attribute
			// schema returned by getUserAttributesSchema().
			if (input.email !== undefined) {
				entry.email = input.email;
			}
			if (input.displayName !== undefined) {
				entry.displayname = input.displayName;
			}
			if (input.disabled !== undefined) {
				entry.disabled = input.disabled;
			}

			await this.writeDatabase(db);
			return { success: true };
		});
	}

	async deleteUser(_userId: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	async changePassword(_userId: string, _newPassword: string): Promise<OperationResult> {
		return { success: false, error: NOT_IMPLEMENTED };
	}

	// === Group operations ===
	// The file provider has no first-class group objects: a group is just a
	// name referenced in one or more users' `groups` list. Groups are derived
	// from that union, so they have no independent id, attributes, or creation
	// date. Creating/renaming/deleting a group as such is not yet implemented;
	// see addUserToGroup/removeUserFromGroup below for membership changes.

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
		const entries = await this.listEntries();
		const names = new Set<string>();
		for (const [, entry] of entries) {
			for (const group of entry.groups ?? []) {
				names.add(group);
			}
		}
		return [...names].sort((a, b) => a.localeCompare(b)).map(mapGroupSummary);
	}

	async getGroupDetails(groupId: string): Promise<Group | null> {
		const entries = await this.listEntries();
		const members = entries.filter(([, entry]) => (entry.groups ?? []).includes(groupId));
		if (members.length === 0) {
			return null;
		}

		return {
			id: groupId,
			displayName: groupId,
			creationDate: new Date(0),
			members: members.map(([id, entry]) => mapUserSummary(id, entry)),
			attributes: []
		};
	}

	// === Membership operations ===

	async addUserToGroup(userId: string, groupId: string): Promise<OperationResult> {
		return this.runExclusive(async () => {
			const db = await this.readDatabase();
			const entry = db.users?.[userId];
			if (!entry) {
				return { success: false, error: `User "${userId}" not found` };
			}

			entry.groups = entry.groups ?? [];
			if (!entry.groups.includes(groupId)) {
				entry.groups.push(groupId);
				await this.writeDatabase(db);
			}
			return { success: true };
		});
	}

	async removeUserFromGroup(userId: string, groupId: string): Promise<OperationResult> {
		return this.runExclusive(async () => {
			const db = await this.readDatabase();
			const entry = db.users?.[userId];
			if (!entry) {
				return { success: false, error: `User "${userId}" not found` };
			}

			if (entry.groups?.includes(groupId)) {
				entry.groups = entry.groups.filter((g) => g !== groupId);
				await this.writeDatabase(db);
			}
			return { success: true };
		});
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
