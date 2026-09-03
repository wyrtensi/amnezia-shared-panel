import { deviceTypeSchema, type DeviceType } from "@amnezia/contracts";

type Translate = (key: string) => string;

const KNOWN: ReadonlySet<string> = new Set(deviceTypeSchema.options);

/**
 * Whether a device type the API handed us is one this build knows about.
 * Key views type `deviceType` as `string` on purpose (a tab left open across a
 * deploy receives whatever the new API sends), so every lookup goes through
 * this rather than indexing a map with an unvalidated value.
 */
export const isDeviceType = (value: string): value is DeviceType =>
  KNOWN.has(value);

/**
 * Human label for a stored device type. An unknown value is shown verbatim:
 * `t()` returns the key itself for a missing message, so without this the card
 * would read "device.laptop" at a user.
 */
export const deviceTypeLabel = (t: Translate, value: string): string =>
  isDeviceType(value) ? t(`device.${value}`) : value;
