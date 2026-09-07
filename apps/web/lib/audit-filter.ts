import {
  AUDIT_CATEGORIES,
  auditCategoryOf,
  auditScopeOf,
  type AuditCategory,
} from "@amnezia/contracts";

export { AUDIT_CATEGORIES, auditCategoryOf, auditScopeOf };
export type { AuditCategory };

/** Who did it: a person acting in the panel, or the panel acting on its own. */
export type AuditScope = "all" | "people" | "system";

export type AuditFilter = {
  scope: AuditScope;
  /** Null means every category. */
  category: AuditCategory | null;
  /** Free text, already lowercased by the caller or not — trimmed here. */
  query: string;
};

/**
 * Whether one row survives the current facets.
 *
 * Every facet is an AND: they answer different questions ("who", "about what",
 * "matching which words"), so a row has to satisfy all of the ones that are
 * set. `haystack` is assembled by the caller because only it knows how a row
 * renders — the actor's email is resolved against the user list, and the action
 * is translated before it is searchable.
 */
export const auditRowMatches = (
  row: { actorType: string; targetType: string; haystack: string },
  filter: AuditFilter,
): boolean => {
  if (filter.scope !== "all" && auditScopeOf(row.actorType) !== filter.scope) {
    return false;
  }
  if (filter.category && auditCategoryOf(row.targetType) !== filter.category) {
    return false;
  }
  const needle = filter.query.trim().toLowerCase();
  if (!needle) return true;
  return row.haystack.toLowerCase().includes(needle);
};
