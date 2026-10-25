import { PERMISSIONS, type Role } from "@kyokkou/contracts";

/**
 * 角色 → 权限。前端用 permissions 决定显示什么，
 * 但真正的权限校验必须在后端路由里再查一次。
 */
export function permissionsFor(role: Role): string[] {
  if (role === "admin") return Object.values(PERMISSIONS);
  if (role === "moderator") {
    return Object.values(PERMISSIONS).filter((permission) => permission !== PERMISSIONS.staffSettings);
  }
  return [];
}

export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}
