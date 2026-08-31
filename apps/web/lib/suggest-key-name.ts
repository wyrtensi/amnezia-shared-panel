export type DeviceType =
  | "unspecified"
  | "desktop"
  | "laptop"
  | "iphone"
  | "android"
  | "phone"
  | "tablet"
  | "other";

type Translate = (key: string) => string;

/**
 * Suggest a device name from its type, avoiding collisions with existing names
 * by appending an incrementing counter ("iPhone", "iPhone 2", ...).
 *
 * The base name is localized through the caller's translator so English mode
 * gets English defaults; generic/unspecified types fall back to a neutral
 * "Device" label instead of a UI option label like "Unspecified".
 */
export function suggestKeyName(
  deviceType: DeviceType,
  existingNames: string[],
  t: Translate,
): string {
  const base =
    deviceType === "unspecified" || deviceType === "other"
      ? t("device.base")
      : t(`device.${deviceType}`);
  const taken = new Set(
    existingNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}
