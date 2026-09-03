import {
  HardDrive,
  Laptop,
  Monitor,
  Smartphone,
  TabletSmartphone,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { DeviceType } from "@amnezia/contracts";
import { isDeviceType } from "@/lib/device-type";

/**
 * One glyph per device type, shared by the create-key wizard and the key card
 * so the two can never disagree — they used to keep separate maps, and one of
 * them grew an icon for a "phone2" that exists nowhere. `Record<DeviceType, …>`
 * is deliberate: adding a device type to the contract without an icon is a
 * compile error here.
 *
 * lucide-react ships no vendor logos, so each glyph depicts the device the
 * option names rather than the brand: a laptop for macOS/MacBook, a monitor for
 * Windows/PC, a phone-and-tablet pair for the combined iPhone/iPad option, a
 * terminal for Linux.
 */
export const DEVICE_ICON = {
  android: Smartphone,
  ios: TabletSmartphone,
  macos: Laptop,
  windows: Monitor,
  linux: Terminal,
  other: HardDrive,
  unspecified: HardDrive,
} as const satisfies Record<DeviceType, LucideIcon>;

/**
 * Icon for a device type the API sent. Unknown values (an older key, a newer
 * API) get the neutral glyph rather than crashing an index lookup.
 */
export const deviceIconFor = (value: string): LucideIcon =>
  isDeviceType(value) ? DEVICE_ICON[value] : HardDrive;
