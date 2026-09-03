import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deviceTypeSchema,
  LEGACY_DEVICE_TYPE_REPLACEMENT,
  RETIRED_STORED_DEVICE_TYPES,
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
