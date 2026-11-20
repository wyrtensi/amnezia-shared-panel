-- The first address of a node was named "<node name>-1" when nothing else was
-- given, and users saw that suffix on every server and key. It is now named
-- like the node. Only names that are still that default are changed: a name
-- an admin set, or one taken from the node's public name, stays.
UPDATE "node_vpn_endpoints" AS "e"
SET "name" = left("n"."name", 120)
FROM "nodes" AS "n"
WHERE "e"."node_id" = "n"."id"
  AND "e"."ordinal" = 1
  AND "e"."name" = left("n"."name", 118) || '-1';
