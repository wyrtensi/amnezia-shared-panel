-- Traffic used to be stored from the server's side (rx = what the server got
-- from the device), while the panel labels it from the device's side. The
-- worker now swaps the node-agent counters on the way in; this flips the rows
-- already stored so history and new data agree. Every peer is AmneziaWG
-- (protocol_kind is awg2/awg3 only), so all rows are swapped. In a Postgres
-- UPDATE the right-hand side reads the old values, so the swap is safe.
UPDATE "peer_current" SET "received_bytes" = "sent_bytes", "sent_bytes" = "received_bytes";--> statement-breakpoint
UPDATE "peer_samples" SET "received_bytes" = "sent_bytes", "sent_bytes" = "received_bytes";--> statement-breakpoint
UPDATE "traffic_rollups" SET "received_bytes" = "sent_bytes", "sent_bytes" = "received_bytes";
