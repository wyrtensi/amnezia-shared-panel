"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/provider";

const STATE_META: Record<
  string,
  { labelKey: string; variant: "default" | "success" | "warning" | "destructive" | "secondary" }
> = {
  provisioning: { labelKey: "status.provisioning", variant: "warning" },
  active: { labelKey: "status.active", variant: "success" },
  disabled: { labelKey: "status.disabled", variant: "secondary" },
  revoking: { labelKey: "status.revoking", variant: "warning" },
  revoked: { labelKey: "status.revoked", variant: "destructive" },
  failed: { labelKey: "status.failed", variant: "destructive" },
};

export function StatusBadge({ value }: { value: string }) {
  const { t } = useT();
  const meta = STATE_META[value] ?? { labelKey: value, variant: "secondary" as const };
  return <Badge variant={meta.variant}>{t(meta.labelKey)}</Badge>;
}
