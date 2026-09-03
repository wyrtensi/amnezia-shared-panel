import type { DeviceType } from "@amnezia/contracts";

type Translate = (key: string) => string;

/**
 * Suggest a device name from its type, avoiding collisions with existing names
 * by appending an incrementing counter ("iPhone", "iPhone 2", ...).
 *
 * The base comes from the `device.name.*` namespace rather than the card labels
 * in `device.*`: a card reads "iPhone / iPad", which is a poor key name. It is
 * localized through the caller's translator so English mode gets English
 * defaults; the generic types fall back to a neutral "Device" instead of a UI
 * option label like "Unspecified".
 */
export function suggestKeyName(
  deviceType: DeviceType,
  existingNames: string[],
  t: Translate,
): string {
  const base =
    deviceType === "unspecified" || deviceType === "other"
      ? t("device.base")
      : t(`device.name.${deviceType}`);
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
