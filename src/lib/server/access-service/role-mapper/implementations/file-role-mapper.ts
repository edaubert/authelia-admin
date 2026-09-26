import { Role } from '../../types';
import { BaseRoleMapper } from '../base-role-mapper';
import type { RoleMapperConfig } from '../types';

/**
 * Default role mapping configuration for the Authelia file provider.
 * Only users in one of these groups will have access to the application.
 */
export const FILE_PROVIDER_DEFAULT_CONFIG: RoleMapperConfig = {
    roleGroups: {
        [Role.ADMIN]: ['admin'],
        [Role.USER_MANAGER]: ['user_manager'],
        [Role.PASSWORD_MANAGER]: ['password_manager'],
    },
    // Users in these groups are protected - only admin can modify their membership, info, or password
    protectedGroups: ['admin', 'user_manager', 'password_manager'],
};

/**
 * Role mapper for the Authelia file provider directory service
 */
export class FileProviderRoleMapper extends BaseRoleMapper {
    constructor(config?: Partial<RoleMapperConfig>) {
        const mergedRoleGroups = {
            ...FILE_PROVIDER_DEFAULT_CONFIG.roleGroups,
            ...(config?.roleGroups || {}),
        };

        const mergedProtectedGroups = config?.protectedGroups
            ? [...new Set([...FILE_PROVIDER_DEFAULT_CONFIG.protectedGroups, ...config.protectedGroups])]
            : [...FILE_PROVIDER_DEFAULT_CONFIG.protectedGroups];

        super({
            roleGroups: mergedRoleGroups,
            protectedGroups: mergedProtectedGroups,
        });
    }
}
