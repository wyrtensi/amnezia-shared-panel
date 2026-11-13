"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/provider";

/**
 * A host command with a copy button. The command wraps instead of scrolling
 * sideways so the page never grows a horizontal scrollbar on a phone.
 */
export function CommandBlock({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("bridge.copyFailed"));
    }
  };

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 text-xs">
          {command}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${t("bridge.copy")}: ${label}`}
          onClick={() => void copy()}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="hidden sm:inline">
            {copied ? t("bridge.copied") : t("bridge.copy")}
          </span>
        </Button>
      </div>
    </div>
  );
}
