"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/provider";

const STATE_META: Record<
  string,
  { labelKey: string; variant: "default" | "success" | "warning" | "destructive" | "secondary" }
> = {
  provisioning: { labelKey: "status.provisioning", variant: "warning" },
  active: { labelKey: "status.active", variant: "success" },
  // Not a key state: an active key whose server the external probe finds
  // blocked (`keyBadgeState`).
  blocked: { labelKey: "status.blocked", variant: "destructive" },
  disabled: { labelKey: "status.disabled", variant: "secondary" },
  revoking: { labelKey: "status.revoking", variant: "warning" },
  revoked: { labelKey: "status.revoked", variant: "destructive" },
  failed: { labelKey: "status.failed", variant: "destructive" },
};

export function StatusBadge({ value }: { value: string }) {
  const { t } = useT();
  const meta = STATE_META[value] ?? { labelKey: value, variant: "secondary" as const };
  // Never wraps or shrinks: a cut "Акти" says nothing.
  return (
    <Badge variant={meta.variant} className="shrink-0 whitespace-nowrap">
      {t(meta.labelKey)}
    </Badge>
  );
}
