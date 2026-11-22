-- A user's own AWG 3.1 client profile and MTU per device type, the same shape
-- as an address's device rules. Null means the user has no device rules.
ALTER TABLE "users" ADD COLUMN "awg_device_rules" jsonb;
