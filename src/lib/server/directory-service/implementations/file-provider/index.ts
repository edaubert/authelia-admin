import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
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

/** Thrown internally when the file changed on disk since it was read; never escapes the service. */
class ConflictError extends Error {}

/** A mutation's outcome: the value to return, and whether anything actually needs writing. */
interface MutationOutcome<T> {
	result: T;
	write: boolean;
}

function sameEntry(a: FileProviderUserEntry | undefined, b: FileProviderUserEntry | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Directory service backed by Authelia's file authentication backend
 * (a YAML users database, e.g. users_database.yml).
 *
 * Supports browsing, creating, editing, and deleting users; changing
 * passwords (argon2id only - see hashPassword); changing group membership;
 * and renaming/deleting a group (as a bulk update across its members).
 * Creating a group with no members has no meaningful effect here (nothing to
 * persist) - see createGroup.
 *
 * Writes are guarded against concurrent modification from outside this
 * service instance (another process, or Authelia's own password-reset flow
 * writing to the same file): see transact().
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

	private parseDatabase(content: string): FileProviderDatabase {
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

	private async readDatabase(): Promise<FileProviderDatabase> {
		return (await this.readDatabaseWithMtime()).db;
	}

	/** Reads the database along with the file's mtime, used to detect concurrent external writes. */
	private async readDatabaseWithMtime(): Promise<{ db: FileProviderDatabase; mtimeMs: number }> {
		let content: string;
		let mtimeMs: number;
		try {
			content = await fs.readFile(this.config.path, 'utf-8');
			mtimeMs = (await fs.stat(this.config.path)).mtimeMs;
		} catch (error) {
			throw new Error(`Cannot read file provider database "${this.config.path}": ${(error as Error).message}`);
		}

		return { db: this.parseDatabase(content), mtimeMs };
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
	 * Write the database only if the file's mtime still matches what it was
	 * when read (i.e. nothing else wrote to it in the meantime). Throws
	 * ConflictError otherwise - the file changed under us, e.g. from another
	 * process running this service, or Authelia's own password-reset flow.
	 * This narrows the race window but doesn't eliminate it (there's a small
	 * gap between the stat check and the rename); it's an optimistic guard
	 * against a rare admin-edit conflict, not a distributed lock.
	 */
	private async writeDatabaseIfUnchanged(db: FileProviderDatabase, expectedMtimeMs: number): Promise<void> {
		const currentMtimeMs = await fs.stat(this.config.path).then(
			(stat) => stat.mtimeMs,
			() => undefined
		);
		if (currentMtimeMs !== expectedMtimeMs) {
			throw new ConflictError('File provider database changed on disk since it was read');
		}
		await this.writeDatabase(db);
	}

	/**
	 * Serialize an operation against any other pending one from this service
	 * instance, so concurrent edits issued by this process don't interleave.
	 * This alone doesn't protect against a different process (or Authelia
	 * itself) writing to the file at the same time - see transact() for that.
	 */
	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.writeQueue.then(operation, operation);
		this.writeQueue = result.catch(() => undefined);
		return result;
	}

	/**
	 * Read-modify-write with optimistic concurrency control: if the file
	 * changed on disk between the read and the write (some other process, or
	 * Authelia's own password-reset flow, wrote to it concurrently), check
	 * whether that external change actually touched the user(s) this
	 * operation cares about (`getTouchedUserIds`, re-evaluated fresh each
	 * attempt so it stays correct even as the file changes):
	 *  - if none of them were affected, the conflict is unrelated - retry the
	 *    whole read-modify-write against the new file state;
	 *  - if one of them was affected, this operation and the external change
	 *    both touched the same user, so retrying could silently discard
	 *    someone else's edit - fail instead of guessing which should win.
	 */
	private async transact<T>(
		getTouchedUserIds: (db: FileProviderDatabase) => string[],
		mutate: (db: FileProviderDatabase) => MutationOutcome<T>,
		maxAttempts = 5
	): Promise<T> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const { db, mtimeMs } = await this.readDatabaseWithMtime();
			const touchedIds = getTouchedUserIds(db);
			// Cloned, not just referenced: mutate() below may edit these same
			// entry objects in place, and this snapshot must reflect their
			// state as read, not after that in-place mutation.
			const before = touchedIds.map((id) => structuredClone(db.users?.[id]));

			const { result, write } = mutate(db);
			if (!write) {
				return result;
			}

			try {
				await this.writeDatabaseIfUnchanged(db, mtimeMs);
				return result;
			} catch (error) {
				if (!(error instanceof ConflictError)) {
					throw error;
				}

				const latest = await this.readDatabase();
				const after = touchedIds.map((id) => latest.users?.[id]);
				const conflictsWithOurUsers = before.some((entry, i) => !sameEntry(entry, after[i]));

				if (conflictsWithOurUsers) {
					throw new Error(
						`Concurrent modification detected: user(s) ${touchedIds.join(', ')} ` +
						`were changed by another process while this change was being saved`
					);
				}
				if (attempt === maxAttempts) {
					throw new Error(
						'Concurrent modification detected: too many conflicting writes, please try again'
					);
				}
				log.warn(
					`File provider database changed concurrently (unrelated to user(s) ${touchedIds.join(', ')}); retrying (attempt ${attempt}/${maxAttempts})`
				);
				// Unrelated external change - loop and retry against the new state.
			}
		}
		// Unreachable: the loop always returns or throws.
		throw new Error('Concurrent modification detected: too many conflicting writes, please try again');
	}

	/**
	 * Like transact(), but for operations that return an OperationResult: a
	 * genuine, unretryable conflict (see transact()) is reported the same way
	 * as any other domain failure (e.g. "user not found") rather than
	 * rejecting the promise.
	 */
	private async transactResult(
		getTouchedUserIds: (db: FileProviderDatabase) => string[],
		mutate: (db: FileProviderDatabase) => MutationOutcome<OperationResult>
	): Promise<OperationResult> {
		return this.runExclusive(async () => {
			try {
				return await this.transact<OperationResult>(getTouchedUserIds, mutate);
			} catch (error) {
				return { success: false, error: (error as Error).message };
			}
		});
	}

	private async listEntries(): Promise<[string, FileProviderUserEntry][]> {
		const db = await this.readDatabase();
		return Object.entries(db.users ?? {});
	}

	/**
	 * Hash a password the way Authelia's file provider expects, using the
	 * algorithm/parameters read from Authelia's own configuration.yml so the
	 * result verifies correctly. Only argon2id is currently supported; other
	 * configured algorithms are refused rather than risking an incompatible
	 * hash (Authelia fails to load the whole file if it can't parse one).
	 */
	private async hashPassword(plainPassword: string): Promise<string> {
		const { algorithm, argon2: cfg } = this.config.password;
		if (algorithm !== 'argon2' || cfg.variant !== 'argon2id') {
			throw new Error(
				`Password hashing is only supported for algorithm "argon2" with variant "argon2id" ` +
				`(Authelia is configured with algorithm "${algorithm}", variant "${cfg.variant}")`
			);
		}

		return argon2.hash(plainPassword, {
			type: argon2.argon2id,
			memoryCost: cfg.memory,
			timeCost: cfg.iterations,
			parallelism: cfg.parallelism,
			hashLength: cfg.keyLength,
			salt: randomBytes(cfg.saltLength)
		});
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

	async createUser(input: CreateUserInput): Promise<User> {
		// CreateUserInput carries no password. The "New User" flow always
		// calls changePassword immediately afterwards (with automatic
		// rollback via deleteUser if that fails), so give the new entry a
		// random, unguessable placeholder hash rather than ever writing an
		// empty/invalid password field - even momentarily.
		const placeholderHash = await this.hashPassword(randomBytes(32).toString('hex'));

		return this.runExclusive(() =>
			this.transact<User>(
				() => [input.id],
				(db) => {
					db.users = db.users ?? {};
					if (db.users[input.id]) {
						throw new Error(`User "${input.id}" already exists`);
					}

					const entry: FileProviderUserEntry = {
						disabled: false,
						displayname: input.displayName ?? input.id,
						password: placeholderHash,
						email: input.email,
						groups: []
					};
					db.users[input.id] = entry;
					return { result: mapUser(input.id, entry), write: true };
				}
			)
		);
	}

	async updateUser(input: UpdateUserInput): Promise<OperationResult> {
		return this.transactResult(
			() => [input.id],
			(db) => {
				const entry = db.users?.[input.id];
				if (!entry) {
					return { result: { success: false, error: `User "${input.id}" not found` }, write: false };
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

				return { result: { success: true }, write: true };
			}
		);
	}

	async deleteUser(userId: string): Promise<OperationResult> {
		return this.transactResult(
			() => [userId],
			(db) => {
				if (!db.users?.[userId]) {
					return { result: { success: false, error: `User "${userId}" not found` }, write: false };
				}

				delete db.users[userId];
				return { result: { success: true }, write: true };
			}
		);
	}

	async changePassword(userId: string, newPassword: string): Promise<OperationResult> {
		let hash: string;
		try {
			hash = await this.hashPassword(newPassword);
		} catch (error) {
			return { success: false, error: (error as Error).message };
		}

		return this.transactResult(
			() => [userId],
			(db) => {
				const entry = db.users?.[userId];
				if (!entry) {
					return { result: { success: false, error: `User "${userId}" not found` }, write: false };
				}

				entry.password = hash;
				return { result: { success: true }, write: true };
			}
		);
	}

	// === Group operations ===
	// The file provider has no first-class group objects: a group is just a
	// name referenced in one or more users' `groups` list, with no independent
	// id, attributes, or creation date. There is nowhere to persist a group
	// that has no members, so createGroup (which starts a group with zero
	// members) has no meaningful effect here - add the first member with
	// addUserToGroup instead, which implicitly "creates" the group name.
	// updateGroup and deleteGroup, however, are well-defined as bulk
	// rename/removal of that name across every user who has it.

	async createGroup(_input: CreateGroupInput): Promise<Group> {
		throw new Error(
			`${NOT_IMPLEMENTED} (a group with no members can't be represented; use addUserToGroup instead)`
		);
	}

	async updateGroup(input: UpdateGroupInput): Promise<OperationResult> {
		const newName = input.displayName;
		if (!newName || newName === input.id) {
			return { success: true };
		}

		return this.transactResult(
			(db) => membersOf(db, input.id),
			(db) => {
				const entries = Object.entries(db.users ?? {});
				let changed = false;

				for (const [, entry] of entries) {
					if (entry.groups?.includes(input.id)) {
						entry.groups = [...new Set(entry.groups.map((g) => (g === input.id ? newName : g)))];
						changed = true;
					}
				}

				if (!changed) {
					return { result: { success: false, error: `Group "${input.id}" not found` }, write: false };
				}
				return { result: { success: true }, write: true };
			}
		);
	}

	async deleteGroup(groupId: string): Promise<OperationResult> {
		return this.transactResult(
			(db) => membersOf(db, groupId),
			(db) => {
				const entries = Object.entries(db.users ?? {});
				let changed = false;

				for (const [, entry] of entries) {
					if (entry.groups?.includes(groupId)) {
						entry.groups = entry.groups.filter((g) => g !== groupId);
						changed = true;
					}
				}

				if (!changed) {
					return { result: { success: false, error: `Group "${groupId}" not found` }, write: false };
				}
				return { result: { success: true }, write: true };
			}
		);
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
		return this.transactResult(
			() => [userId],
			(db) => {
				const entry = db.users?.[userId];
				if (!entry) {
					return { result: { success: false, error: `User "${userId}" not found` }, write: false };
				}

				entry.groups = entry.groups ?? [];
				if (entry.groups.includes(groupId)) {
					return { result: { success: true }, write: false };
				}
				entry.groups.push(groupId);
				return { result: { success: true }, write: true };
			}
		);
	}

	async removeUserFromGroup(userId: string, groupId: string): Promise<OperationResult> {
		return this.transactResult(
			() => [userId],
			(db) => {
				const entry = db.users?.[userId];
				if (!entry) {
					return { result: { success: false, error: `User "${userId}" not found` }, write: false };
				}

				if (!entry.groups?.includes(groupId)) {
					return { result: { success: true }, write: false };
				}
				entry.groups = entry.groups.filter((g) => g !== groupId);
				return { result: { success: true }, write: true };
			}
		);
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

	// === Capabilities ===

	groupsArePersistent(): boolean {
		// A file-provider group is just a name referenced by its members; it
		// has no existence once it has none, and deleting it means removing
		// it from every member.
		return false;
	}
}

function membersOf(db: FileProviderDatabase, groupId: string): string[] {
	return Object.entries(db.users ?? {})
		.filter(([, entry]) => entry.groups?.includes(groupId))
		.map(([id]) => id);
}
