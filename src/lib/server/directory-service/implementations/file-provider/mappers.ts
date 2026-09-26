import type { User, UserSummary, UserWithGroups, GroupSummary } from '../../types';
import type { FileProviderUserEntry } from './types';

export function mapGroupSummary(name: string): GroupSummary {
	return { id: name, displayName: name };
}

function mapGroups(groups: string[] | undefined): GroupSummary[] {
	return (groups ?? []).map(mapGroupSummary);
}

export function mapUserSummary(id: string, entry: FileProviderUserEntry): UserSummary {
	return {
		id,
		email: entry.email ?? '',
		displayName: entry.displayname ?? id
	};
}

export function mapUserWithGroups(id: string, entry: FileProviderUserEntry): UserWithGroups {
	return {
		...mapUserSummary(id, entry),
		groups: mapGroups(entry.groups)
	};
}

export function mapUser(id: string, entry: FileProviderUserEntry): User {
	return {
		id,
		email: entry.email ?? '',
		displayName: entry.displayname ?? id,
		uuid: id,
		creationDate: new Date(0),
		groups: mapGroups(entry.groups),
		attributes: []
	};
}
