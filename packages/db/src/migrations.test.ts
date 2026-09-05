import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deviceTypeSchema,
  LEGACY_DEVICE_TYPE_REPLACEMENT,
  RETIRED_STORED_DEVICE_TYPES,
  WORKER_PERIOD_FIELDS,
  WORKER_PERIOD_FIELD_NAMES,
  type WorkerPeriodField,
} from "@amnezia/contracts";

// The device-type mapping exists twice: as a tested TypeScript table in
// @amnezia/contracts, and as SQL that actually runs. This test is the only
// thing holding the two together, so it reads the SQL as text on purpose.
const migration = readFileSync(
  fileURLToPath(
    new URL("../migrations/0012_device_type_platforms.sql", import.meta.url),
  ),
  "utf8",
);

describe("0012_device_type_platforms", () => {
  it("creates the enum the contract declares, in the same order", () => {
    const values = deviceTypeSchema.options
      .map((value) => `'${value}'`)
      .join(", ");
    expect(migration).toContain(
      `CREATE TYPE "public"."device_type" AS ENUM(${values})`,
    );
  });

  it("remaps every storable legacy value the way the contract says", () => {
    for (const legacy of RETIRED_STORED_DEVICE_TYPES) {
      expect(migration, legacy).toContain(
        `WHEN '${legacy}' THEN '${LEGACY_DEVICE_TYPE_REPLACEMENT[legacy]}'`,
      );
    }
  });

  it("never mentions a value the column could not hold", () => {
    expect(migration).not.toContain("'tablet'");
  });

  it("preserves the wording of rows that had no device label", () => {
    expect(migration).toContain('UPDATE "vpn_keys"');
    expect(migration).toContain('initcap("device_type"::text)');
    expect(migration).toContain(`IN ('desktop', 'laptop', 'phone')`);
  });

  it("takes the default off the column and puts it back", () => {
    expect(migration).toContain('"device_type" DROP DEFAULT');
    expect(migration).toContain(`"device_type" SET DEFAULT 'unspecified'`);
  });
});

describe("0013_install_guide_videos", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../migrations/0013_install_guide_videos.sql", import.meta.url)),
    "utf8",
  );

  it("adds the column without a default, so existing panels keep no videos", () => {
    expect(sql).toContain('ALTER TABLE "portal_policy"');
    expect(sql).toContain('ADD COLUMN "install_guide_videos" jsonb');
    // A NOT NULL or a default would rewrite every row for a value the guide
    // treats as absent anyway.
    expect(sql).not.toMatch(/NOT NULL|DEFAULT/i);
  });
});

describe("migration journal", () => {
  const journal = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)),
      "utf8",
    ),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };

  it("ends with the newest `when` of any entry", () => {
    // Drizzle applies a migration whose `when` is greater than the last one it
    // applied - NOT the one with the next `idx`. This journal is already out of
    // order once (0027 predates 0026), so a new migration generated on a clock
    // behind an existing entry would be silently skipped in production. The
    // last entry having the maximum `when` is what makes that impossible.
    const whens = journal.entries.map((entry) => entry.when);
    const last = journal.entries.at(-1);
    expect(last?.when).toBe(Math.max(...whens));
    // And it must be the only entry with that value, or "greater than the last
    // applied" would skip a tie.
    expect(whens.filter((when) => when === last?.when)).toHaveLength(1);
  });
});

describe("0029_worker_polling_periods", () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL("../migrations/0029_worker_polling_periods.sql", import.meta.url),
    ),
    "utf8",
  );

  /** The column each period is stored in, in the contract's own order. */
  const columns: Record<string, string> = {
    telemetryPollSec: "telemetry_poll_sec",
    nodeMetricsSampleSec: "node_metrics_sample_sec",
    nodeMetricsRetentionDays: "node_metrics_retention_days",
    peerSampleSec: "peer_sample_sec",
    maintenanceIntervalSec: "maintenance_interval_sec",
    agentReleaseRefreshSec: "agent_release_refresh_sec",
    ruleFetchIntervalSec: "rule_fetch_interval_sec",
    accessReconcileSec: "access_reconcile_sec",
  };

  it("has a column for every period the contract names", () => {
    expect(Object.keys(columns)).toEqual(WORKER_PERIOD_FIELD_NAMES);
  });

  it("adds every column nullable and without a default", () => {
    // This is the whole upgrade story: a null column means "use the worker's
    // default", so an existing panel keeps exactly the periods it had. A
    // default here would silently re-time every deployment on upgrade.
    for (const column of Object.values(columns)) {
      expect(sql, column).toContain(
        `ALTER TABLE "portal_policy" ADD COLUMN "${column}" integer;`,
      );
    }
    expect(sql).not.toMatch(/ADD COLUMN[^;]*(NOT NULL|DEFAULT)/i);
  });

  it("guards each column with the range the contract validates", () => {
    // The table is the last line of defence for a value that never came
    // through the API. It has to agree with the bounds the API enforces, or
    // one of them is wrong and nobody finds out until a write is refused.
    for (const [field, column] of Object.entries(columns)) {
      const { min, max } = WORKER_PERIOD_FIELDS[field as WorkerPeriodField];
      expect(sql, column).toContain(
        `CHECK ("portal_policy"."${column}" IS NULL OR ("portal_policy"."${column}" >= ${min} AND "portal_policy"."${column}" <= ${max}))`,
      );
    }
  });
});
