"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Hint } from "@/components/ui/hint";
import { ProtocolSelect } from "@/components/protocol-select";
import { NodeSelect } from "@/components/node-select";
import {
  useAdminData,
  type GlobalPortalPolicy,
} from "@/components/admin/admin-data";
import { useT } from "@/lib/i18n/provider";

const PERMISSIONS: Array<[keyof GlobalPortalPolicy, string]> = [
  ["allowKeyCreation", "gpolicy.allowKeyCreation"],
  ["allowNodeSelection", "gpolicy.allowNodeSelection"],
  ["allowRouteProfileSelection", "gpolicy.allowRouteProfileSelection"],
  ["allowCustomRoutes", "gpolicy.allowCustomRoutes"],
  ["allowConfigRedownload", "gpolicy.allowConfigRedownload"],
  ["allowQrDownload", "gpolicy.allowQrDownload"],
  ["allowConfDownload", "gpolicy.allowConfDownload"],
  ["allowSelfRevoke", "gpolicy.allowSelfRevoke"],
];

const TELEMETRY: Array<[keyof GlobalPortalPolicy, string]> = [
  ["showPublicKey", "gpolicy.showPublicKey"],
  ["showLastUsed", "gpolicy.showLastUsed"],
  ["showTraffic", "gpolicy.showTraffic"],
];

export default function AdminPolicyPage() {
  const { policy, nodes, action } = useAdminData();
  const { t } = useT();
  const [form, setForm] = React.useState<GlobalPortalPolicy>(policy);
  const [cfToken, setCfToken] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => setForm(policy), [policy]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const payload: Record<string, unknown> = { ...form };
    delete payload.cfApiTokenSet;
    if (cfToken.trim()) payload.cfApiToken = cfToken.trim();
    const ok = await action("portal-policy", "global", "update", payload);
    if (ok) setCfToken("");
    setBusy(false);
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <Card>
        <CardHeader>
          <CardTitle>{t("policy.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="default-limit" className="flex items-center gap-1.5">
                {form.keyLimitMode === "global"
                  ? t("policy.keyLimitGlobal")
                  : t("policy.keyLimit")}
                <Hint>
                  {form.keyLimitMode === "global"
                    ? t("policy.keyLimitGlobalHint")
                    : t("policy.keyLimitHint")}
                </Hint>
              </Label>
              <Input
                id="default-limit"
                type="number"
                min={0}
                max={1000}
                required
                value={form.defaultKeyLimit}
                onChange={(event) =>
                  setForm({
                    ...form,
                    defaultKeyLimit: event.target.valueAsNumber || 0,
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="retention" className="flex items-center gap-1.5">
                {t("policy.retention")}
                <Hint>{t("policy.retentionHint")}</Hint>
              </Label>
              <Input
                id="retention"
                type="number"
                min={1}
                max={36500}
                value={form.dailyRetentionDays ?? 730}
                onChange={(event) =>
                  setForm({
                    ...form,
                    dailyRetentionDays: event.target.valueAsNumber || null,
                  })
                }
              />
            </div>
          </div>

          {/* Directly under the number it reinterprets: the same value means
              "per server" or "in total" depending on this switch. */}
          <PolicyToggle
            label={t("gpolicy.keyLimitMode")}
            hint={t("gpolicy.keyLimitModeHint")}
            checked={form.keyLimitMode === "global"}
            onChange={(checked) =>
              setForm({ ...form, keyLimitMode: checked ? "global" : "per_node" })
            }
          />

          <Separator />

          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              {t("policy.defaultProtocols")}
              <Hint>{t("policy.defaultProtocolsHint")}</Hint>
            </h3>
            <ProtocolSelect
              value={form.allowedProtocols ?? ["awg3"]}
              onChange={(next) => setForm({ ...form, allowedProtocols: next })}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              {t("policy.availableNodes")}
              <Hint>{t("policy.availableNodesHint")}</Hint>
            </h3>
            <NodeSelect
              nodes={nodes}
              value={form.allowedNodeIds ?? null}
              onChange={(next) => setForm({ ...form, allowedNodeIds: next })}
            />
          </div>

          <Separator />

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t("policy.employeePerms")}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {PERMISSIONS.map(([key, label]) => (
                <PolicyToggle
                  key={key}
                  label={t(label)}
                  hint={t(`${label}Hint`)}
                  checked={form[key] as boolean}
                  onChange={(checked) => setForm({ ...form, [key]: checked })}
                />
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t("policy.telemetryDisplay")}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {TELEMETRY.map(([key, label]) => (
                <PolicyToggle
                  key={key}
                  label={t(label)}
                  hint={t(`${label}Hint`)}
                  checked={form[key] as boolean}
                  onChange={(checked) => setForm({ ...form, [key]: checked })}
                />
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              Cloudflare Access
              <Hint>{t("policy.cfAccessHint")}</Hint>
            </h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="cf-account" className="flex items-center gap-1.5">
                  Account ID
                  <Hint>{t("policy.cfAccountIdHint")}</Hint>
                </Label>
                <Input
                  id="cf-account"
                  value={form.cfAccessAccountId ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, cfAccessAccountId: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cf-app" className="flex items-center gap-1.5">
                  Application ID
                  <Hint>{t("policy.cfAppIdHint")}</Hint>
                </Label>
                <Input
                  id="cf-app"
                  value={form.cfAccessAppId ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, cfAccessAppId: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cf-policy" className="flex items-center gap-1.5">
                  Policy ID
                  <Hint>{t("policy.cfPolicyIdHint")}</Hint>
                </Label>
                <Input
                  id="cf-policy"
                  value={form.cfAccessPolicyId ?? ""}
                  onChange={(event) =>
                    setForm({ ...form, cfAccessPolicyId: event.target.value })
                  }
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cf-token" className="flex items-center gap-1.5">
                {t("policy.cfToken")}
                <Hint>{t("policy.cfTokenHint")}</Hint>
              </Label>
              <Input
                id="cf-token"
                type="password"
                autoComplete="new-password"
                placeholder={
                  form.cfApiTokenSet
                    ? t("policy.cfTokenSet")
                    : t("policy.cfTokenPlaceholder")
                }
                value={cfToken}
                onChange={(event) => setCfToken(event.target.value)}
              />
            </div>
          </div>

          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("policy.saveGlobal")}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}

function PolicyToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  // A div (not a label) so tapping the (i) hint opens the tooltip instead of
  // toggling the switch.
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm">
      <span className="flex items-center gap-1.5">
        {label}
        {hint ? <Hint>{hint}</Hint> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
