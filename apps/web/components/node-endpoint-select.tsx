"use client";

import type { UserNodeEndpoint } from "@amnezia/contracts";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/provider";

export const AGENT_DEFAULT_ENDPOINT = "agent-default";

export function NodeEndpointSelect({
  endpoints,
  value,
  onChange,
}: {
  endpoints: readonly UserNodeEndpoint[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useT();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="key-public-endpoint">{t("wizard.endpoint")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="key-public-endpoint">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AGENT_DEFAULT_ENDPOINT}>{t("wizard.endpointDefault")}</SelectItem>
          {endpoints.map((endpoint) => (
            <SelectItem key={endpoint.id} value={endpoint.id}>
              {endpoint.name}{endpoint.publicAddress ? ` · ${endpoint.publicAddress}` : ""}
              {endpoint.reachability?.state === "blocked" ? ` · ${t("emp.serverBlocked")}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
